/**
 * Plans that differ on the decision that matters, for seeding parallel attempts.
 *
 *   bun plans.ts make --tasks a,b [--out plans] [--model anthropic/claude-opus-5-5] [--set 1]
 *   bun plans.ts offline-check runs/final
 *
 * make: a read-only agent reads the repository, names the one design decision that most decides
 * whether a maintainer accepts the change, and writes 4 complete plans taking different stances on
 * it. Jev then checks every pair of plans really differs on that decision and that each plan covers
 * the whole issue; on a failure the planner rewrites once with the problems listed. Jev also names
 * the decisive axis independently from the issue alone (both option orders), recorded for analysis.
 * Writes <out>/<task>.set<k>.json.
 *
 * offline-check: asks Jev whether the 2-3 options each stored `approach` run proposed differ in
 * substance, and relates that to how the run scored against the task's baseline mean.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { auroc, loadRuns, mean } from "./data";
import { type Question, jev, jevSpend } from "./jev";
import { type Task, ROOT, arg, ensureBase, pool, readJson, runAgent, writeJson } from "./lib";

export const AXES = {
	algorithm: "How the core computation is done: the algorithm, vectorised versus loop-based code, or the data structures used.",
	concurrency: "Whether work is synchronous, asynchronous, threaded, or batched, and what may block.",
	data_model: "How data is represented, stored, or persisted: schemas, file formats, fields.",
	reuse: "Whether to reuse or extend existing code in the repository or to write new code.",
	location: "Where the change lives: which module, layer, or shared code path.",
	api_surface: "The public interface: function signatures, parameters, endpoints, or configuration.",
	error_handling: "How failures, invalid input, and edge cases are handled.",
	other: "None of the other options.",
} as const;

export interface Plan {
	title: string;
	stance: string;
	summary: string;
	files: string[];
}
export interface PlanSet {
	task: string;
	decision: { axis: string; question: string };
	plans: Plan[];
	jev: { differ: Record<string, number>; complete: number[]; axis: string; axisConfidence: number; axisProbabilities: Record<string, number> };
	regenerated: boolean;
	problems: string[];
	cost: number;
	model: string;
}

const PROMPT = (task: Task, feedback = "") => `You are planning how to resolve an issue in this repository. The working tree is the code before any change. Read the repository as needed: the code the issue touches, existing helpers, sibling implementations, conventions, and any design documents.

Issue:
${task.statement}

First decide which single design decision most determines whether a strong maintainer of this codebase would accept a change for this issue (for example: vectorised versus loop-based computation, sync versus async, where the change lives, reusing an existing helper versus writing new code, the data model, the public interface, error handling).

Then write 4 plans. Each plan must fully resolve the issue, and each must take a clearly different stance on that decision; do not write plans that differ only in naming or minor details. Use stances a maintainer of this codebase would seriously consider, and make at least one plan follow the codebase's existing patterns as closely as possible.
${feedback}
End your reply with exactly one line of JSON:
{"decision":{"axis":"${Object.keys(AXES).join("|")}","question":"<the decision, one sentence>"},"plans":[{"title":"<short>","stance":"<this plan's answer to the decision, one sentence>","summary":"<what to build and where, 2-4 sentences>","files":["<path>"]}]}`;

function parsePlans(text: string): { decision: PlanSet["decision"]; plans: Plan[] } | undefined {
	try {
		const parsed = JSON.parse(text.slice(text.lastIndexOf('{"decision"'), text.lastIndexOf("}") + 1));
		if (!parsed.decision?.question || !Array.isArray(parsed.plans) || parsed.plans.length < 2) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Jev checks on a plan set: pairwise difference on the decision, per-plan completeness, decisive axis. */
export async function checkPlans(statement: string, decision: PlanSet["decision"], plans: Plan[]) {
	const questions: Record<string, Question> = {};
	for (let i = 0; i < plans.length; i++) {
		questions[`complete_${i}`] = { type: "noul", instructions: `Would carrying out \`plans[${i}].summary\` do everything \`issue\` asks for?` };
		for (let j = i + 1; j < plans.length; j++) {
			questions[`differ_${i}_${j}`] = {
				type: "noul",
				instructions: `Do \`plans[${i}].stance\` and \`plans[${j}].stance\` give different answers to \`decision\`?`,
			};
		}
	}
	const state = { issue: statement, decision: decision.question, plans: plans.map(p => ({ title: p.title, stance: p.stance, summary: p.summary })) };
	const reversed = Object.fromEntries(Object.entries(AXES).reverse());
	const instruction = "Which design decision most determines whether a maintainer would accept a change that resolves `issue`?";
	const [checks, axis] = await Promise.all([
		jev(state, questions),
		jev({ issue: statement }, { fwd: { type: "choice", instructions: instruction, criteria: AXES }, rev: { type: "choice", instructions: instruction, criteria: reversed } }),
	]);
	const probabilities = Object.fromEntries(Object.keys(AXES).map(k => [k, ((axis.answers.fwd!.probabilities![k] ?? 0) + (axis.answers.rev!.probabilities![k] ?? 0)) / 2]));
	const [best, p] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
	const n = Object.keys(AXES).length;
	return {
		differ: Object.fromEntries(Object.keys(questions).filter(k => k.startsWith("differ_")).map(k => [k, checks.answers[k]!.noul!])),
		complete: plans.map((_, i) => checks.answers[`complete_${i}`]!.noul!),
		axis: best,
		axisConfidence: Math.max(0, (n * p - 1) / (n - 1)),
		axisProbabilities: probabilities,
	};
}

export async function makePlans(task: Task, model: string, eventsDir: string): Promise<PlanSet> {
	const cwd = await ensureBase(task);
	let cost = 0;
	let problems: string[] = [];
	let last: PlanSet | undefined;
	for (let round = 0; round < 2; round++) {
		const feedback = problems.length
			? `\nA reviewer found problems with a previous set of plans:\n${problems.map(p => `- ${p}`).join("\n")}\nPrevious plans:\n${JSON.stringify(last!.plans, null, 1)}\nWrite a new set of 4 plans that fixes these problems.\n`
			: "";
		let parsed: ReturnType<typeof parsePlans>;
		for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
			const res = await runAgent({ cwd, prompt: PROMPT(task, feedback), model, eventsFile: path.join(eventsDir, `plans-r${round}-a${attempt}.jsonl`), timeoutMs: 15 * 60_000, tools: "read,grep,glob" });
			cost += res.cost;
			parsed = parsePlans(res.finalText);
		}
		if (!parsed) throw new Error(`${task.id}: planner output unparseable`);
		const checks = await checkPlans(task.statement, parsed.decision, parsed.plans);
		problems = [
			...Object.entries(checks.differ)
				.filter(([, v]) => v < 0.5)
				.map(([k]) => {
					const [, i, j] = k.split("_").map(Number);
					return `Plans ${i! + 1} ("${parsed!.plans[i!]!.title}") and ${j! + 1} ("${parsed!.plans[j!]!.title}") take the same stance on the decision.`;
				}),
			...checks.complete.flatMap((v, i) => (v < 0.3 ? [`Plan ${i + 1} ("${parsed!.plans[i]!.title}") does not resolve everything the issue asks for.`] : [])),
		];
		last = { task: task.id, ...parsed, jev: checks, regenerated: round > 0, problems, cost, model };
		if (!problems.length) break;
	}
	return last!;
}

const mode = process.argv[2];
if (import.meta.main && mode === "make") {
	const out = path.resolve(ROOT, arg("out", "plans")!);
	const model = arg("model", "anthropic/claude-opus-5-5")!;
	const set = Number(arg("set", "1"));
	const ids = arg("tasks")!.split(",");
	await pool(ids, Number(arg("concurrency", "4")), async id => {
		const file = path.join(out, `${id}.set${set}.json`);
		if (fs.existsSync(file)) return;
		const task = readJson<Task>(path.join(ROOT, "tasks", `${id}.json`));
		const plans = await makePlans(task, model, path.join(out, "events", `${id}.set${set}`));
		writeJson(file, plans);
		console.log(`${id} set ${set}: axis ${plans.decision.axis} (Jev ${plans.jev.axis} ${plans.jev.axisConfidence.toFixed(2)}), min differ ${Math.min(...Object.values(plans.jev.differ)).toFixed(2)}, min complete ${Math.min(...plans.jev.complete).toFixed(2)}${plans.regenerated ? ", regenerated" : ""}${plans.problems.length ? `, ${plans.problems.length} problems remain` : ""} $${plans.cost.toFixed(2)}`);
	});
	console.log("Jev spend so far", jevSpend());
} else if (import.meta.main && mode === "offline-check") {
	const runs = loadRuns();
	const baseMean = new Map([...Map.groupBy(runs.filter(r => r.condition === "off"), r => r.task)].map(([t, g]) => [t, mean(g.map(r => r.merge))]));
	const rows: { task: string; run: string; differ: number; delta: number; options: number }[] = [];
	await pool(runs.filter(r => r.condition === "approach"), 6, async r => {
		const ledger = path.join(r.dir, "approach.jsonl");
		if (!fs.existsSync(ledger)) return;
		const rec = fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).find(x => x.approaches);
		if (!rec) return;
		const task = readJson<Task>(path.join(ROOT, "tasks", `${r.task}.json`));
		const res = await jev(
			{ issue: task.statement, options: rec.approaches.map((a: { summary: string }) => a.summary) },
			{
				differ: {
					type: "noul",
					instructions: "Do the options in `options` differ in how they do the core of `issue` (the algorithm, the data structures, sync versus async, or where the change lives), rather than only in minor details?",
				},
			},
		);
		rows.push({ task: r.task, run: r.name, differ: res.answers.differ!.noul!, delta: r.merge - baseMean.get(r.task)!, options: rec.approaches.length });
	});
	const hi = rows.filter(r => r.differ >= 0.5);
	const lo = rows.filter(r => r.differ < 0.5);
	const lines = [
		"# Offline check: do substantively different options help the approach hook?",
		"",
		`${rows.length} approach runs that proposed options. Δ = run merge cost − task baseline mean (negative = better than baseline).`,
		"",
		"| Jev: options differ in substance | Runs | Mean Δ merge cost | Share better than baseline mean |",
		"|---|---|---|---|",
		`| yes (≥ 0.5) | ${hi.length} | ${mean(hi.map(r => r.delta)).toFixed(2)} | ${Math.round((100 * hi.filter(r => r.delta < 0).length) / Math.max(1, hi.length))}% |`,
		`| no (< 0.5) | ${lo.length} | ${mean(lo.map(r => r.delta)).toFixed(2)} | ${Math.round((100 * lo.filter(r => r.delta < 0).length) / Math.max(1, lo.length))}% |`,
		"",
		`AUROC of 'differ' for 'better than baseline mean': ${auroc(rows.map(r => r.differ), rows.map(r => r.delta < 0)).toFixed(2)}.`,
	];
	fs.writeFileSync(path.join(ROOT, "replay", "PLANCHECK.md"), `${lines.join("\n")}\n`);
	console.log(lines.join("\n"));
} else if (import.meta.main) {
	console.log("usage: bun plans.ts make --tasks a,b | offline-check runs/final");
}
