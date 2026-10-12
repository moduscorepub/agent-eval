/**
 * Mine commits that change source and tests together into validated tasks (tasks/<id>.json).
 * A commit becomes a task only if its tests FAIL on the parent and PASS with the reference change,
 * so "hidden tests pass" means the agent actually solved it.
 *
 *   bun harvest.ts [--repos open-seo,forgestream] [--per-repo 10] [--scan 40] [--model anthropic/claude-sonnet-5-5]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type RepoConfig,
	type Task,
	ROOT,
	applyRef,
	arg,
	baseDir,
	cloneBase,
	ensureBase,
	expandHome,
	fileKind,
	isCode,
	mustSh,
	readJson,
	runAgent,
	sh,
	testCommand,
	writeJson,
} from "./lib";

const perRepo = Number(arg("per-repo", "10"));
const scan = Number(arg("scan", "40"));
const model = arg("model", "anthropic/claude-sonnet-5-5")!;
const allRepos = readJson<Record<string, RepoConfig>>(path.join(ROOT, "repos.json"));
const repoNames = arg("repos")?.split(",") ?? Object.keys(allRepos);
const TEST_TIMEOUT = 10 * 60_000;

interface Candidate {
	sha: string;
	testFiles: string[];
	runnableTests: string[];
	nonTestFiles: string[];
	ref: Task["ref"];
}

/** Commit qualifies when it edits source + tests, no renames/deletions of tests, no dependency changes. */
async function inspect(repoPath: string, sha: string): Promise<Candidate | undefined> {
	const status = (await mustSh(`git show --name-status --format= ${sha}`, { cwd: repoPath })).trim().split("\n");
	const numstat = (await mustSh(`git show --numstat --format= ${sha}`, { cwd: repoPath })).trim().split("\n");
	const testFiles: string[] = [];
	const runnableTests: string[] = [];
	const nonTestFiles: string[] = [];
	for (const line of status) {
		const [code, file] = line.split("\t");
		if (!code || !file || /^[RC]/.test(code)) return undefined;
		const kind = fileKind(file);
		if (kind === "dep") return undefined;
		if (kind === "test") {
			if (code === "D") return undefined;
			testFiles.push(file);
			if (isCode(file)) runnableTests.push(file);
		} else nonTestFiles.push(file);
	}
	let srcAdded = 0;
	let srcRemoved = 0;
	for (const line of numstat) {
		const [added, removed, file] = line.split("\t");
		if (file && fileKind(file) === "src") {
			srcAdded += Number(added) || 0;
			srcRemoved += Number(removed) || 0;
		}
	}
	const srcLines = srcAdded + srcRemoved;
	if (runnableTests.length === 0 || srcLines < 3 || srcLines > 250 || status.length > 10) return undefined;
	if (!nonTestFiles.some(file => fileKind(file) === "src")) return undefined;
	return { sha, testFiles, runnableTests, nonTestFiles, ref: { srcAdded, srcRemoved, files: nonTestFiles.length } };
}

const STATEMENT_PROMPT = (commit: string) => `You are writing the GitHub issue a maintainer would have filed to request the change in the commit below.

Rules:
- Describe the observable problem or desired behavior from the user's/maintainer's point of view: expected vs. actual behavior, inputs and outputs, edge cases that matter.
- If the tests call a function, class, method, CLI flag, endpoint, or config key that does not exist yet or whose signature changes, name it exactly with its signature. That is interface, not implementation.
- Do NOT describe the implementation approach, internal structure, helper functions to create, or which files to change beyond naming the affected feature or module.
- Do not mention tests, the commit, or a diff.
- Output only the issue text: a one-line title, a blank line, then 3-10 sentences. No tools needed.

Commit:
${commit}`;

async function harvestRepo(name: string): Promise<void> {
	const cfg = allRepos[name]!;
	const repoPath = expandHome(cfg.path);
	const shas = (await mustSh(`git log --no-merges --format=%H -n 3000`, { cwd: repoPath })).trim().split("\n");
	let kept = fs.existsSync(path.join(ROOT, "tasks"))
		? fs.readdirSync(path.join(ROOT, "tasks")).filter(f => f.startsWith(`${name}-`)).length
		: 0;
	let scanned = 0;
	for (const sha of shas) {
		if (kept >= perRepo || scanned >= scan) break;
		const candidate = await inspect(repoPath, sha);
		if (!candidate) continue;
		const id = `${name}-${sha.slice(0, 8)}`;
		if (fs.existsSync(path.join(ROOT, "tasks", `${id}.json`))) continue;
		scanned++;
		const parent = (await mustSh(`git rev-parse ${sha}^`, { cwd: repoPath })).trim();
		const task: Task = {
			id,
			repo: name,
			repoPath,
			sha,
			parent,
			setup: cfg.setup,
			test: cfg.test,
			testFiles: candidate.testFiles,
			runnableTests: candidate.runnableTests,
			ref: candidate.ref,
			message: (await mustSh(`git log -1 --format=%s ${sha}`, { cwd: repoPath })).trim(),
			statement: "",
		};
		const verdict = await validate(task, candidate.nonTestFiles);
		console.log(`[${name}] ${id} ${verdict}`);
		if (verdict !== "ok") {
			fs.rmSync(baseDir(id), { recursive: true, force: true });
			continue;
		}
		const commit = (await mustSh(`git show --format=%B --stat -p ${sha}`, { cwd: repoPath })).slice(0, 40_000);
		const writer = await runAgent({
			cwd: await ensureBase(task),
			prompt: STATEMENT_PROMPT(commit),
			model,
			eventsFile: path.join(ROOT, "work", "statements", `${id}.jsonl`),
			timeoutMs: 5 * 60_000,
			tools: "read",
		});
		task.statement = writer.finalText.trim();
		if (!task.statement) {
			console.log(`[${name}] ${id} statement generation failed`);
			continue;
		}
		writeJson(path.join(ROOT, "tasks", `${id}.json`), task);
		kept++;
	}
	console.log(`[${name}] done: ${kept} tasks, scanned ${scanned} candidates`);
}

/** "ok" only when the reference tests fail on the parent and pass with the reference change applied. */
async function validate(task: Task, nonTestFiles: string[]): Promise<string> {
	await ensureBase(task);
	const dir = path.join(ROOT, "work", "validate", task.id);
	try {
		await cloneBase(task.id, dir);
		const setup = await sh(task.setup, { cwd: dir, timeoutMs: TEST_TIMEOUT });
		if (setup.code !== 0) return `rejected: setup failed ${setup.out.slice(-300)}`;
		applyRef(task, dir, task.testFiles);
		const before = await sh(testCommand(task), { cwd: dir, timeoutMs: TEST_TIMEOUT });
		if (before.code === 0) return "rejected: tests already pass on parent";
		applyRef(task, dir, nonTestFiles);
		const after = await sh(testCommand(task), { cwd: dir, timeoutMs: TEST_TIMEOUT });
		if (after.code !== 0) return `rejected: reference fails its own tests ${after.out.slice(-300).replace(/\s+/g, " ")}`;
		return "ok";
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

await Promise.all(repoNames.map(harvestRepo));
