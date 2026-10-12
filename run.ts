/**
 * Run every task under each condition in an isolated repo copy, then score the result.
 * Resumable: jobs with an existing result.json are skipped.
 *
 *   bun run.ts --out runs/pilot [--conditions off,ponytail] [--tasks id,id | --limit N] [--seeds 1]
 *              [--concurrency 4] [--model anthropic/claude-sonnet-5-5] [--timeout-min 25] [--keep]
 *              [--plans-dir plans]
 *
 * A condition with `"plans": true` seeds each attempt with one plan from plans.ts: seed s uses plan
 * ((s-1) mod 4) of set ceil(s/4), read from <plans-dir>/<task>.set<k>.json.
 *
 * Output per job: runs/<out>/<task>/<condition>-s<seed>/{events.jsonl, patch.diff, test.log, result.json}
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Task,
	AGENT_BIN,
	ROOT,
	applyRef,
	arg,
	cloneBase,
	ensureBase,
	fileKind,
	mustSh,
	pool,
	readJson,
	isInfraFailure,
	runAgent,
	sh,
	testCommand,
	writeJson,
} from "./lib";
import type { PlanSet } from "./plans";

export interface RunResult {
	task: string;
	condition: string;
	seed: number;
	setupFailed: boolean;
	exitCode: number;
	timedOut: boolean;
	durationSec: number;
	cost: number;
	tokens: number;
	toolCalls: number;
	src: { added: number; removed: number };
	testAdded: number;
	filesTouched: number;
	newFiles: number;
	depChange: boolean;
	hiddenPass: boolean;
	refSrcAdded: number;
	/** Provider/transport failures retried before this (scored) attempt. */
	infraRetries: number;
	/** Stop reason of the agent's last message. */
	lastStop: string;
}

const out = path.resolve(ROOT, arg("out") ?? "runs/default");
/** Per condition: extensions, config overlays, extra bin dirs put first on PATH (all relative to the eval root), and plan seeding. */
const conditions = readJson<Record<string, { extensions: string[]; configs?: string[]; bin?: string[]; plans?: boolean }>>(
	path.join(ROOT, "conditions.json"),
);
const plansDir = path.resolve(ROOT, arg("plans-dir", "plans")!);
const conditionNames = (arg("conditions") ?? "off,ponytail").split(",");
const seeds = Number(arg("seeds", "1"));
/** Per-condition run counts overriding --seeds, e.g. `--seed-map off=6`. */
const seedMap = Object.fromEntries((arg("seed-map") ?? "").split(",").filter(Boolean).map(kv => [kv.split("=")[0]!, Number(kv.split("=")[1])]));
const model = arg("model", "anthropic/claude-sonnet-5-5")!;
const timeoutMs = Number(arg("timeout-min", "25")) * 60_000;
const keep = process.argv.includes("--keep");

/** The prompt for one attempt: the issue, plus one plan when the condition seeds plans. */
function promptFor(task: Task, condition: string, seed: number): string {
	const issue = `Resolve this issue in the current repository.\n\n${task.statement}`;
	if (!conditions[condition]!.plans) return issue;
	const set = readJson<PlanSet>(path.join(plansDir, `${task.id}.set${Math.ceil(seed / 4)}.json`));
	const plan = set.plans[(seed - 1) % set.plans.length]!;
	return `${issue}\n\nUse this approach:\n${plan.title}: ${plan.summary}\nKey decision (${set.decision.question}): ${plan.stance}\nFiles: ${plan.files.join(", ")}`;
}

const taskIds = arg("tasks")?.split(",") ?? fs.readdirSync(path.join(ROOT, "tasks")).map(f => f.replace(/\.json$/, "")).sort();
const tasks = taskIds.slice(0, Number(arg("limit", String(taskIds.length)))).map(id => readJson<Task>(path.join(ROOT, "tasks", `${id}.json`)));
for (const name of conditionNames) if (!conditions[name]) throw new Error(`unknown condition ${name}`);

/** Deterministic Fisher-Yates shuffle (mulberry32), so concurrent runs mix tasks and conditions. */
function shuffle<T>(items: T[], seed = 7): T[] {
	const out = [...items];
	let s = seed;
	const rand = () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

const jobs = shuffle(
	tasks.flatMap(task =>
		conditionNames.flatMap(condition => Array.from({ length: seedMap[condition] ?? seeds }, (_, i) => ({ task, condition, seed: i + 1 }))),
	),
);

async function runJob(job: (typeof jobs)[number]): Promise<void> {
	const dir = path.join(out, job.task.id, `${job.condition}-s${job.seed}`);
	if (fs.existsSync(path.join(dir, "result.json"))) return;
	// Provider failures (overload, transport) are not the agent's work: retry them on a fresh copy.
	for (let attempt = 0; attempt <= 2; attempt++) {
		const result = await runOnce(job, dir, attempt);
		if (result) return;
		console.log(`${job.task.id} ${job.condition}-s${job.seed}: provider failure, retrying (${attempt + 1}/2)`);
		await Bun.sleep(30_000);
	}
	console.log(`${job.task.id} ${job.condition}-s${job.seed}: gave up after repeated provider failures`);
}

/** One attempt; returns false (and writes nothing) when the agent run hit a provider failure. */
async function runOnce({ task, condition, seed }: (typeof jobs)[number], dir: string, attempt: number): Promise<boolean> {
	const repo = path.join(dir, "repo");
	await ensureBase(task);
	await cloneBase(task.id, repo);
	const result: RunResult = {
		task: task.id,
		condition,
		seed,
		setupFailed: false,
		exitCode: -1,
		timedOut: false,
		durationSec: 0,
		cost: 0,
		tokens: 0,
		toolCalls: 0,
		src: { added: 0, removed: 0 },
		testAdded: 0,
		filesTouched: 0,
		newFiles: 0,
		depChange: false,
		hiddenPass: false,
		refSrcAdded: task.ref.srcAdded,
		infraRetries: attempt,
		lastStop: "",
	};
	let scored = true;
	try {
		if ((await sh(task.setup, { cwd: repo, timeoutMs: 10 * 60_000 })).code !== 0) {
			result.setupFailed = true;
			return true;
		}
		// Commit anything setup produced (e.g. a generated lockfile) so it is not scored as the agent's change.
		await mustSh(`git add -A && (git diff --cached --quiet || git commit -q -m "chore: install dependencies")`, {
			cwd: repo,
		});
		const start = (await mustSh("git rev-parse HEAD", { cwd: repo })).trim();
		const agent = await runAgent({
			cwd: repo,
			prompt: promptFor(task, condition, seed),
			model,
			extensions: conditions[condition]!.extensions,
			configs: conditions[condition]!.configs,
			eventsFile: path.join(dir, "events.jsonl"),
			timeoutMs,
			env: {
				GRAIN_LOG: path.join(dir, "grain.jsonl"),
				...(conditions[condition]!.bin
					? { PATH: [...conditions[condition]!.bin!.map(b => path.resolve(ROOT, b)), process.env.PATH].join(":") }
					: {}),
				HOOK_LOG_DIR: dir,
				EVAL_AGENT_BIN: AGENT_BIN,
			},
		});
		if (isInfraFailure(agent, agent.code, agent.timedOut)) {
			scored = false;
			fs.renameSync(path.join(dir, "events.jsonl"), path.join(dir, `events-infra-${attempt}.jsonl`));
			return false;
		}
		Object.assign(result, {
			exitCode: agent.code,
			timedOut: agent.timedOut,
			durationSec: Math.round(agent.ms / 1000),
			cost: agent.cost,
			tokens: agent.tokens,
			toolCalls: agent.toolCalls,
			lastStop: agent.lastStop,
		});

		// Everything the agent changed since setup, committed or not.
		await mustSh("git add -A", { cwd: repo });
		fs.writeFileSync(path.join(dir, "patch.diff"), await mustSh(`git diff --cached ${start}`, { cwd: repo }));
		for (const line of (await mustSh(`git diff --cached --numstat ${start}`, { cwd: repo })).trim().split("\n")) {
			const [added, removed, file] = line.split("\t");
			if (!file) continue;
			result.filesTouched++;
			const kind = fileKind(file);
			if (kind === "src") {
				result.src.added += Number(added) || 0;
				result.src.removed += Number(removed) || 0;
			} else if (kind === "test") result.testAdded += Number(added) || 0;
			else if (kind === "dep") result.depChange = true;
		}
		result.newFiles = (await mustSh(`git diff --cached --name-status --diff-filter=A ${start}`, { cwd: repo }))
			.trim()
			.split("\n")
			.filter(Boolean).length;

		// Hidden acceptance tests: the reference commit's test files, run against the agent's tree.
		applyRef(task, repo, task.testFiles);
		const hidden = await sh(testCommand(task), { cwd: repo, timeoutMs: 10 * 60_000 });
		result.hiddenPass = hidden.code === 0;
		fs.writeFileSync(path.join(dir, "test.log"), hidden.out.slice(-20_000));
	} finally {
		if (scored) writeJson(path.join(dir, "result.json"), result);
		if (!keep) fs.rmSync(repo, { recursive: true, force: true });
		if (scored) {
			console.log(
				`${task.id} ${condition}-s${seed}: hidden=${result.hiddenPass ? "PASS" : "FAIL"} src+${result.src.added}/-${result.src.removed} (ref +${result.refSrcAdded}) files=${result.filesTouched} $${result.cost.toFixed(2)} ${result.durationSec}s${result.timedOut ? " TIMEOUT" : ""}${result.setupFailed ? " SETUP-FAILED" : ""}`,
			);
		}
	}
	return true;
}

console.log(`${jobs.length} jobs (${tasks.length} tasks x ${conditionNames.join("/")} x ${seeds} seeds) -> ${out}`);
await pool(jobs, Number(arg("concurrency", "4")), runJob);
