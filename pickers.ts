/**
 * Phase 1 picker replay: how well can each picker choose among a task's stored baseline attempts?
 *
 *   bun pickers.ts
 *
 * Pools: every pair and every group of 4 of a task's 6 baseline attempts (15 each per task), plus
 * the exact pairs (bestof2) and groups (replay/opus4) Opus judged. Weighted pickers are
 * cross-fitted: a task is scored with weights fitted on the other half of the tasks
 * (splits.json dev/holdout). Writes replay/PICKERS.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CrossResult } from "./checks";
import { type Run, loadCross, loadRuns, mean, taskBootstrap } from "./data";
import { ROOT, readJson } from "./lib";
import { QUESTIONS, risk } from "./qreport";
import { COMPOSITE } from "./select";

const JEV_KEYS = Object.keys(QUESTIONS).map(q => `j_${q}`);
const HARD_KEYS = ["regress", "ownFail", "crossFail", "crossBroken", "stray", "checker", "size"];

type Features = Record<string, number>;
const crossByTask = new Map<string, CrossResult[]>();

function features(c: Run, pool: Run[]): Features {
	const ch = c.checks!;
	const cross = crossByTask.get(c.task) ?? [];
	const donors = cross.filter(x => x.tree === c.name && x.tests !== c.name && pool.some(p => p.name === x.tests));
	const total = donors.reduce((a, d) => a + d.total, 0);
	const failed = donors.reduce((a, d) => a + d.failed, 0);
	return {
		regress: ch.suite.regressions.length ? 1 : 0,
		ownFail: ch.suite.ownFailed ? 1 : 0,
		crossFail: total ? failed / total : 0,
		crossBroken: donors.length ? donors.filter(d => d.total === 0 && d.exitCode !== 0).length / donors.length : 0,
		stray: ch.stray.files.length ? 1 : 0,
		checker: Math.log1p(ch.checker.count),
		size: Math.log1p(c.srcLines),
		...Object.fromEntries(Object.keys(QUESTIONS).map(q => [`j_${q}`, risk(c.jev, q)])),
	};
}

interface Model {
	keys: string[];
	mu: number[];
	sd: number[];
	w: number[];
}
const z = (m: Model, f: Features) => m.keys.map((k, i) => (f[k]! - m.mu[i]!) / m.sd[i]!);
/** Higher = worse. */
const score = (m: Model, f: Features) => z(m, f).reduce((a, x, i) => a + x * m.w[i]!, 0);

/** Pairwise logistic regression (L2) on same-task pairs whose merge cost differs by >= 0.5. */
function fit(tasks: Run[][], keys: string[], lambda = 5): Model {
	const all = tasks.flatMap(group => group.map(c => features(c, group)));
	const mu = keys.map(k => mean(all.map(f => f[k]!)));
	const sd = keys.map((k, i) => Math.sqrt(mean(all.map(f => (f[k]! - mu[i]!) ** 2))) || 1);
	const m: Model = { keys, mu, sd, w: keys.map(() => 0) };
	const pairs: { x: number[]; y: number }[] = [];
	for (const group of tasks) {
		const fs_ = group.map(c => z(m, features(c, group)));
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				if (Math.abs(group[i]!.merge - group[j]!.merge) < 0.5) continue;
				pairs.push({ x: fs_[i]!.map((v, k) => v - fs_[j]![k]!), y: group[i]!.merge > group[j]!.merge ? 1 : 0 });
			}
		}
	}
	for (let it = 0; it < 3000; it++) {
		const g = m.w.map(w => lambda * w);
		for (const p of pairs) {
			const s = p.x.reduce((a, v, k) => a + v * m.w[k]!, 0);
			const e = 1 / (1 + Math.exp(-s)) - p.y;
			p.x.forEach((v, k) => (g[k]! += e * v));
		}
		m.w = m.w.map((w, k) => w - (0.5 / pairs.length) * g[k]!);
	}
	return m;
}

interface Outcome {
	merge: number;
	bad: number;
	hiddenFail: number;
}
/** Outcome of picking the lowest-scored candidate; ties are averaged (a fair coin among them). */
function pickBy(pool: Run[], s: (c: Run) => number): Outcome {
	const scores = pool.map(s);
	const best = Math.min(...scores);
	const tied = pool.filter((_, i) => scores[i]! - best < 1e-9);
	return outcome(tied);
}
const outcome = (rs: Run[]): Outcome => ({ merge: mean(rs.map(r => r.merge)), bad: mean(rs.map(r => (r.bad ? 1 : 0))), hiddenFail: mean(rs.map(r => (r.hidden ? 0 : 1))) });

function subsets<T>(xs: T[], k: number): T[][] {
	if (k === 0) return [[]];
	if (xs.length < k) return [];
	const [h, ...t] = xs;
	return [...subsets(t, k - 1).map(s => [h!, ...s]), ...subsets(t, k)];
}

// ---- data ----
const runs = loadRuns().filter(r => r.condition === "off");
const doneTasks = new Set(fs.readdirSync(path.join(ROOT, "replay", "checks")).filter(t => fs.existsSync(path.join(ROOT, "replay", "checks", t, "done"))));
const byTask = new Map([...Map.groupBy(runs.filter(r => doneTasks.has(r.task) && r.checks), r => r.task)].filter(([, g]) => g.length === 6));
for (const t of byTask.keys()) crossByTask.set(t, loadCross(t));
const splits = readJson<{ dev: string[]; holdout: string[] }>(path.join(ROOT, "splits.json"));
const foldOf = (t: string) => (splits.dev.includes(t) ? 0 : 1);
const trainTasks = (fold: number) => [...byTask].filter(([t]) => foldOf(t) !== fold).map(([, g]) => g);
const models = [0, 1].map(fold => ({
	hard: fit(trainTasks(fold), HARD_KEYS),
	jev: fit(trainTasks(fold), JEV_KEYS),
	all: fit(trainTasks(fold), [...HARD_KEYS, ...JEV_KEYS]),
}));

type Picker = (pool: Run[], task: string) => Outcome;
const fitted = (which: "hard" | "jev" | "all"): Picker => (pool, task) => {
	const m = models[foldOf(task)]![which];
	return pickBy(pool, c => score(m, features(c, pool)));
};
const hardRule: Picker = pool =>
	pickBy(pool, c => {
		const f = features(c, pool);
		return 1000 * (f.regress! + f.ownFail!) + 100 * f.stray! + 10 * (f.crossFail! + f.crossBroken!) + 0.01 * f.checker!;
	});
const PICKERS: Record<string, Picker> = {
	random: pool => outcome(pool),
	"smallest diff": pool => pickBy(pool, c => c.srcLines),
	"hard checks (rule)": hardRule,
	"hard checks (fitted)": fitted("hard"),
	"Jev (fixed, unweighted)": pool => pickBy(pool, c => mean(COMPOSITE.map(q => risk(c.jev, q)))),
	"Jev (fitted)": fitted("jev"),
	"hard filter, then Jev (fixed)": pool =>
		pickBy(pool, c => {
			const f = features(c, pool);
			return 10 * (f.regress! + f.ownFail! + f.stray!) + mean(COMPOSITE.map(q => risk(c.jev, q)));
		}),
	"hard + Jev (fitted)": fitted("all"),
	oracle: pool => outcome([pool.reduce((a, b) => (b.merge < a.merge ? b : a))]),
};

interface Row {
	name: string;
	perTask: Map<string, Outcome>;
}
function evaluate(pools: Map<string, Run[][]>, pickers: Record<string, Picker>): Row[] {
	return Object.entries(pickers).map(([name, p]) => ({
		name,
		perTask: new Map([...pools].map(([task, ps]) => {
			const os = ps.map(pool => p(pool, task));
			return [task, { merge: mean(os.map(o => o.merge)), bad: mean(os.map(o => o.bad)), hiddenFail: mean(os.map(o => o.hiddenFail)) }];
		})),
	}));
}
const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
function table(title: string, rows: Row[], extra: Record<string, string> = {}): string[] {
	const rand = rows.find(r => r.name === "random")!;
	const orc = rows.find(r => r.name === "oracle")!;
	const tasks = [...rand.perTask.keys()];
	const m = (r: Row, k: keyof Outcome) => mean(tasks.map(t => r.perTask.get(t)![k]));
	const out = [
		`### ${title}`,
		"",
		"| Picker | Mean merge cost | Captured of possible gain | vs random: Δ merge (95% CI over tasks) | Bad picks (merge ≥ 4) | Hidden-test fails | Notes |",
		"|---|---|---|---|---|---|---|",
	];
	for (const r of rows) {
		const d = tasks.map(t => r.perTask.get(t)!.merge - rand.perTask.get(t)!.merge);
		const ci = taskBootstrap(d);
		const cap = (m(rand, "merge") - m(r, "merge")) / (m(rand, "merge") - m(orc, "merge"));
		out.push(
			`| ${r.name} | ${f2(m(r, "merge"))} | ${r.name === "random" ? "0%" : `${Math.round(100 * cap)}%`} | ${r.name === "random" ? "-" : `${f2(mean(d))} [${f2(ci[0])}, ${f2(ci[1])}]`} | ${pct(m(r, "bad"))} | ${pct(m(r, "hiddenFail"))} | ${extra[r.name] ?? ""} |`,
		);
	}
	return out;
}

const lines: string[] = [
	"# Picker replay (phase 1)",
	"",
	`Tasks with complete hard checks: ${byTask.size} of 30. Candidates are each task's 6 baseline attempts; merge cost is the mean of two Sonnet reviews (+4 if hidden tests fail). Weighted pickers are cross-fitted across the dev/holdout task halves. "Captured" = (random − picker) / (random − oracle).`,
	"",
];

// All pairs and groups of 4.
for (const k of [2, 4]) {
	const pools = new Map([...byTask].map(([t, g]) => [t, subsets(g, k)]));
	lines.push(...table(`Every group of ${k} (${[...pools.values()].reduce((a, p) => a + p.length, 0)} pools)`, evaluate(pools, PICKERS)), "");
}

// The exact pools Opus judged.
const opusPairs = new Map<string, { pool: Run[]; order1?: string; order2?: string }[]>();
for (const [t, g] of byTask) {
	const list = [1, 2, 3].flatMap(k => {
		const f = path.join(ROOT, "runs/final", t, `bestof2-s${k}`, "pick.json");
		if (!fs.existsSync(f)) return [];
		const p = readJson<{ pair: string[]; order1?: string; order2?: string }>(f);
		return [{ pool: p.pair.map(n => g.find(r => r.name === n)!), order1: p.order1, order2: p.order2 }];
	});
	if (list.length) opusPairs.set(t, list);
}
const opusQuads = new Map<string, { pool: Run[]; order1?: string; order2?: string }[]>();
for (const [t, g] of byTask) {
	const list = [1, 2].flatMap(k => {
		const f = path.join(ROOT, "replay", "opus4", t, `g${k}.json`);
		if (!fs.existsSync(f)) return [];
		const p = readJson<{ group: string[]; order1?: string; order2?: string }>(f);
		return [{ pool: p.group.map(n => g.find(r => r.name === n)!), order1: p.order1, order2: p.order2 }];
	});
	if (list.length) opusQuads.set(t, list);
}
for (const [label, judged] of [["pairs Opus judged", opusPairs], ["groups of 4 Opus judged", opusQuads]] as const) {
	if (!judged.size) continue;
	const pools = new Map([...judged].map(([t, l]) => [t, l.map(x => x.pool)]));
	const opusFor = (pool: Run[], order: "order1" | "order2") => judged.get(pool[0]!.task)!.find(x => x.pool === pool)![order];
	const opus: Picker = pool => {
		const n = opusFor(pool, "order1");
		return n ? outcome([pool.find(r => r.name === n)!]) : outcome(pool);
	};
	// Escalation: a cheap picker decides unless its top two candidates are among the closest `share`
	// of calls; then Opus decides. Thresholds come from the picker's own gap distribution (no labels).
	const fittedGap = (pool: Run[], task: string) => {
		const m = models[foldOf(task)]!.all;
		const s = pool.map(c => score(m, features(c, pool))).sort((a, b) => a - b);
		return s[1]! - s[0]!;
	};
	// The pipeline rule (select.ts): drop hard-check failures and rank survivors by the composite.
	// Opus judged the whole pool; if it picked a dropped attempt, the composite's pick stands.
	const survivorsOf = (pool: Run[]) => {
		const pass = pool.filter(c => {
			const f = features(c, pool);
			return !(f.regress! + f.ownFail! + f.stray!);
		});
		return (pass.length ? pass : pool).map(c => ({ c, s: mean(COMPOSITE.map(q => risk(c.jev, q))) })).sort((a, b) => a.s - b.s);
	};
	const pipelineGap = (pool: Run[]) => {
		const sv = survivorsOf(pool);
		return sv.length > 1 ? sv[1]!.s - sv[0]!.s : Number.POSITIVE_INFINITY;
	};
	const allPools = [...pools].flatMap(([t, ps]) => ps.map(pool => ({ t, pool })));
	const threshold = (gapOf: (pool: Run[], task: string) => number, share: number) => {
		const gs = allPools.map(({ t, pool }) => gapOf(pool, t)).sort((a, b) => a - b);
		return gs[Math.min(gs.length - 1, Math.floor(share * gs.length))]!;
	};
	const rate = (gapOf: (pool: Run[], task: string) => number, th: number) => mean(allPools.map(({ t, pool }) => (gapOf(pool, t) < th ? 1 : 0)));
	const escalatedFitted = (th: number): Picker => (pool, task) => (fittedGap(pool, task) < th ? opus(pool, task) : fitted("all")(pool, task));
	const pipeline = (th: number): Picker => (pool, task) => {
		const sv = survivorsOf(pool);
		if (pipelineGap(pool) < th) {
			const hit = sv.find(x => x.c.name === opusFor(pool, "order1"));
			if (hit) return outcome([hit.c]);
		}
		return pickBy(sv.map(x => x.c), c => sv.find(x => x.c === c)!.s);
	};
	const orderAgree = mean([...judged.values()].flat().map(x => (x.order1 && x.order1 === x.order2 ? 1 : 0)));
	const pickers: Record<string, Picker> = { ...PICKERS, "Opus (one call)": opus };
	const notes: Record<string, string> = { "Opus (one call)": `orders agree on ${Math.round(100 * orderAgree)}% of pools` };
	for (const share of [0.25, 0.5]) {
		const tf = threshold(fittedGap, share);
		const tp = threshold((pool: Run[]) => pipelineGap(pool), share);
		const fName = `hard + Jev (fitted), Opus on closest ${share * 100}%`;
		const pName = `pipeline: hard filter, Jev (fixed), Opus on closest ${share * 100}%`;
		pickers[fName] = escalatedFitted(tf);
		pickers[pName] = pipeline(tp);
		notes[fName] = `Opus called on ${Math.round(100 * rate(fittedGap, tf))}%`;
		notes[pName] = `Opus called on ${Math.round(100 * rate((pool: Run[]) => pipelineGap(pool), tp))}%`;
	}
	lines.push(...table(`The ${label} (${[...pools.values()].reduce((a, p) => a + p.length, 0)} pools)`, evaluate(pools, pickers), notes), "");
}

// Risk-based spending: draw attempts in order, stop once the best so far looks safe (score < tau).
const perms = (xs: Run[]): Run[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p])));
const trainScores = [0, 1].map(fold => trainTasks(fold).flatMap(g => g.map(c => score(models[fold]!.all, features(c, g)))).sort((a, b) => a - b));
const quantile = (fold: number, q: number) => trainScores[fold]![Math.min(trainScores[fold]!.length - 1, Math.floor(q * trainScores[fold]!.length))]!;
lines.push(
	"### Spending by risk (draw attempts until the best one looks safe, up to 4)",
	"",
	"Threshold = quantile of the fitted risk score on training-half candidates (stop when the best drawn candidate scores below it). Every ordering of each task's 6 attempts is simulated.",
	"",
	"| Policy | Mean attempts | Mean merge cost | Bad picks (merge ≥ 4) | Hidden-test fails |",
	"|---|---|---|---|---|",
);
const policies: { name: string; q?: number; k?: number }[] = [
	{ name: "always 1", k: 1 },
	{ name: "always 2", k: 2 },
	{ name: "always 3", k: 3 },
	{ name: "always 4", k: 4 },
	...[0.3, 0.5, 0.7, 0.85].map(q => ({ name: `stop below the ${Math.round(q * 100)}th percentile of risk`, q })),
];
for (const pol of policies) {
	const perTask = [...byTask].map(([t, g]) => {
		const m = models[foldOf(t)]!.all;
		const results = perms(g).map(order => {
			const drawn = [order[0]!];
			if (pol.k) drawn.push(...order.slice(1, pol.k));
			else {
				const tau = quantile(foldOf(t), pol.q!);
				while (drawn.length < 4 && Math.min(...drawn.map(c => score(m, features(c, drawn)))) >= tau) drawn.push(order[drawn.length]!);
			}
			return { n: drawn.length, o: drawn.length === 1 ? outcome(drawn) : pickBy(drawn, c => score(m, features(c, drawn))) };
		});
		return { n: mean(results.map(r => r.n)), merge: mean(results.map(r => r.o.merge)), bad: mean(results.map(r => r.o.bad)), hf: mean(results.map(r => r.o.hiddenFail)) };
	});
	lines.push(`| ${pol.name} | ${f2(mean(perTask.map(x => x.n)))} | ${f2(mean(perTask.map(x => x.merge)))} | ${pct(mean(perTask.map(x => x.bad)))} | ${pct(mean(perTask.map(x => x.hf)))} |`);
}

// What the fitted model weights (fold 0 and fold 1).
lines.push("", "### Largest weights in the fitted hard + Jev picker (standardized; positive = riskier)", "", "| Feature | Fold A weight | Fold B weight |", "|---|---|---|");
const m0 = models[0]!.all;
const m1 = models[1]!.all;
m0.keys
	.map((k, i) => ({ k, a: m0.w[i]!, b: m1.w[i]! }))
	.sort((x, y) => Math.abs(y.a + y.b) - Math.abs(x.a + x.b))
	.slice(0, 15)
	.forEach(r => lines.push(`| ${r.k} | ${r.a >= 0 ? "+" : ""}${f2(r.a)} | ${r.b >= 0 ? "+" : ""}${f2(r.b)} |`));

fs.writeFileSync(path.join(ROOT, "replay", "PICKERS.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
