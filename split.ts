/**
 * Split tasks into a development set (tasks that can tell conditions apart) and a holdout set.
 *
 *   bun split.ts runs/main [--conditions off,ponytail]
 *
 * Criterion (after p1, arXiv 2604.08801): a task is discriminative when its merge-cost scores vary more
 * between conditions than repeat runs of the same condition would explain, i.e.
 * k * Var(condition means) > mean within-condition variance (k = runs per condition).
 * Writes splits.json. The holdout set is what the criterion rejects, so it is a weak check;
 * freshly harvested tasks make a better confirmation set.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, arg, readJson, runDirs, writeJson } from "./lib";
import type { Review } from "./review";

const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/main");
const only = arg("conditions")?.split(",");

const variance = (xs: number[]) => {
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
};

const scores = new Map<string, Map<string, number[]>>();
for (const job of runDirs(runDir)) {
	if (only && !only.includes(job.condition)) continue;
	const file = path.join(job.dir, "review.json");
	if (!fs.existsSync(file)) continue;
	const byCondition = scores.get(job.task) ?? new Map<string, number[]>();
	byCondition.set(job.condition, [...(byCondition.get(job.condition) ?? []), readJson<Review>(file).score]);
	scores.set(job.task, byCondition);
}

const perTask: Record<string, { ratio: number; between: number; within: number; scores: Record<string, number[]> }> = {};
for (const [task, byCondition] of scores) {
	const groups = [...byCondition.values()].filter(s => s.length >= 2);
	if (groups.length < 2) continue;
	const k = Math.min(...groups.map(g => g.length));
	const within = groups.map(variance).reduce((a, b) => a + b, 0) / groups.length;
	const between = variance(groups.map(g => g.reduce((a, b) => a + b, 0) / g.length));
	const ratio = within === 0 ? (between > 0 ? Infinity : 0) : (k * between) / within;
	perTask[task] = { ratio, between, within, scores: Object.fromEntries(byCondition) };
}

const tasks = Object.keys(perTask).sort();
const dev = tasks.filter(t => perTask[t]!.ratio > 1);
const holdout = tasks.filter(t => perTask[t]!.ratio <= 1);
writeJson(path.join(ROOT, "splits.json"), {
	criterion: "k * Var(condition means) > mean within-condition variance of merge cost",
	source: path.relative(ROOT, runDir),
	conditions: only ?? "all with >=2 runs",
	dev,
	holdout,
	perTask,
});
console.log(`dev ${dev.length} tasks, holdout ${holdout.length} tasks -> splits.json`);
for (const t of tasks) {
	const p = perTask[t]!;
	console.log(`${p.ratio > 1 ? "dev    " : "holdout"} ${t}  ratio=${Number.isFinite(p.ratio) ? p.ratio.toFixed(2) : "inf"}  ${JSON.stringify(p.scores)}`);
}
