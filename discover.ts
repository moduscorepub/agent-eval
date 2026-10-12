/**
 * Ask the Jev question bank about every stored run (cached, so re-runs are free).
 *
 *   bun discover.ts runs/final [--robustness]
 *
 * Writes replay/jev/<task>/<cond>-s<n>.json: {change, reuse, files} answers as numbers in [0, 1]
 * (Noul probability; Score position scaled to 0..1, higher = more of the last level).
 * --robustness also writes replay/jev-robustness.json: planted-claim shifts on 100 runs and
 * repeat-call differences on 50 runs (live, uncached).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Answer, type Question, jev, jevSpend } from "./jev";
import { CHANGE_QUESTIONS, REUSE_QUESTIONS, changeState, fileQuestion, otherFiles, plant, reuseState, splitDiff } from "./jevq";
import { type Task, ROOT, pool, readJson, runDirs, writeJson } from "./lib";

export interface JevFeatures {
	change: Record<string, number>;
	reuse: Record<string, number>;
	files: { path: string; generated: number }[];
	tokens: number;
	ms: number;
}

export const value = (a: Answer, q: Question): number =>
	a.type === "noul" ? a.noul! : a.type === "score" ? a.score! / ((q as { criteria: unknown[] }).criteria.length - 1) : NaN;
const values = (answers: Record<string, Answer>, qs: Record<string, Question>) =>
	Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, value(answers[k]!, q)]));

export async function askAll(task: Task, diff: string, opts: { planted?: boolean; nocache?: boolean } = {}): Promise<JevFeatures> {
	let files = splitDiff(diff);
	if (opts.planted) files = plant(files);
	const others = otherFiles(files);
	const reuse = reuseState(task, files);
	const [c, r, f] = await Promise.all([
		jev(changeState(task.statement, files), CHANGE_QUESTIONS, opts),
		reuse.new_code.length ? jev(reuse, REUSE_QUESTIONS, opts) : undefined,
		others.length
			? jev(
					{ issue: task.statement, files: others.map(o => ({ path: o.path, status: o.status, diff: o.diff.slice(0, 3000) })) },
					Object.fromEntries(others.map((_, i) => [`f${i}`, fileQuestion(i)])),
					opts,
				)
			: undefined,
	]);
	return {
		change: values(c.answers, CHANGE_QUESTIONS),
		reuse: r ? values(r.answers, REUSE_QUESTIONS) : { reimplements: 0 },
		files: others.map((o, i) => ({ path: o.path, generated: f!.answers[`f${i}`]!.noul! })),
		tokens: c.inputTokens + (r?.inputTokens ?? 0) + (f?.inputTokens ?? 0),
		ms: Math.max(c.ms, r?.ms ?? 0, f?.ms ?? 0),
	};
}

if (import.meta.main) {
	const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/final");
	const out = path.join(ROOT, "replay", "jev");
	const runs = runDirs(runDir).filter(j => j.condition !== "bestof2");
	const tasks = new Map<string, Task>();
	const taskOf = (id: string) => tasks.get(id) ?? tasks.set(id, readJson<Task>(path.join(ROOT, "tasks", `${id}.json`))).get(id)!;
	let done = 0;
	await pool(runs, 6, async j => {
		const file = path.join(out, j.task, `${j.condition}-s${j.seed}.json`);
		if (fs.existsSync(file)) return;
		const features = await askAll(taskOf(j.task), fs.readFileSync(path.join(j.dir, "patch.diff"), "utf8"));
		writeJson(file, features);
		if (++done % 100 === 0) console.log(`${done} runs asked`);
	});
	console.log(`all runs asked; spend so far`, jevSpend());

	if (process.argv.includes("--robustness")) {
		// Deterministic sample: every 7th baseline/approach run for planting, every 14th for repeats.
		const pool2 = runs.filter(j => j.condition === "off" || j.condition === "approach").sort((a, b) => a.dir.localeCompare(b.dir));
		const plantSet = pool2.filter((_, i) => i % 7 === 0).slice(0, 100);
		const repeatSet = pool2.filter((_, i) => i % 14 === 3).slice(0, 50);
		const planted: { run: string; base: JevFeatures; planted: JevFeatures }[] = [];
		const repeats: { run: string; first: JevFeatures; second: JevFeatures }[] = [];
		await pool(plantSet, 6, async j => {
			const diff = fs.readFileSync(path.join(j.dir, "patch.diff"), "utf8");
			const base = readJson<JevFeatures>(path.join(out, j.task, `${j.condition}-s${j.seed}.json`));
			planted.push({ run: path.relative(runDir, j.dir), base, planted: await askAll(taskOf(j.task), diff, { planted: true }) });
		});
		await pool(repeatSet, 6, async j => {
			const diff = fs.readFileSync(path.join(j.dir, "patch.diff"), "utf8");
			const first = readJson<JevFeatures>(path.join(out, j.task, `${j.condition}-s${j.seed}.json`));
			repeats.push({ run: path.relative(runDir, j.dir), first, second: await askAll(taskOf(j.task), diff, { nocache: true }) });
		});
		writeJson(path.join(ROOT, "replay", "jev-robustness.json"), { planted, repeats });
		console.log(`robustness done; spend so far`, jevSpend());
	}
}
