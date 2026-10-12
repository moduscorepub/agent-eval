/**
 * Stray-file clearing: does removing committed runtime output from a patch lower its merge cost?
 *
 *   bun clear.ts prepare     # writes replay/clear/<task>/{orig,cleared}-s<n>/{result.json,patch.diff}
 *   bun review.ts replay/clear --reviews 2 --model anthropic/claude-sonnet-5-5
 *   bun clear.ts report      # writes replay/CLEAR.md
 *
 * Stray files = the deterministic detector (files the base test suite writes, or runtime-output
 * shaped paths) or Jev's per-file "produced by running the program" >= 0.5. Both variants are
 * reviewed fresh, so the comparison is not confounded by the old reviews' file filter (which hid
 * `docs/meetings/<date>-test.md`). Hidden-test results after clearing come from checks.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { patchFiles, strayFiles } from "./checks";
import { loadRuns, mean, taskBootstrap } from "./data";
import { type Task, ROOT, readJson, writeJson } from "./lib";
import { readReviews } from "./review";
import type { RunResult } from "./run";
import { clearFiles } from "./select";

const OUT = path.join(ROOT, "replay", "clear");

function strayFor(task: Task, diff: string, jevFiles: { path: string; generated: number }[]): string[] {
	const base = readJson<{ suiteWritten: string[] }>(path.join(ROOT, "replay", "checks", task.id, "base.json"));
	const det = strayFiles(patchFiles(diff), task.statement, base.suiteWritten).files;
	return [...new Set([...det, ...jevFiles.filter(f => f.generated >= 0.5).map(f => f.path)])].sort();
}

const mode = process.argv[2];
const runs = loadRuns().filter(r => r.condition === "off");
if (mode === "prepare") {
	let n = 0;
	for (const r of runs) {
		const task = readJson<Task>(path.join(ROOT, "tasks", `${r.task}.json`));
		const diff = fs.readFileSync(path.join(r.dir, "patch.diff"), "utf8");
		const stray = strayFor(task, diff, r.jev.files);
		if (!stray.length) continue;
		const result = readJson<RunResult>(path.join(r.dir, "result.json"));
		const checks = r.checks;
		const clearedHidden = checks?.clearedHiddenPass ?? result.hiddenPass;
		for (const [variant, patch, hidden] of [
			["orig", diff, result.hiddenPass],
			["cleared", clearFiles(diff, stray), clearedHidden],
		] as const) {
			const dir = path.join(OUT, r.task, `${variant}-s${r.seed}`);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "patch.diff"), patch);
			writeJson(path.join(dir, "result.json"), { ...result, condition: variant, hiddenPass: hidden });
			writeJson(path.join(dir, "stray.json"), { stray, clearedHiddenFromChecks: checks?.clearedHiddenPass !== undefined });
		}
		n++;
	}
	console.log(`${n} baseline runs with stray files prepared under ${path.relative(ROOT, OUT)}`);
} else if (mode === "report") {
	const rows = runs.flatMap(r => {
		const o = path.join(OUT, r.task, `orig-s${r.seed}`);
		const c = path.join(OUT, r.task, `cleared-s${r.seed}`);
		if (!fs.existsSync(path.join(o, "review-2.json")) || !fs.existsSync(path.join(c, "review-2.json"))) return [];
		const m = (d: string) => mean(readReviews(d).map(x => x.score));
		return [{ task: r.task, run: r.name, old: r.merge, orig: m(o), cleared: m(c), hiddenOrig: r.hidden, hiddenCleared: readJson<RunResult>(path.join(c, "result.json")).hiddenPass, stray: readJson<{ stray: string[] }>(path.join(o, "stray.json")).stray }];
	});
	const perTask = [...Map.groupBy(rows, r => r.task).values()].map(g => mean(g.map(r => r.cleared - r.orig)));
	const ci = taskBootstrap(perTask);
	const lines = [
		"# Stray-file clearing",
		"",
		`${rows.length} baseline runs had stray files. Each was reviewed twice as committed (now with every file visible to the reviewer) and twice with the stray files cleared.`,
		"",
		`| Measure | As committed | Stray files cleared |`,
		"|---|---|---|",
		`| Mean merge cost | ${mean(rows.map(r => r.orig)).toFixed(2)} | ${mean(rows.map(r => r.cleared)).toFixed(2)} |`,
		`| Bad (merge ≥ 4) | ${rows.filter(r => r.orig >= 4).length} | ${rows.filter(r => r.cleared >= 4).length} |`,
		`| Hidden tests pass | ${rows.filter(r => r.hiddenOrig).length}/${rows.length} | ${rows.filter(r => r.hiddenCleared).length}/${rows.length} |`,
		"",
		`Change from clearing: ${mean(rows.map(r => r.cleared - r.orig)).toFixed(2)} per run (95% CI over ${perTask.length} tasks: [${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]). The original reviews (which never saw \`docs/meetings/*-test.md\`) averaged ${mean(rows.map(r => r.old)).toFixed(2)} on these runs.`,
		"",
		"| Run | Stray files | Old review | As committed | Cleared |",
		"|---|---|---|---|---|",
		...rows.map(r => `| ${r.task} ${r.run} | ${r.stray.join(", ")} | ${r.old.toFixed(1)} | ${r.orig.toFixed(1)} | ${r.cleared.toFixed(1)} |`),
	];
	fs.writeFileSync(path.join(ROOT, "replay", "CLEAR.md"), `${lines.join("\n")}\n`);
	console.log(lines.join("\n"));
} else {
	console.log("usage: bun clear.ts prepare|report");
}
