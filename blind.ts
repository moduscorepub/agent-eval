/**
 * Blind pairs for the user's own judgment: which of two attempts would you merge?
 *
 *   bun blind.ts make     # replay/blind/pair-NN.md, replay/blind/answers.md, replay/blind/.key.json
 *   bun blind.ts score    # after answers.md is filled in: agreement with reviewers and the cheap pickers
 *
 * 40 same-task baseline pairs where the two reviews prefer one attempt (merge cost differs by >= 1):
 * half where the cheap picker (hard-check flags incl. stray files, then the Jev composite) agrees with
 * the reviewers, half where it does not; at most 3 pairs per task (only 17 tasks have pairs the
 * reviewers separate). A/B order is random. The key file is not meant to be opened before scoring.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Run, loadRuns, mean, rng } from "./data";
import { type Task, ROOT, readJson, writeJson } from "./lib";
import { risk } from "./qreport";
import { COMPOSITE } from "./select";

const OUT = path.join(ROOT, "replay", "blind");
const composite = (r: Run) => mean(COMPOSITE.map(q => risk(r.jev, q)));
const flagged = (r: Run) => r.checks!.suite.regressions.length + r.checks!.suite.ownFailed + r.checks!.stray.files.length > 0;
/** The cheap picker on a pair: unflagged attempts first, then the lower Jev composite. */
function cheapPick(a: Run, b: Run): Run {
	if (flagged(a) !== flagged(b)) return flagged(a) ? b : a;
	return composite(a) <= composite(b) ? a : b;
}

const mode = process.argv[2];
const runs = loadRuns().filter(r => r.condition === "off" && r.checks);
const byTask = Map.groupBy(runs, r => r.task);
if (mode === "make") {
	const rand = rng(2026);
	const agree: [Run, Run][] = [];
	const disagree: [Run, Run][] = [];
	for (const group of byTask.values()) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const [a, b] = [group[i]!, group[j]!];
				if (Math.abs(a.merge - b.merge) < 1) continue;
				const better = a.merge < b.merge ? a : b;
				(cheapPick(a, b) === better ? agree : disagree).push([a, b]);
			}
		}
	}
	const take = (list: [Run, Run][], n: number, perTask: Map<string, number>) => {
		const shuffled = list.map(p => ({ p, k: rand() })).sort((x, y) => x.k - y.k).map(x => x.p);
		const out: [Run, Run][] = [];
		for (const p of shuffled) {
			if (out.length >= n) break;
			const t = p[0].task;
			if ((perTask.get(t) ?? 0) >= 3) continue;
			perTask.set(t, (perTask.get(t) ?? 0) + 1);
			out.push(p);
		}
		return out;
	};
	const perTask = new Map<string, number>();
	const chosen = [...take(disagree, 20, perTask), ...take(agree, 20, perTask)].map(p => ({ p, k: rand() })).sort((x, y) => x.k - y.k).map(x => x.p);
	fs.rmSync(OUT, { recursive: true, force: true });
	fs.mkdirSync(OUT, { recursive: true });
	const key: { id: string; task: string; A: string; B: string }[] = [];
	chosen.forEach(([x, y], i) => {
		const [A, B] = rand() < 0.5 ? [x, y] : [y, x];
		const id = String(i + 1).padStart(2, "0");
		const task = readJson<Task>(path.join(ROOT, "tasks", `${A.task}.json`));
		const diff = (r: Run) => fs.readFileSync(path.join(r.dir, "patch.diff"), "utf8").split(/^(?=diff --git )/m).filter(c => !/^diff --git a\/\S*(lock|\.lockb) /.test(c)).join("");
		fs.writeFileSync(
			path.join(OUT, `pair-${id}.md`),
			`# Pair ${id} (${A.task})\n\nWhich patch would you merge? Answer in answers.md as \`${id}: A\`, \`${id}: B\`, or \`${id}: =\` if you cannot tell.\n\n## Issue\n\n${task.statement}\n\n## Patch A\n\n\`\`\`diff\n${diff(A)}\n\`\`\`\n\n## Patch B\n\n\`\`\`diff\n${diff(B)}\n\`\`\`\n`,
		);
		key.push({ id, task: A.task, A: A.name, B: B.name });
	});
	fs.writeFileSync(path.join(OUT, "answers.md"), `# Your picks\n\nFor each pair file, write A, B, or = after the colon.\n\n${key.map(k => `${k.id}: `).join("\n")}\n`);
	writeJson(path.join(OUT, ".key.json"), key);
	console.log(`${key.length} blind pairs written to ${path.relative(ROOT, OUT)} (up to 20 where the cheap picker disagrees with the reviewers, up to 20 where it agrees)`);
} else if (mode === "score") {
	const key = readJson<{ id: string; task: string; A: string; B: string }[]>(path.join(OUT, ".key.json"));
	const answers = new Map([...fs.readFileSync(path.join(OUT, "answers.md"), "utf8").matchAll(/^(\d\d):\s*([AB=])\s*$/gm)].map(m => [m[1]!, m[2]!]));
	const find = (task: string, name: string) => byTask.get(task)!.find(r => r.name === name)!;
	const rows = key.filter(k => answers.has(k.id) && answers.get(k.id) !== "=").map(k => {
		const A = find(k.task, k.A);
		const B = find(k.task, k.B);
		const user = answers.get(k.id) === "A" ? A : B;
		return { user, reviewers: A.merge < B.merge ? A : B, cheap: cheapPick(A, B), jev: composite(A) <= composite(B) ? A : B };
	});
	const agreeWith = (k: "reviewers" | "cheap" | "jev") => rows.filter(r => r.user === r[k]).length;
	console.log(`${rows.length} pairs answered (excluding "="). You agreed with: reviewers ${agreeWith("reviewers")}/${rows.length}, cheap picker ${agreeWith("cheap")}/${rows.length}, Jev composite alone ${agreeWith("jev")}/${rows.length}.`);
} else {
	console.log("usage: bun blind.ts make|score");
}
