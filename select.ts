/**
 * The pipeline's picker: choose one attempt from each set of candidates for a task.
 *
 *   bun select.ts runs/<out> [--condition seeded] [--tasks a,b] [--set-size 4]
 *                [--model anthropic/claude-opus-5-5] [--concurrency 2]
 *
 * Layers (phase 1 replay: replay/PHASE1.md):
 * 1. Hard checks (checks.ts): the visible suite (regressions and the attempt's own tests, each
 *    failure confirmed by an isolated re-run), new checker findings, stray runtime files, and every
 *    attempt's own tests run against the others in the set.
 * 2. Clearing: stray runtime files (the deterministic detector, or Jev's per-file "produced by running
 *    the program" >= 0.5) are cleared from the attempt's patch into patch.clean.diff. Clearing never
 *    changed a hidden-test result in the replay.
 * 3. Attempts whose patch does not apply, or that break visible tests, are dropped (unless all do).
 * 4. One Opus call reads the repository and the surviving patches in a shuffled order (Opus favours
 *    the first patch shown) and picks one. With more than 4 survivors, the 4 with the lowest Jev
 *    composite are shown. In the replay no cheap ranking (hard checks, Jev, or both) beat Opus.
 * Writes runs/<out>/<task>/pick-set<k>.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PROMPT as PICK_PROMPT, parsePick } from "./bestofk";
import { type RunChecks, checkTask } from "./checks";
import { rng } from "./data";
import { askAll } from "./discover";
import { jevSpend } from "./jev";
import { type Task, ROOT, arg, ensureBase, pool, readJson, readPatch, runAgent, runDirs, writeJson } from "./lib";
import { risk } from "./qreport";
import type { RunResult } from "./run";

/** Questions in the unweighted Jev composite (fixed before the phase 1 replay results). */
export const COMPOSITE = ["stray", "alt_unrequested_1", "missing", "alt_bug_1", "slow", "reimplements", "merge_ready"];

/** Reasons to drop an attempt outright. */
export const hardFailures = (c: RunChecks): string[] => [
	...(c.applied ? [] : ["patch did not apply"]),
	...(c.suite.regressions.length ? [`${c.suite.regressions.length} visible-suite regressions`] : []),
	...(c.suite.ownFailed ? [`${c.suite.ownFailed} of its own tests fail`] : []),
];

/** The patch without the given files' hunks. */
export const clearFiles = (diff: string, files: string[]) =>
	diff
		.split(/^(?=diff --git )/m)
		.filter(chunk => !files.some(f => chunk.startsWith(`diff --git a/${f} `)))
		.join("");

interface Candidate {
	name: string;
	hardFail: string[];
	stray: string[];
	composite: number;
	risks: Record<string, number>;
}

if (import.meta.main) {
	const runDir = path.resolve(ROOT, process.argv[2]!);
	const condition = arg("condition", "seeded")!;
	const setSize = Number(arg("set-size", "4"));
	const model = arg("model", "anthropic/claude-opus-5-5")!;
	const filter = arg("tasks")?.split(",");
	const jobs = [...Map.groupBy(runDirs(runDir).filter(j => j.condition === condition && (!filter || filter.includes(j.task))), j => `${j.task}|${Math.ceil(j.seed / setSize)}`)];
	await pool(jobs, Number(arg("concurrency", "2")), async ([key, members]) => {
		const [id, setNo] = key.split("|") as [string, string];
		const out = path.join(runDir, id, `pick-set${setNo}.json`);
		if (fs.existsSync(out)) return;
		const task = readJson<Task>(path.join(ROOT, "tasks", `${id}.json`));
		const runs = members.map(j => ({ name: `${j.condition}-s${j.seed}`, dir: j.dir, baseline: true }));
		const checksDir = path.join(runDir, id, `checks-set${setNo}`);
		await checkTask(task, runs, checksDir);
		const candidates: Candidate[] = await Promise.all(
			runs.map(async r => {
				const checks = readJson<RunChecks>(path.join(checksDir, `${r.name}.json`));
				const diff = fs.readFileSync(path.join(r.dir, "patch.diff"), "utf8");
				const jev = await askAll(task, diff);
				const stray = [...new Set([...checks.stray.files, ...jev.files.filter(f => f.generated >= 0.5).map(f => f.path)])].sort();
				fs.writeFileSync(path.join(r.dir, "patch.clean.diff"), clearFiles(diff, stray));
				const risks = Object.fromEntries(COMPOSITE.map(q => [q, risk(jev, q)]));
				return { name: r.name, hardFail: hardFailures(checks), stray, composite: Object.values(risks).reduce((a, b) => a + b, 0) / COMPOSITE.length, risks };
			}),
		);
		const passing = candidates.filter(c => !c.hardFail.length);
		const shown = (passing.length ? passing : candidates).sort((a, b) => a.composite - b.composite).slice(0, 4);
		let chosen = shown[0]!.name;
		let opus: { order: string[]; pick?: string; cost: number } | undefined;
		if (shown.length > 1) {
			// Shuffle with a per-task seed so the order is reproducible but not the composite's order.
			const rand = rng([...`${id}|${setNo}`].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) | 0);
			const order = shown.map(c => ({ c, k: rand() })).sort((a, b) => a.k - b.k).map(x => x.c);
			const res = await runAgent({
				cwd: await ensureBase(task),
				prompt: PICK_PROMPT(task, order.map(c => readPatch(path.join(runDir, id, c.name, "patch.clean.diff"), false))),
				model,
				eventsFile: path.join(runDir, id, `pick-set${setNo}-opus.jsonl`),
				timeoutMs: 15 * 60_000,
				tools: "read,grep,glob",
			});
			const i = parsePick(res.finalText, order.length);
			opus = { order: order.map(c => c.name), pick: i === undefined ? undefined : order[i]!.name, cost: res.cost };
			if (opus.pick) chosen = opus.pick;
		}
		const attemptsCost = runs.reduce((a, r) => a + readJson<RunResult>(path.join(r.dir, "result.json")).cost, 0);
		writeJson(out, { task: id, set: Number(setNo), chosen, patch: path.join(id, chosen, "patch.clean.diff"), opus, candidates, cost: { attempts: attemptsCost, opus: opus?.cost ?? 0 } });
		console.log(
			`${id} set ${setNo}: chose ${chosen}${opus && !opus.pick ? " (Opus unparseable; lowest composite)" : ""}; dropped ${candidates.length - passing.length}; cleared ${candidates.filter(c => c.stray.length).map(c => `${c.name}:${c.stray.length}`).join(" ") || "none"}; composite ${candidates.map(c => `${c.name}=${c.composite.toFixed(2)}`).join(" ")}`,
		);
	});
	console.log("Jev spend so far", jevSpend());
}
