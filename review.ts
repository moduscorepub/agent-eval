/**
 * Review each run's patch the way a maintainer would before merging: a list of review comments with
 * severities, scored as merge cost (lower is better). One review per run, reused by every comparison.
 *
 *   bun review.ts runs/main [--conditions off,ponytail] [--model anthropic/claude-opus-5-5] [--concurrency 5]
 *
 * Writes <run>/review.json. Production code only (tests are stripped); a failing hidden test adds a
 * fixed blocker-weight penalty so correctness always counts, whatever the reviewer writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Task, ROOT, arg, ensureBase, pool, readJson, readPatch, runAgent, runDirs, writeJson } from "./lib";
import type { RunResult } from "./run";

export const SEVERITY_WEIGHT = { blocker: 4, major: 2, minor: 1, nit: 0 } as const;
export const HIDDEN_FAIL_PENALTY = 4;
type Severity = keyof typeof SEVERITY_WEIGHT;
export interface Review {
	comments: { severity: Severity; category: string; file?: string; comment: string }[];
	score: number;
	hiddenPass: boolean;
	model: string;
}

const REVIEW_PROMPT = (task: Task, patch: string, hiddenPass: boolean) => `You are a senior maintainer of this repository reviewing a pull request before merging it. The working tree is the code BEFORE the change. Read the repository as needed to check existing helpers, sibling implementations, call paths, and conventions.

The pull request claims to resolve this issue:
${task.statement}

Hidden acceptance tests: ${hiddenPass ? "PASS" : "FAIL"}.

Production-code diff (test files are omitted; do not ask for tests):
\`\`\`diff
${patch}
\`\`\`

List every comment you would genuinely leave before merging. Do not invent problems; an empty list is a valid review. Severities:
- blocker: wrong or incomplete behaviour, or it would break something
- major: change in the wrong place, duplicated logic, re-implements existing code, unrequested scope or speculative code, or a codebase convention broken in a way that matters
- minor: worth changing but small (naming, local readability, a small convention slip)
- nit: optional polish
Categories: correctness, design, reuse, convention, scope, missing, readability.

End your reply with exactly one line of JSON:
{"comments":[{"severity":"blocker|major|minor|nit","category":"...","file":"...","comment":"..."}]}`;

function parseComments(text: string): Review["comments"] | undefined {
	const start = text.lastIndexOf('{"comments"');
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return undefined;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as { comments?: Review["comments"] };
		if (!Array.isArray(parsed.comments)) return undefined;
		return parsed.comments.filter(c => c && c.severity in SEVERITY_WEIGHT);
	} catch {
		return undefined;
	}
}

export const scoreOf = (comments: Review["comments"], hiddenPass: boolean) =>
	comments.reduce((sum, c) => sum + SEVERITY_WEIGHT[c.severity], 0) + (hiddenPass ? 0 : HIDDEN_FAIL_PENALTY);

/** File for the k-th independent review of a run (k = 1 keeps the historical name). */
export const reviewFile = (dir: string, k: number) => path.join(dir, k === 1 ? "review.json" : `review-${k}.json`);

/** All reviews present for a run, in order. */
export function readReviews(dir: string): Review[] {
	const out: Review[] = [];
	for (let k = 1; fs.existsSync(reviewFile(dir, k)); k++) out.push(readJson<Review>(reviewFile(dir, k)));
	return out;
}

if (import.meta.main) {
	const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/main");
	const model = arg("model", "anthropic/claude-opus-5-5")!;
	const only = arg("conditions")?.split(",");
	const count = Number(arg("reviews", "1"));
	const jobs = runDirs(runDir)
		.filter(j => !only || only.includes(j.condition))
		.flatMap(j => Array.from({ length: count }, (_, i) => ({ ...j, k: i + 1 })))
		.filter(j => !fs.existsSync(reviewFile(j.dir, j.k)));
	let failed = 0;
	console.log(`${jobs.length} reviews to run with ${model}`);
	await pool(jobs, Number(arg("concurrency", "5")), async job => {
		const result = readJson<RunResult>(path.join(job.dir, "result.json"));
		if (result.setupFailed) return;
		const task = readJson<Task>(path.join(ROOT, "tasks", `${job.task}.json`));
		const prompt = REVIEW_PROMPT(task, readPatch(path.join(job.dir, "patch.diff"), true), result.hiddenPass);
		for (let attempt = 1; attempt <= 3; attempt++) {
			const res = await runAgent({
				cwd: await ensureBase(task),
				prompt,
				model,
				eventsFile: path.join(job.dir, `review${job.k === 1 ? "" : `-${job.k}`}-attempt${attempt}.jsonl`),
				timeoutMs: 15 * 60_000,
				tools: "read,grep,glob",
			});
			const comments = parseComments(res.finalText);
			if (!comments) continue;
			const review: Review = { comments, score: scoreOf(comments, result.hiddenPass), hiddenPass: result.hiddenPass, model };
			writeJson(reviewFile(job.dir, job.k), review);
			console.log(`${job.task} ${job.condition}-s${job.seed} review ${job.k}: merge cost ${review.score} (${comments.length} comments)`);
			return;
		}
		failed++;
		console.log(`${job.task} ${job.condition}-s${job.seed} review ${job.k}: unparseable after 3 attempts`);
	});
	console.log(`done; ${failed} unparseable`);
}
