/**
 * Shared loader for the phase 1 replay: every stored run with its labels (reviews, hidden tests,
 * cause labels) and its features (Jev answers, hard checks when present).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Cause, LabeledComment } from "./causes";
import type { CrossResult, RunChecks } from "./checks";
import type { JevFeatures } from "./discover";
import { ROOT, readJson, runDirs } from "./lib";
import { readReviews } from "./review";
import type { RunResult } from "./run";

export const BAD = 4;

export interface Run {
	task: string;
	condition: string;
	seed: number;
	name: string;
	dir: string;
	merge: number;
	hidden: boolean;
	bad: boolean;
	cost: number;
	/** Source lines added + removed. */
	srcLines: number;
	causes: Set<Cause | "scope_other" | "missing_any">;
	majorCauses: Set<Cause | "scope_other" | "missing_any">;
	jev: JevFeatures;
	checks?: RunChecks;
}

export function loadRuns(runDir = path.join(ROOT, "runs/final")): Run[] {
	const labels = Map.groupBy(readJson<LabeledComment[]>(path.join(ROOT, "replay", "causes.json")), c => c.run);
	return runDirs(runDir)
		.filter(j => j.condition !== "bestof2")
		.map(j => {
			const rel = path.relative(runDir, j.dir);
			const reviews = readReviews(j.dir);
			const result = readJson<RunResult>(path.join(j.dir, "result.json"));
			const merge = reviews.reduce((a, r) => a + r.score, 0) / reviews.length;
			const causes = new Set<Run["causes"] extends Set<infer T> ? T : never>();
			const majorCauses = new Set<Run["causes"] extends Set<infer T> ? T : never>();
			for (const c of labels.get(rel) ?? []) {
				if (c.severity === "nit") continue;
				const tags = [c.cause, ...(c.category === "scope" && c.cause !== "stray_artifact" ? ["scope_other" as const] : []), ...(c.category === "missing" || c.cause === "missing_requirement" ? ["missing_any" as const] : [])];
				for (const t of tags) {
					causes.add(t);
					if (c.severity === "major" || c.severity === "blocker") majorCauses.add(t);
				}
			}
			const name = `${j.condition}-s${j.seed}`;
			const checksFile = path.join(ROOT, "replay", "checks", j.task, `${name}.json`);
			return {
				task: j.task,
				condition: j.condition,
				seed: j.seed,
				name,
				dir: j.dir,
				merge,
				hidden: result.hiddenPass,
				bad: merge >= BAD,
				cost: result.cost,
				srcLines: result.src.added + result.src.removed,
				causes,
				majorCauses,
				jev: readJson<JevFeatures>(path.join(ROOT, "replay", "jev", j.task, `${name}.json`)),
				checks: fs.existsSync(checksFile) ? readJson<RunChecks>(checksFile) : undefined,
			};
		});
}

export function loadCross(task: string): CrossResult[] {
	const file = path.join(ROOT, "replay", "checks", task, "cross.json");
	return fs.existsSync(file) ? readJson<CrossResult[]>(file) : [];
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Area under the ROC curve of `score` for binary `label` (ties count half). */
export function auroc(score: number[], label: boolean[]): number {
	const pos = score.filter((_, i) => label[i]);
	const neg = score.filter((_, i) => !label[i]);
	if (!pos.length || !neg.length) return NaN;
	let s = 0;
	for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
	return s / (pos.length * neg.length);
}

/** Within-task concordance: among same-task pairs whose merge cost differs by >= 1, how often the higher-risk run is the worse one. */
export function withinTask(runs: Run[], risk: (r: Run) => number): { concordance: number; pairs: number } {
	let s = 0;
	let n = 0;
	for (const group of Map.groupBy(runs, r => r.task).values()) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i]!;
				const b = group[j]!;
				if (Math.abs(a.merge - b.merge) < 1) continue;
				const [worse, better] = a.merge > b.merge ? [a, b] : [b, a];
				const rw = risk(worse);
				const rb = risk(better);
				s += rw > rb ? 1 : rw === rb ? 0.5 : 0;
				n++;
			}
		}
	}
	return { concordance: n ? s / n : NaN, pairs: n };
}

/** Expected calibration error of probabilities `p` against binary `label`, 10 equal-width bins. */
export function ece(p: number[], label: boolean[]): number {
	let e = 0;
	for (let b = 0; b < 10; b++) {
		const idx = p.map((x, i) => [x, i] as const).filter(([x]) => (b === 9 ? x >= 0.9 : x >= b / 10 && x < (b + 1) / 10)).map(([, i]) => i);
		if (!idx.length) continue;
		e += (idx.length / p.length) * Math.abs(mean(idx.map(i => p[i]!)) - mean(idx.map(i => (label[i] ? 1 : 0))));
	}
	return e;
}

export function rng(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** 95% bootstrap CI over tasks of a per-task statistic's mean. */
export function taskBootstrap(perTask: number[], reps = 5000): [number, number] {
	const rand = rng(11);
	const ms: number[] = [];
	for (let r = 0; r < reps; r++) {
		let s = 0;
		for (let i = 0; i < perTask.length; i++) s += perTask[Math.floor(rand() * perTask.length)]!;
		ms.push(s / perTask.length);
	}
	ms.sort((a, b) => a - b);
	return [ms[Math.floor(0.025 * reps)]!, ms[Math.floor(0.975 * reps)]!];
}
