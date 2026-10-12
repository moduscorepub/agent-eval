/**
 * Opus picks the best of four stored baseline attempts (the phase 1 comparison for groups of 4).
 * Two fixed groups per task: s1-s4 and s3-s6. Each group is judged with the patches in forward and
 * reversed order; both picks are stored so single-call and both-orders pickers can be scored.
 *
 *   bun bestofk.ts runs/final [--model anthropic/claude-opus-5-5] [--concurrency 6]
 *
 * Writes replay/opus4/<task>/<group>.json: {group, order1, order2, cost}.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Task, ROOT, arg, ensureBase, pool, readJson, readPatch, runAgent, runDirs, writeJson } from "./lib";

const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/final");
const model = arg("model", "anthropic/claude-opus-5-5")!;
export const GROUPS = [
	["off-s1", "off-s2", "off-s3", "off-s4"],
	["off-s3", "off-s4", "off-s5", "off-s6"],
];
const LETTERS = ["A", "B", "C", "D"];

export const PROMPT = (task: Task, patches: string[]) => `${patches.length} engineers each wrote a patch for the same issue in this repository. The working tree is the code BEFORE any patch. Read the repository as needed: existing helpers, sibling implementations, call paths, conventions.

Pick the patch you would merge: correct and complete for the issue, the change in the right place, reusing what exists, following the codebase's conventions, nothing unrequested.

Issue:
${task.statement}

${patches.map((p, i) => `Patch ${LETTERS[i]}:\n\`\`\`diff\n${p}\n\`\`\``).join("\n\n")}

End your reply with exactly one line of JSON: {"pick":"${LETTERS.slice(0, patches.length).join('"|"')}","reason":"<one sentence>"}`;

export const parsePick = (text: string, n: number): number | undefined => {
	const line = text.trim().split("\n").reverse().find(l => l.trim().startsWith("{"));
	try {
		const i = LETTERS.indexOf(JSON.parse(line ?? "").pick);
		return i >= 0 && i < n ? i : undefined;
	} catch {
		return undefined;
	}
};

if (import.meta.main) {
	const tasks = [...new Set(runDirs(runDir).filter(j => j.condition === "off").map(j => j.task))].sort();
	const jobs = tasks.flatMap(task => GROUPS.map((group, g) => ({ task, group, g })));
	let spent = 0;
	await pool(jobs, Number(arg("concurrency", "6")), async ({ task: id, group, g }) => {
		const out = path.join(ROOT, "replay", "opus4", id, `g${g + 1}.json`);
		if (fs.existsSync(out)) return;
		const task = readJson<Task>(path.join(ROOT, "tasks", `${id}.json`));
		const patches = group.map(run => readPatch(path.join(runDir, id, run, "patch.diff"), false));
		const cwd = await ensureBase(task);
		const reversed = [...group].reverse();
		const [r1, r2] = await Promise.all([
			runAgent({ cwd, prompt: PROMPT(task, patches), model, eventsFile: path.join(ROOT, "replay", "opus4", id, `g${g + 1}-order1.jsonl`), timeoutMs: 15 * 60_000, tools: "read,grep,glob" }),
			runAgent({ cwd, prompt: PROMPT(task, [...patches].reverse()), model, eventsFile: path.join(ROOT, "replay", "opus4", id, `g${g + 1}-order2.jsonl`), timeoutMs: 15 * 60_000, tools: "read,grep,glob" }),
		]);
		const p1 = parsePick(r1.finalText, group.length);
		const p2 = parsePick(r2.finalText, group.length);
		const order1 = p1 === undefined ? undefined : group[p1];
		const order2 = p2 === undefined ? undefined : reversed[p2];
		spent += r1.cost + r2.cost;
		writeJson(out, { group, order1, order2, cost: r1.cost + r2.cost });
		console.log(`${id} g${g + 1}: order1=${order1} order2=${order2}${order1 === order2 ? "" : " (disagree)"} $${(r1.cost + r2.cost).toFixed(2)} total $${spent.toFixed(2)}`);
	});
	console.log(`done; spent $${spent.toFixed(2)}`);
}
