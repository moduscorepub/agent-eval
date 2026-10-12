/**
 * Hard checks on stored runs: rebuild each run's tree and record what a picker could know without
 * hidden tests or reviews.
 *
 *   bun checks.ts runs/final [--conditions off] [--tasks a,b] [--concurrency 3] [--per-task 3] [--no-cross]
 *
 * Per task, in replay/checks/<task>/:
 * - base.json: the visible suite at the base commit and the files the suite itself writes.
 * - <cond>-s<n>.json: visible-suite regressions and own-test failures, new checker findings, stray
 *   files (written by the suite or shaped like runtime output), hidden tests with stray files stripped.
 * - cross.json: every baseline attempt's own tests run against every other baseline attempt's tree.
 * Hidden tests are only ever used for the stripped-patch comparison, never as a picker signal.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Finding, checkFile, checkProject, detect, keyOf } from "./conditions/checkers/checkers";
import { type Task, ROOT, applyRef, arg, cloneBase, ensureBase, fileKind, mustSh, pool, q, readJson, runDirs, sh, testCommand, writeJson } from "./lib";

const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/final");
const only = (arg("conditions") ?? "off").split(",");
const OUT = path.join(ROOT, "replay", "checks");
const WORK = path.join(ROOT, "work", "replay");
const cross = !process.argv.includes("--no-cross");
const GIT = "git -c user.name=eval -c user.email=eval@example.com";

export interface PatchFile {
	path: string;
	status: "A" | "M" | "D";
	kind: ReturnType<typeof fileKind>;
}
export interface SuiteResult {
	ran: boolean;
	timedOut: boolean;
	exitCode: number;
	total: number;
	failed: string[];
	/** Test id -> file it lives in. */
	files: Record<string, string>;
	ms: number;
}
export interface RunChecks {
	run: string;
	applied: boolean;
	files: PatchFile[];
	suite: { total: number; failed: number; regressions: string[]; ownTotal: number; ownFailed: number; timedOut: boolean; exitCode: number };
	checker: { count: number; findings: Finding[] };
	stray: { files: string[]; suiteWritten: string[]; shaped: string[] };
	/** Hidden tests on the tree with stray files reverted (only when stray files exist). */
	strippedHiddenPass?: boolean;
	testFiles: string[];
	runnableTests: string[];
}
export interface CrossResult {
	/** Attempt whose tests ran. */
	tests: string;
	/** Attempt whose tree they ran against. */
	tree: string;
	total: number;
	failed: number;
	exitCode: number;
	timedOut: boolean;
}

export function patchFiles(diff: string): PatchFile[] {
	return diff
		.split(/^(?=diff --git )/m)
		.filter(c => c.startsWith("diff --git "))
		.map(chunk => {
			const deleted = /^deleted file mode/m.test(chunk);
			const p = deleted ? chunk.match(/^diff --git a\/(\S+)/)![1]! : chunk.match(/^diff --git a\/\S+ b\/(\S+)/)![1]!;
			return { path: p, status: /^new file mode/m.test(chunk) ? "A" : deleted ? "D" : "M", kind: fileKind(p) } as PatchFile;
		});
}

const RUNNABLE = /(^|\/)test_[^/]*\.py$|_test\.py$|\.(test|spec)\.[cm]?[jt]sx?$/;
const DATA_DIR = /(^|\/)(data|output|outputs|results|reports|logs?|tmp|cache|artifacts|runs)\//;
const DATA_EXT = /\.(log|jsonl|csv|tsv|db|sqlite3?|pkl|pickle|npy|npz|parquet|pt|ckpt|bin|h5|wav|mp3|png|jpe?g)$/;
const DATED = /\d{4}-\d{2}-\d{2}|\d{8}/;

/** Files in the patch that look like output of running code, not authored change. */
export function strayFiles(files: PatchFile[], statement: string, suiteWritten: string[]): RunChecks["stray"] {
	const patterns = suiteWritten.map(p => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+/g, "\\d+")}$`));
	const mentioned = (p: string) => statement.includes(p) || statement.includes(path.basename(p));
	const candidates = files.filter(f => f.status !== "D" && f.kind === "other" && !mentioned(f.path));
	const written = candidates.filter(f => patterns.some(re => re.test(f.path))).map(f => f.path);
	const shaped = candidates.filter(f => DATA_DIR.test(f.path) || DATA_EXT.test(f.path) || DATED.test(path.basename(f.path))).map(f => f.path);
	return { files: [...new Set([...written, ...shaped])].sort(), suiteWritten: written, shaped };
}

/** Run tests (all when `files` is empty) with a JUnit report; per-test pass/fail. */
async function runTests(task: Task, cwd: string, files: string[], timeoutMs: number): Promise<SuiteResult> {
	const xml = path.join(os.tmpdir(), `junit-${process.pid}-${Math.random().toString(36).slice(2)}.xml`);
	const base = task.test.replace("{files}", files.map(q).join(" "));
	const cmd = base.includes("pytest") ? `${base} --junitxml=${q(xml)} -o junit_family=xunit1` : `${base} --reporter=junit --outputFile=${q(xml)}`;
	const res = await sh(cmd, { cwd, timeoutMs });
	const out: SuiteResult = { ran: false, timedOut: res.timedOut, exitCode: res.code, total: 0, failed: [], files: {}, ms: res.ms };
	if (!fs.existsSync(xml)) return out;
	const text = fs.readFileSync(xml, "utf8");
	fs.rmSync(xml, { force: true });
	out.ran = true;
	for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
		const attrs = Object.fromEntries([...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1]!, a[2]!]));
		const body = m[2] ?? "";
		if (/<skipped\b/.test(body)) continue;
		const id = `${attrs.classname ?? ""}::${attrs.name ?? ""}`;
		out.total++;
		const classname = attrs.classname ?? "";
		out.files[id] = attrs.file ?? (classname.includes("/") ? classname : classname.replace(/\./g, "/"));
		if (/<(failure|error)\b/.test(body)) out.failed.push(id);
	}
	return out;
}

const belongsTo = (testFile: string, owned: string[]) =>
	owned.some(f => testFile === f || f.replace(/\.py$/, "") === testFile || testFile.startsWith(`${f.replace(/\.py$/, "")}/`));

async function prepare(task: Task, dir: string): Promise<boolean> {
	await ensureBase(task);
	await cloneBase(task.id, dir);
	if ((await sh(task.setup, { cwd: dir, timeoutMs: 10 * 60_000 })).code !== 0) return false;
	await mustSh(`git add -A && (git diff --cached --quiet || ${GIT} commit -q -m setup)`, { cwd: dir });
	return true;
}
const reset = (dir: string) => mustSh("git reset -q --hard HEAD && git clean -fdq", { cwd: dir });

/** Check `runs` of one task into `outDir`; cross-attempt tests run among the runs marked `baseline`. */
export async function checkTask(task: Task, runs: { name: string; dir: string; baseline: boolean }[], outDir = path.join(OUT, task.id)): Promise<void> {
	if (fs.existsSync(path.join(outDir, "done"))) return;
	const work = path.join(WORK, path.relative(ROOT, outDir).replace(/[\\/]/g, "__"));
	fs.rmSync(work, { recursive: true, force: true });
	const t0 = Date.now();
	try {
		const baseTree = path.join(work, "base");
		if (!(await prepare(task, baseTree))) throw new Error(`${task.id}: base setup failed`);
		const baseSuite = await runTests(task, baseTree, [], 15 * 60_000);
		const suiteWritten = (await mustSh("git status --porcelain --untracked-files=all", { cwd: baseTree }))
			.split("\n")
			.filter(Boolean)
			.map(l => l.slice(3).replace(/^"|"$/g, ""));
		await reset(baseTree);
		const basePassed = new Set(Object.keys(baseSuite.files).filter(id => !baseSuite.failed.includes(id)));
		writeJson(path.join(outDir, "base.json"), { suite: { ...baseSuite, files: undefined, failed: baseSuite.failed }, suiteWritten });

		const tc = detect(baseTree);
		const baseCache = fs.mkdtempSync(path.join(os.tmpdir(), "checks-base-"));
		const baseProject = new Set((await checkProject(baseTree, tc, baseCache)).map(keyOf));
		const baseFile = new Map<string, Set<string>>();
		const baseFindings = (rel: string) => {
			if (!baseFile.has(rel)) baseFile.set(rel, new Set(checkFile(baseTree, tc, rel, baseCache).map(keyOf)));
			return baseFile.get(rel)!;
		};

		const trees = new Map<string, string>();
		const results = new Map<string, RunChecks>();
		await pool(runs, Number(arg("per-task", "3")), async run => {
			const tree = path.join(work, run.name);
			const diff = fs.readFileSync(path.join(run.dir, "patch.diff"), "utf8");
			const files = patchFiles(diff);
			const rec: RunChecks = {
				run: run.name,
				applied: false,
				files,
				suite: { total: 0, failed: 0, regressions: [], ownTotal: 0, ownFailed: 0, timedOut: false, exitCode: -1 },
				checker: { count: 0, findings: [] },
				stray: strayFiles(files, task.statement, suiteWritten),
				testFiles: files.filter(f => f.kind === "test" && f.status !== "D").map(f => f.path),
				runnableTests: files.filter(f => f.kind === "test" && f.status !== "D" && RUNNABLE.test(f.path)).map(f => f.path),
			};
			if (!(await prepare(task, tree))) throw new Error(`${task.id} ${run.name}: setup failed`);
			if (diff.trim()) {
				const patchFile = path.join(tree, "..", `${run.name}.patch`);
				fs.writeFileSync(patchFile, diff);
				const apply = await sh(`git apply --whitespace=nowarn ${q(patchFile)} || git apply --3way --whitespace=nowarn ${q(patchFile)}`, { cwd: tree });
				rec.applied = apply.code === 0;
				if (!rec.applied) console.log(`${task.id} ${run.name}: patch did not apply:\n${apply.out.slice(-500)}`);
				if (files.some(f => f.kind === "dep")) await sh(task.setup, { cwd: tree, timeoutMs: 10 * 60_000 });
			} else rec.applied = true;
			await mustSh(`git add -A && ${GIT} commit -q --allow-empty -m candidate`, { cwd: tree });

			const suite = await runTests(task, tree, [], 15 * 60_000);
			await reset(tree);
			const own = Object.entries(suite.files).filter(([, f]) => belongsTo(f, rec.testFiles));
			// A regression or own-test failure counts only if it fails again with its file run alone:
			// some suites have tests that flake under load.
			let failed = suite.failed;
			const suspect = failed.filter(id => basePassed.has(id) || belongsTo(suite.files[id]!, rec.testFiles));
			if (suspect.length) {
				const rerunFiles = [...new Set(suspect.map(id => suite.files[id]!))].filter(f => fs.existsSync(path.join(tree, f)));
				const again = await runTests(task, tree, rerunFiles, 10 * 60_000);
				await reset(tree);
				failed = failed.filter(id => !suspect.includes(id) || !(id in again.files) || again.failed.includes(id));
			}
			rec.suite = {
				total: suite.total,
				failed: failed.length,
				regressions: failed.filter(id => basePassed.has(id)),
				ownTotal: own.length,
				ownFailed: own.filter(([id]) => failed.includes(id)).length,
				timedOut: suite.timedOut,
				exitCode: suite.exitCode,
			};

			const cache = fs.mkdtempSync(path.join(os.tmpdir(), "checks-run-"));
			const changed = files.filter(f => f.status !== "D" && f.kind === "src").map(f => f.path);
			const findings = changed.flatMap(rel => checkFile(tree, tc, rel, cache).filter(x => !baseFindings(rel).has(keyOf(x))));
			if (tc.tsc && changed.some(f => /\.(ts|tsx|js|jsx|mts|cts)$/.test(f))) {
				findings.push(...(await checkProject(tree, tc, cache)).filter(x => !baseProject.has(keyOf(x))));
			}
			fs.rmSync(cache, { recursive: true, force: true });
			rec.checker = { count: findings.length, findings: findings.slice(0, 40) };

			if (rec.stray.files.length) {
				for (const f of rec.stray.files) {
					const status = files.find(x => x.path === f)!.status;
					if (status === "A") fs.rmSync(path.join(tree, f), { force: true });
					else await mustSh(`git checkout HEAD~1 -- ${q(f)}`, { cwd: tree });
				}
				applyRef(task, tree, task.testFiles);
				rec.strippedHiddenPass = (await sh(testCommand(task), { cwd: tree, timeoutMs: 10 * 60_000 })).code === 0;
				await reset(tree);
			}

			const saved = path.join(outDir, run.name, "tests");
			for (const f of rec.testFiles) {
				if (!fs.existsSync(path.join(tree, f))) continue;
				fs.mkdirSync(path.dirname(path.join(saved, f)), { recursive: true });
				fs.copyFileSync(path.join(tree, f), path.join(saved, f));
			}
			writeJson(path.join(outDir, `${run.name}.json`), rec);
			trees.set(run.name, tree);
			results.set(run.name, rec);
			console.log(`${task.id} ${run.name}: suite ${rec.suite.failed}/${rec.suite.total} failed (${rec.suite.regressions.length} regressions, own ${rec.suite.ownFailed}/${rec.suite.ownTotal}), checker +${rec.checker.count}, stray ${rec.stray.files.length}${rec.strippedHiddenPass === undefined ? "" : `, stripped hidden ${rec.strippedHiddenPass ? "PASS" : "FAIL"}`}, ${Math.round(suite.ms / 1000)}s`);
		});

		if (cross) {
			const baseline = runs.filter(r => r.baseline).map(r => r.name);
			const crossOut: CrossResult[] = [];
			await pool(baseline, Number(arg("per-task", "3")), async treeName => {
				const tree = trees.get(treeName)!;
				for (const testsOf of baseline) {
					const donor = results.get(testsOf)!;
					if (testsOf === treeName || donor.runnableTests.length === 0) continue;
					for (const f of donor.testFiles) {
						const src = path.join(outDir, testsOf, "tests", f);
						if (!fs.existsSync(src)) continue;
						fs.mkdirSync(path.dirname(path.join(tree, f)), { recursive: true });
						fs.copyFileSync(src, path.join(tree, f));
					}
					const r = await runTests(task, tree, donor.runnableTests, 5 * 60_000);
					await reset(tree);
					crossOut.push({ tests: testsOf, tree: treeName, total: r.total, failed: r.failed.length, exitCode: r.exitCode, timedOut: r.timedOut });
				}
			});
			writeJson(path.join(outDir, "cross.json"), crossOut);
		}
		fs.rmSync(baseCache, { recursive: true, force: true });
		fs.writeFileSync(path.join(outDir, "done"), `${Math.round((Date.now() - t0) / 1000)}s\n`);
		console.log(`${task.id}: done in ${Math.round((Date.now() - t0) / 1000)}s`);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const taskFilter = arg("tasks")?.split(",");
	const all = runDirs(runDir).filter(j => only.includes(j.condition) && (!taskFilter || taskFilter.includes(j.task)));
	const tasks = [...new Set(all.map(j => j.task))].sort();
	console.log(`${all.length} runs over ${tasks.length} tasks (${only.join(",")})`);
	await pool(tasks, Number(arg("concurrency", "3")), async id => {
		const task = readJson<Task>(path.join(ROOT, "tasks", `${id}.json`));
		const runs = all.filter(j => j.task === id).map(j => ({ name: `${j.condition}-s${j.seed}`, dir: j.dir, baseline: j.condition === "off" }));
		try {
			await checkTask(task, runs);
		} catch (err) {
			console.log(`${id}: FAILED ${err instanceof Error ? err.message : err}`);
		}
	});
}
