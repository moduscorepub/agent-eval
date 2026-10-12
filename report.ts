/**
 * Aggregate a run directory into report.md.
 *
 *   bun report.ts runs/main [--split dev|holdout] [--judge off,ponytail] [--prod-only]
 *                 [--judge-model anthropic/claude-opus-5-5] [--concurrency 3]
 *
 * Sections:
 * - outcome metrics per condition (hidden tests, size, cost)
 * - merge cost from review.json (see review.ts): per condition, paired condition-vs-condition
 *   differences, and run-1-vs-run-2 controls of the same condition (the noise floor). Tasks are the
 *   unit of analysis: runs of one task are averaged, intervals come from resampling tasks, and the
 *   sign test counts tasks.
 * - optional pairwise approach judge (--judge): blind, both orders; a pair is a win only when both
 *   orders agree. --prod-only strips test files from both patches.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Task, ROOT, arg, ensureBase, pool, readJson, readPatch, runAgent, runDirs, writeJson } from "./lib";
import type { Review } from "./review";
import type { RunResult } from "./run";

const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/default");
const judgePair = arg("judge")?.split(",") as [string, string] | undefined;
const judgeModel = arg("judge-model", "anthropic/claude-opus-5-5")!;
const prodOnly = process.argv.includes("--prod-only");
const judgeTag = prodOnly ? "-prod" : "";
const split = arg("split") as "dev" | "holdout" | undefined;
const splitTasks = split ? new Set(readJson<Record<string, string[]>>(path.join(ROOT, "splits.json"))[split]) : undefined;

const results: RunResult[] = [];
const reviews = new Map<string, Review>();
const runKey = (task: string, condition: string, seed: number) => `${task}/${condition}-s${seed}`;
for (const job of runDirs(runDir)) {
	if (splitTasks && !splitTasks.has(job.task)) continue;
	results.push(readJson<RunResult>(path.join(job.dir, "result.json")));
	const reviewFile = path.join(job.dir, "review.json");
	if (fs.existsSync(reviewFile)) reviews.set(runKey(job.task, job.condition, job.seed), readJson<Review>(reviewFile));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
	if (xs.length === 0) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const sd = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / Math.max(1, xs.length - 1));
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
const fmt = (x: number, digits = 0) => (Number.isFinite(x) ? x.toFixed(digits) : "-");

/** Deterministic PRNG so bootstrap intervals are reproducible. */
function mulberry32(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 95% percentile interval of the mean, resampling tasks. */
function bootstrapCI(diffs: number[], reps = 10_000): [number, number] {
	const rand = mulberry32(1);
	const means: number[] = [];
	for (let r = 0; r < reps; r++) {
		let sum = 0;
		for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rand() * diffs.length)]!;
		means.push(sum / diffs.length);
	}
	means.sort((a, b) => a - b);
	return [means[Math.floor(0.025 * reps)]!, means[Math.floor(0.975 * reps)]!];
}

/** Exact two-sided sign test over non-zero differences. */
function signTest(wins: number, losses: number): number {
	const n = wins + losses;
	if (n === 0) return 1;
	let tail = 0;
	let coef = 1;
	for (let k = 0; k <= Math.min(wins, losses); k++) {
		tail += coef;
		coef = (coef * (n - k)) / (k + 1);
	}
	return Math.min(1, (2 * tail) / 2 ** n);
}

const lines: string[] = [`# Eval report: ${path.relative(ROOT, runDir)}${split ? ` (${split} split, ${splitTasks!.size} tasks)` : ""}`, ""];
// Column order follows conditions.json; unknown conditions go last.
const declared = Object.keys(readJson<Record<string, unknown>>(path.join(ROOT, "conditions.json")));
const rank = (c: string) => (declared.includes(c) ? declared.indexOf(c) : declared.length);
const byCondition = new Map(
	[...Map.groupBy(results, r => r.condition)].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)),
);
const conditions = [...byCondition.keys()];

lines.push(
	"| Condition | Runs | Hidden tests pass | Median src lines added | Median added / reference | New files (mean) | Dependency changes | Median cost | Median minutes | Timeouts |",
	"|---|---|---|---|---|---|---|---|---|---|",
);
for (const [condition, rs] of byCondition) {
	const ok = rs.filter(r => !r.setupFailed);
	lines.push(
		`| ${condition} | ${ok.length} | ${pct(ok.filter(r => r.hiddenPass).length, ok.length)} | ${fmt(median(ok.map(r => r.src.added)))} | ${fmt(median(ok.map(r => r.src.added / Math.max(1, r.refSrcAdded))), 2)} | ${fmt(ok.reduce((a, r) => a + r.newFiles, 0) / Math.max(1, ok.length), 1)} | ${ok.filter(r => r.depChange).length} | $${fmt(median(ok.map(r => r.cost)), 2)} | ${fmt(median(ok.map(r => r.durationSec / 60)), 1)} | ${ok.filter(r => r.timedOut).length} |`,
	);
}

// ── Merge cost ────────────────────────────────────────────────────────────────
if (reviews.size > 0) {
	const reviewModels = [...new Set([...reviews.values()].map(r => r.model))].join(", ");
	lines.push(
		"",
		`## Merge cost (review comments; blocker 4, major 2, minor 1, nit 0, +4 if hidden tests fail; lower is better; reviewer ${reviewModels})`,
		"",
		"| Condition | Reviewed runs | Mean cost | Median cost | Clean (no blocker/major, tests pass) | Blockers / run | Majors / run | Minors / run |",
		"|---|---|---|---|---|---|---|---|",
	);
	const scoresByTask = new Map<string, Map<string, number[]>>(); // condition -> task -> scores by seed order
	for (const condition of conditions) {
		const rs = byCondition.get(condition)!.filter(r => reviews.has(runKey(r.task, condition, r.seed)));
		if (rs.length === 0) continue;
		const rv = rs.map(r => reviews.get(runKey(r.task, condition, r.seed))!);
		const count = (sev: string) => mean(rv.map(r => r.comments.filter(c => c.severity === sev).length));
		const clean = rv.filter(r => r.hiddenPass && !r.comments.some(c => c.severity === "blocker" || c.severity === "major")).length;
		lines.push(
			`| ${condition} | ${rv.length} | ${fmt(mean(rv.map(r => r.score)), 2)} | ${fmt(median(rv.map(r => r.score)), 1)} | ${pct(clean, rv.length)} | ${fmt(count("blocker"), 2)} | ${fmt(count("major"), 2)} | ${fmt(count("minor"), 2)} |`,
		);
		const perTask = new Map<string, number[]>();
		for (const r of [...rs].sort((a, b) => a.seed - b.seed)) {
			perTask.set(r.task, [...(perTask.get(r.task) ?? []), reviews.get(runKey(r.task, condition, r.seed))!.score]);
		}
		scoresByTask.set(condition, perTask);
	}

	type Row = { label: string; diffs: number[] };
	const rows: Row[] = [];
	const reviewed = [...scoresByTask.keys()];
	for (let i = 0; i < reviewed.length; i++) {
		for (let j = i + 1; j < reviewed.length; j++) {
			const a = scoresByTask.get(reviewed[i]!)!;
			const b = scoresByTask.get(reviewed[j]!)!;
			const diffs = [...a.keys()].filter(t => b.has(t)).map(t => mean(b.get(t)!) - mean(a.get(t)!));
			rows.push({ label: `${reviewed[j]} − ${reviewed[i]}`, diffs });
		}
	}
	const controls: Row[] = [];
	for (const condition of reviewed) {
		const perTask = scoresByTask.get(condition)!;
		const diffs = [...perTask.values()].filter(s => s.length >= 2).map(s => s[1]! - s[0]!);
		if (diffs.length > 0) controls.push({ label: `${condition} run 2 − run 1 (control)`, diffs });
	}
	lines.push(
		"",
		"Paired by task (runs of a task averaged). Negative = the first-named condition costs less to merge.",
		"",
		"| Comparison | Tasks | Mean difference | 95% CI (task bootstrap) | Tasks better / worse / equal | Sign test p |",
		"|---|---|---|---|---|---|",
	);
	for (const row of [...rows, ...controls]) {
		const [lo, hi] = bootstrapCI(row.diffs);
		const better = row.diffs.filter(d => d < 0).length;
		const worse = row.diffs.filter(d => d > 0).length;
		lines.push(
			`| ${row.label} | ${row.diffs.length} | ${fmt(mean(row.diffs), 2)} | [${fmt(lo, 2)}, ${fmt(hi, 2)}] | ${better} / ${worse} / ${row.diffs.length - better - worse} | ${fmt(signTest(better, worse), 3)} |`,
		);
	}
	const noise = controls.flatMap(c => c.diffs);
	if (noise.length > 1) {
		const sdRun = sd(noise) / Math.SQRT2; // a single run's spread around its task mean
		const tasks = Math.max(...controls.map(c => c.diffs.length));
		const mde = (n: number, k: number) => 2.8 * Math.sqrt((2 * sdRun ** 2) / k / n);
		lines.push(
			"",
			`Noise floor from the controls: one run's merge cost varies by SD ${fmt(sdRun, 2)} around its task's mean. Smallest mean difference detectable at 80% power (paired, two-sided 5%; a lower bound that ignores task-by-condition interaction):`,
			"",
			"| Tasks | 1 run per condition | 2 runs | 4 runs |",
			"|---|---|---|---|",
			...[tasks, 60, 120].map(n => `| ${n} | ${fmt(mde(n, 1), 2)} | ${fmt(mde(n, 2), 2)} | ${fmt(mde(n, 4), 2)} |`),
		);
	}
}

// Per-task paired view: lines added, hidden-test outcome and merge cost side by side.
lines.push("", `| Task | ${conditions.map(c => `${c} (pass, +src, cost)`).join(" | ")} |`, `|---|${conditions.map(() => "---").join("|")}|`);
for (const [task, rs] of [...Map.groupBy(results, r => r.task)].sort(([a], [b]) => a.localeCompare(b))) {
	const cells = conditions.map(c => {
		const runs = rs.filter(r => r.condition === c).sort((a, b) => a.seed - b.seed);
		return (
			runs
				.map(r => `${r.hiddenPass ? "pass" : "FAIL"} +${r.src.added}${reviews.has(runKey(task, c, r.seed)) ? ` $${reviews.get(runKey(task, c, r.seed))!.score}` : ""}`)
				.join(", ") || "-"
		);
	});
	lines.push(`| ${task} (ref +${rs[0]!.refSrcAdded}) | ${cells.join(" | ")} |`);
}

const JUDGE_PROMPT = (task: Task, a: string, aPass: boolean, b: string, bPass: boolean) => `You are reviewing two candidate patches, A and B. Each one tries to resolve the same issue in this repository. The working tree is the code BEFORE either patch. Read the repository as needed to understand existing helpers, call paths, and conventions.

Decide which patch has the better ENGINEERING APPROACH, as a strong maintainer reviewing for merge would:
- Solves the actual problem at the right place (root cause or shared code path, not a symptom patch at one call site).
- Reuses existing helpers, types, and patterns instead of re-implementing them.
- Adds no speculative abstractions, options, or code the issue does not need. Nothing the issue requires is missing.
- Is consistent with the codebase's conventions.
Hidden acceptance tests: A ${aPass ? "PASS" : "FAIL"}, B ${bPass ? "PASS" : "FAIL"}. A failing patch is incomplete or wrong, so weigh that heavily.
Patch size is not the criterion by itself. Prefer the approach you would rather maintain.${prodOnly ? "\nTest files are omitted from both patches: judge the production code only." : ""}

Issue:
${task.statement}

Patch A:
\`\`\`diff
${a}
\`\`\`

Patch B:
\`\`\`diff
${b}
\`\`\`

End your reply with exactly one line of JSON: {"winner":"A"|"B"|"tie","reason":"<one sentence>"}`;

if (judgePair) {
	const [first, second] = judgePair;
	const pairs = results
		.filter(r => r.condition === first && !r.setupFailed)
		.map(r => [r, results.find(o => o.task === r.task && o.seed === r.seed && o.condition === second && !o.setupFailed)] as const)
		.filter((p): p is readonly [RunResult, RunResult] => p[1] !== undefined);
	type Verdict = { order1: string; order2: string; winner: string; reason: string };
	const verdicts: Verdict[] = [];
	await pool([...pairs], Number(arg("concurrency", "3")), async ([x, y]) => {
		const file = path.join(runDir, x.task, `judge${judgeTag}-${first}-vs-${second}-s${x.seed}.json`);
		if (fs.existsSync(file)) {
			verdicts.push(readJson<Verdict>(file));
			return;
		}
		const task = readJson<Task>(path.join(ROOT, "tasks", `${x.task}.json`));
		const cwd = await ensureBase(task);
		const patchX = readPatch(path.join(runDir, x.task, `${first}-s${x.seed}`, "patch.diff"), prodOnly);
		const patchY = readPatch(path.join(runDir, x.task, `${second}-s${y.seed}`, "patch.diff"), prodOnly);
		const ask = async (order: number, prompt: string) => {
			const res = await runAgent({
				cwd,
				prompt,
				model: judgeModel,
				eventsFile: path.join(runDir, x.task, `judge${judgeTag}-${first}-vs-${second}-s${x.seed}-order${order}.jsonl`),
				timeoutMs: 15 * 60_000,
				tools: "read,grep,glob",
			});
			const json = res.finalText.trim().split("\n").reverse().find(l => l.trim().startsWith("{"));
			try {
				return JSON.parse(json ?? "") as { winner: string; reason: string };
			} catch {
				return { winner: "tie", reason: "unparseable judge output" };
			}
		};
		// Order 1: A=first, B=second. Order 2: A=second, B=first. Map both back to condition names.
		const [v1, v2] = await Promise.all([
			ask(1, JUDGE_PROMPT(task, patchX, x.hiddenPass, patchY, y.hiddenPass)),
			ask(2, JUDGE_PROMPT(task, patchY, y.hiddenPass, patchX, x.hiddenPass)),
		]);
		const name1 = v1.winner === "A" ? first : v1.winner === "B" ? second : "tie";
		const name2 = v2.winner === "A" ? second : v2.winner === "B" ? first : "tie";
		const verdict: Verdict = {
			order1: name1,
			order2: name2,
			winner: name1 === name2 ? name1 : "tie",
			reason: `${v1.reason} | ${v2.reason}`,
		};
		writeJson(file, verdict);
		verdicts.push(verdict);
	});
	const count = (w: string) => verdicts.filter(v => v.winner === w).length;
	const agree = verdicts.filter(v => v.order1 === v.order2).length;
	lines.push(
		"",
		`## Approach judge (${judgeModel}, blind, both orders${prodOnly ? ", production code only" : ""})`,
		"",
		`| Pairs | ${first} wins | ${second} wins | Ties | Orders agree | Sign test p |`,
		"|---|---|---|---|---|---|",
		`| ${verdicts.length} | ${count(first)} | ${count(second)} | ${count("tie")} | ${pct(agree, verdicts.length)} | ${fmt(signTest(count(first), count(second)), 3)} |`,
	);
}

const report = `${lines.join("\n")}\n`;
fs.writeFileSync(path.join(runDir, split ? `report-${split}.md` : "report.md"), report);
process.stdout.write(report);
