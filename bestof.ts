/**
 * Best of two (idea 2): a different model than the agent reads the repository and picks one of two
 * independent baseline attempts, without hidden-test results. Each pair is judged in both orders;
 * if the orders disagree the pick is decided by a fixed coin (the first attempt), i.e. no better
 * than chance. Pairs come from the baseline pool: (s1,s2), (s3,s4), (s5,s6) -> bestof2-s1..s3.
 *
 *   bun bestof.ts runs/final [--model anthropic/claude-opus-5-5] [--concurrency 6]
 *
 * Writes <task>/bestof2-s<k>/{result.json, review*.json, patch.diff, pick.json}; result.cost is the
 * cost of both attempts plus the picker.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Task, ROOT, arg, ensureBase, pool, readJson, readPatch, runAgent, runDirs, writeJson } from "./lib";
import type { RunResult } from "./run";

const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/final");
const model = arg("model", "anthropic/claude-opus-5-5")!;

const PICK_PROMPT = (task: Task, pa: string, pb: string) => `Two engineers each wrote a patch for the same issue in this repository. The working tree is the code BEFORE either patch. Read the repository as needed: existing helpers, sibling implementations, call paths, conventions.

Pick the patch you would merge: correct and complete for the issue, the change in the right place, reusing what exists, following the codebase's conventions, nothing unrequested.

Issue:
${task.statement}

Patch A:
\`\`\`diff
${pa}
\`\`\`

Patch B:
\`\`\`diff
${pb}
\`\`\`

End your reply with exactly one line of JSON: {"pick":"A"|"B","reason":"<one sentence>"}`;

const parsePick = (text: string): "A" | "B" | undefined => {
	const line = text.trim().split("\n").reverse().find(l => l.trim().startsWith("{"));
	try {
		const p = JSON.parse(line ?? "").pick;
		return p === "A" || p === "B" ? p : undefined;
	} catch {
		return undefined;
	}
};

const base = runDirs(runDir).filter(j => j.condition === "off");
const tasks = [...new Set(base.map(j => j.task))].sort();
// A pair is ready once both attempts have both reviews (the pick copies them).
const reviewed = (task: string, run: string) => ["review.json", "review-2.json"].every(f => fs.existsSync(path.join(runDir, task, run, f)));
const pairs = tasks.flatMap(task =>
	[1, 2, 3].map(k => ({ task, k, a: `off-s${2 * k - 1}`, b: `off-s${2 * k}` })).filter(p => reviewed(p.task, p.a) && reviewed(p.task, p.b)),
);
console.log(`${pairs.length} pairs to pick with ${model}`);
await pool(pairs, Number(arg("concurrency", "6")), async ({ task: id, k, a, b }) => {
	const out = path.join(runDir, id, `bestof2-s${k}`);
	if (fs.existsSync(path.join(out, "result.json"))) return;
	const task = readJson<Task>(path.join(ROOT, "tasks", `${id}.json`));
	const pa = readPatch(path.join(runDir, id, a, "patch.diff"), false);
	const pb = readPatch(path.join(runDir, id, b, "patch.diff"), false);
	const cwd = await ensureBase(task);
	const [r1, r2] = await Promise.all([
		runAgent({ cwd, prompt: PICK_PROMPT(task, pa, pb), model, eventsFile: path.join(out, "pick-order1.jsonl"), timeoutMs: 15 * 60_000, tools: "read,grep,glob" }),
		runAgent({ cwd, prompt: PICK_PROMPT(task, pb, pa), model, eventsFile: path.join(out, "pick-order2.jsonl"), timeoutMs: 15 * 60_000, tools: "read,grep,glob" }),
	]);
	const v1 = parsePick(r1.finalText) === "A" ? a : parsePick(r1.finalText) === "B" ? b : undefined;
	const v2 = parsePick(r2.finalText) === "A" ? b : parsePick(r2.finalText) === "B" ? a : undefined;
	const agreed = v1 !== undefined && v1 === v2;
	const chosen = agreed ? v1! : a;
	const picked = readJson<RunResult>(path.join(runDir, id, chosen, "result.json"));
	const cost = readJson<RunResult>(path.join(runDir, id, a, "result.json")).cost + readJson<RunResult>(path.join(runDir, id, b, "result.json")).cost + r1.cost + r2.cost;
	fs.mkdirSync(out, { recursive: true });
	writeJson(path.join(out, "result.json"), { ...picked, condition: "bestof2", seed: k, cost });
	for (const f of fs.readdirSync(path.join(runDir, id, chosen))) {
		if (/^review(-\d+)?\.json$/.test(f) || f === "patch.diff") fs.copyFileSync(path.join(runDir, id, chosen, f), path.join(out, f));
	}
	writeJson(path.join(out, "pick.json"), { pair: [a, b], order1: v1, order2: v2, agreed, chosen, pickerCost: r1.cost + r2.cost });
	console.log(`${id} pair ${k}: ${agreed ? `picked ${chosen}` : `orders disagreed -> ${chosen}`}`);
});
