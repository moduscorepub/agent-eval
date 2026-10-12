/**
 * Final-run analysis, as pre-registered in runs/final/PLAN.md.
 *
 *   bun analyze.ts runs/final
 *
 * Writes REPORT.md (tables) and diffs-to-read.json (the runs to compare by hand) into the run dir.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, readJson, runDirs, writeJson } from "./lib";
import { readReviews } from "./review";
import type { RunResult } from "./run";

const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/final");
const CONDITIONS = ["ponytail", "grain", "gate", "checkers", "approach", "history", "bestof2"];

interface Run {
	task: string;
	condition: string;
	seed: number;
	hidden: number;
	merge: number | undefined;
	cost: number;
	minutes: number;
	fired: boolean;
	dir: string;
}

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);

/** Whether the condition's hook actually acted in this run, and any hook-side model cost. */
function hookActivity(condition: string, dir: string): { fired: boolean; extraCost: number } {
	switch (condition) {
		case "grain":
			return { fired: lines(path.join(dir, "grain.jsonl")).length > 0, extraCost: 0 };
		case "gate":
			return { fired: lines(path.join(dir, "gate.jsonl")).some(r => r.unobserved?.length > 0), extraCost: 0 };
		case "checkers":
			return { fired: lines(path.join(dir, "checkers.jsonl")).some(r => r.newFindings?.length > 0 || r.remaining?.length > 0), extraCost: 0 };
		case "approach": {
			const picks = lines(path.join(dir, "approach.jsonl")).filter(r => r.choice !== undefined);
			return { fired: picks.length > 0, extraCost: picks.reduce((a, r) => a + (r.pickerCost ?? 0), 0) };
		}
		case "history":
			return { fired: lines(path.join(dir, "history.jsonl")).length > 0, extraCost: 0 };
		default:
			return { fired: true, extraCost: 0 };
	}
}

const runs: Run[] = [];
for (const j of runDirs(runDir)) {
	const r = readJson<RunResult>(path.join(j.dir, "result.json"));
	if (r.setupFailed) continue;
	const reviews = readReviews(j.dir);
	const { fired, extraCost } = hookActivity(j.condition, j.dir);
	runs.push({
		task: j.task,
		condition: j.condition,
		seed: j.seed,
		hidden: r.hiddenPass ? 1 : 0,
		merge: reviews.length ? reviews.reduce((a, x) => a + x.score, 0) / reviews.length : undefined,
		cost: r.cost + extraCost,
		minutes: r.durationSec / 60,
		fired,
		dir: j.dir,
	});
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? (x >= 0 && d > 0 ? x.toFixed(d) : x.toFixed(d)) : "-");
const signed = (x: number, d = 2) => (Number.isFinite(x) ? `${x > 0 ? "+" : ""}${x.toFixed(d)}` : "-");

function rng(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function bootstrapCI(d: number[], reps = 10_000): [number, number] {
	const rand = rng(11);
	const ms: number[] = [];
	for (let r = 0; r < reps; r++) {
		let s = 0;
		for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]!;
		ms.push(s / d.length);
	}
	ms.sort((a, b) => a - b);
	return [ms[Math.floor(0.025 * reps)]!, ms[Math.floor(0.975 * reps)]!];
}
/** Two-sided sign-flip permutation test of mean(d) = 0. */
function permutationP(d: number[], reps = 20_000): number {
	if (d.length === 0) return NaN;
	const rand = rng(23);
	const obs = Math.abs(mean(d));
	let hits = 0;
	for (let r = 0; r < reps; r++) {
		let s = 0;
		for (const x of d) s += rand() < 0.5 ? -x : x;
		if (Math.abs(s / d.length) >= obs - 1e-12) hits++;
	}
	return (hits + 1) / (reps + 1);
}
function holm(ps: number[]): number[] {
	const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
	const adj = new Array<number>(ps.length);
	let running = 0;
	order.forEach(([p, i], rank) => {
		running = Math.max(running, Math.min(1, (ps.length - rank) * p));
		adj[i] = running;
	});
	return adj;
}

/** Per-task means of a measure for a set of runs. */
function taskMeans(rs: Run[], pick: (r: Run) => number | undefined): Map<string, number> {
	const out = new Map<string, number>();
	for (const [task, group] of Map.groupBy(rs, r => r.task)) {
		const vals = group.map(pick).filter((v): v is number => v !== undefined);
		if (vals.length) out.set(task, mean(vals));
	}
	return out;
}
function paired(a: Map<string, number>, b: Map<string, number>, only?: Set<string>): number[] {
	return [...a.keys()].filter(t => b.has(t) && (!only || only.has(t))).map(t => a.get(t)! - b.get(t)!);
}

const base = runs.filter(r => r.condition === "off");
const baseMerge = taskMeans(base, r => r.merge);
const baseHidden = taskMeans(base, r => r.hidden);
const baseCost = mean(base.map(r => r.cost));
const baseMin = mean(base.map(r => r.minutes));

const out: string[] = [`# Final run report: ${path.relative(ROOT, runDir)}`, ""];
out.push(
	`Runs scored: ${runs.length} (baseline ${base.length}). Merge cost = mean of ${Math.round(mean(runs.filter(r => r.merge !== undefined).map(r => readReviews(r.dir).length)))} reviews per run; lower is better.`,
	"",
	"| Condition | Runs | Hidden tests pass | Mean merge cost | Hook acted in | Cost per run | Minutes per run |",
	"|---|---|---|---|---|---|---|",
);
for (const c of ["off", ...CONDITIONS]) {
	const rs = runs.filter(r => r.condition === c);
	if (!rs.length) continue;
	const fired = c === "off" ? "-" : `${Math.round((100 * rs.filter(r => r.fired).length) / rs.length)}%`;
	out.push(`| ${c} | ${rs.length} | ${Math.round(100 * mean(rs.map(r => r.hidden)))}% | ${fmt(mean(rs.filter(r => r.merge !== undefined).map(r => r.merge!)))} | ${fired} | $${fmt(mean(rs.map(r => r.cost)))} (${fmt(mean(rs.map(r => r.cost)) / baseCost)}x) | ${fmt(mean(rs.map(r => r.minutes)), 1)} (${fmt(mean(rs.map(r => r.minutes)) / baseMin)}x) |`);
}

// Primary and secondary comparisons.
const rows: { c: string; d: number[]; ci: [number, number]; p: number; better: number; worse: number; hd: number[]; hci: [number, number]; firedD: number[]; firedTasks: number }[] = [];
for (const c of CONDITIONS) {
	const rs = runs.filter(r => r.condition === c);
	if (!rs.length) continue;
	const d = paired(taskMeans(rs, r => r.merge), baseMerge);
	const hd = paired(taskMeans(rs, r => r.hidden), baseHidden);
	const firedTasks = new Set([...Map.groupBy(rs, r => r.task)].filter(([, g]) => g.filter(r => r.fired).length >= Math.min(2, g.length)).map(([t]) => t));
	rows.push({
		c,
		d,
		ci: bootstrapCI(d),
		p: permutationP(d),
		better: d.filter(x => x < -1e-9).length,
		worse: d.filter(x => x > 1e-9).length,
		hd,
		hci: bootstrapCI(hd),
		firedD: paired(taskMeans(rs, r => r.merge), baseMerge, firedTasks),
		firedTasks: firedTasks.size,
	});
}
const adj = holm(rows.map(r => r.p));
// Noise reference: baseline runs 1-3 vs 4-6.
const half = (lo: number, hi: number) => taskMeans(base.filter(r => r.seed >= lo && r.seed <= hi), r => r.merge);
const noise = paired(half(4, 6), half(1, 3));
const noiseHidden = paired(taskMeans(base.filter(r => r.seed >= 4), r => r.hidden), taskMeans(base.filter(r => r.seed <= 3), r => r.hidden));

out.push(
	"",
	"## Merge cost vs baseline (task means; negative = better than baseline)",
	"",
	"| Comparison | Tasks | Mean difference | 95% CI | Tasks better / worse / equal | p (permutation) | p (Holm) | Hook-acted tasks: mean difference |",
	"|---|---|---|---|---|---|---|---|",
	...rows.map((r, i) => `| ${r.c} − off | ${r.d.length} | ${signed(mean(r.d))} | [${signed(r.ci[0])}, ${signed(r.ci[1])}] | ${r.better} / ${r.worse} / ${r.d.length - r.better - r.worse} | ${fmt(r.p, 3)} | ${fmt(adj[i]!, 3)} | ${signed(mean(r.firedD))} (${r.firedTasks} tasks) |`),
	`| noise: off runs 4-6 − runs 1-3 | ${noise.length} | ${signed(mean(noise))} | [${signed(bootstrapCI(noise)[0])}, ${signed(bootstrapCI(noise)[1])}] | ${noise.filter(x => x < 0).length} / ${noise.filter(x => x > 0).length} / ${noise.filter(x => x === 0).length} | ${fmt(permutationP(noise), 3)} | - | - |`,
	"",
	"## Hidden-test pass rate vs baseline (percentage points)",
	"",
	"| Comparison | Mean difference | 95% CI |",
	"|---|---|---|",
	...rows.map(r => `| ${r.c} − off | ${signed(100 * mean(r.hd), 1)} | [${signed(100 * r.hci[0], 1)}, ${signed(100 * r.hci[1], 1)}] |`),
	`| noise: off runs 4-6 − runs 1-3 | ${signed(100 * mean(noiseHidden), 1)} | [${signed(100 * bootstrapCI(noiseHidden)[0], 1)}, ${signed(100 * bootstrapCI(noiseHidden)[1], 1)}] |`,
);

// Verdicts per the pre-registered rule (diff reading still required for "works").
out.push("", "## Statistical verdict (before diff reading)", "", "| Condition | Verdict |", "|---|---|");
rows.forEach((r, i) => {
	const verdict =
		r.ci[1] < 0 && adj[i]! < 0.05 && r.hci[0] > -0.05
			? "candidate: works (needs diff confirmation)"
			: r.ci[0] > 0 || r.hci[1] < 0
				? "harmful"
				: "no detectable effect";
	out.push(`| ${r.c} | ${verdict} |`);
});

// Diffs to read: per condition, 4 most improved and 2 most worsened tasks.
const toRead: Record<string, { task: string; delta: number; condRun: string; baseRun: string }[]> = {};
for (const c of CONDITIONS) {
	const rs = runs.filter(r => r.condition === c && r.merge !== undefined);
	if (!rs.length) continue;
	const cm = taskMeans(rs, r => r.merge);
	const deltas = [...cm.keys()].filter(t => baseMerge.has(t)).map(t => ({ task: t, delta: cm.get(t)! - baseMerge.get(t)! }));
	deltas.sort((a, b) => a.delta - b.delta);
	const chosen = [...deltas.slice(0, 4), ...deltas.slice(-2).reverse()].filter((x, i, arr) => arr.findIndex(y => y.task === x.task) === i);
	toRead[c] = chosen.map(({ task, delta }) => {
		const condRuns = rs.filter(r => r.task === task).sort((a, b) => Math.abs(a.merge! - cm.get(task)!) - Math.abs(b.merge! - cm.get(task)!));
		const baseRuns = base.filter(r => r.task === task && r.merge !== undefined).sort((a, b) => a.merge! - b.merge!);
		const median = baseRuns[Math.floor((baseRuns.length - 1) / 2)]!;
		return { task, delta, condRun: path.relative(runDir, condRuns[0]!.dir), baseRun: path.relative(runDir, median.dir) };
	});
}

fs.writeFileSync(path.join(runDir, "REPORT.md"), `${out.join("\n")}\n`);
writeJson(path.join(runDir, "diffs-to-read.json"), toRead);
process.stdout.write(`${out.join("\n")}\n`);
