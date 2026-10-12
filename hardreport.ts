/**
 * What do the hard checks tell a picker? Writes replay/HARD.md.
 *
 *   bun hardreport.ts
 *
 * Per signal (baseline runs): how often it fires, bad-run and hidden-fail rates with and without it,
 * and within-task concordance with merge cost. Also: cross-attempt test failure rate as a signal,
 * and the deterministic stray detector against Jev's stray question.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Run, auroc, loadCross, loadRuns, mean, withinTask } from "./data";
import { ROOT } from "./lib";

const runs = loadRuns().filter(r => r.condition === "off" && r.checks);
const cross = new Map([...new Set(runs.map(r => r.task))].map(t => [t, loadCross(t)]));
const crossFail = (r: Run) => {
	const d = cross.get(r.task)!.filter(x => x.tree === r.name && x.tests !== r.name);
	const total = d.reduce((a, x) => a + x.total, 0);
	return total ? d.reduce((a, x) => a + x.failed, 0) / total : 0;
};
const signals: Record<string, (r: Run) => number> = {
	"patch did not apply": r => (r.checks!.applied ? 0 : 1),
	"visible-suite regression": r => (r.checks!.suite.regressions.length ? 1 : 0),
	"own tests fail": r => (r.checks!.suite.ownFailed ? 1 : 0),
	"stray files (deterministic)": r => (r.checks!.stray.files.length ? 1 : 0),
	"new checker findings": r => (r.checks!.checker.count ? 1 : 0),
	"any hard failure (regression, own tests, stray)": r => (r.checks!.suite.regressions.length || r.checks!.suite.ownFailed || r.checks!.stray.files.length ? 1 : 0),
	"others' tests fail on it (rate > 0)": r => (crossFail(r) > 0 ? 1 : 0),
};

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "-");
const lines = [
	"# Hard checks on baseline runs",
	"",
	`${runs.length} baseline runs over ${cross.size} tasks. Bad = merge cost >= 4. Within-task = among same-task pairs whose merge cost differs by >= 1, how often the signal ranks the worse run as riskier (0.50 = chance; ties count half).`,
	"",
	"| Signal | Fires on | Bad when fires | Bad otherwise | Hidden fails when fires | Hidden fails otherwise | Within-task |",
	"|---|---|---|---|---|---|---|",
];
for (const [name, f] of Object.entries(signals)) {
	const on = runs.filter(r => f(r) > 0);
	const off = runs.filter(r => f(r) === 0);
	lines.push(
		`| ${name} | ${on.length} (${pct(on.length / runs.length)}) | ${pct(mean(on.map(r => (r.bad ? 1 : 0))))} | ${pct(mean(off.map(r => (r.bad ? 1 : 0))))} | ${pct(mean(on.map(r => (r.hidden ? 0 : 1))))} | ${pct(mean(off.map(r => (r.hidden ? 0 : 1))))} | ${withinTask(runs, f).concordance.toFixed(2)} |`,
	);
}
const cf = runs.map(crossFail);
lines.push(
	"",
	`Cross-attempt tests as a continuous signal: AUROC vs hidden-test failure ${auroc(cf, runs.map(r => !r.hidden)).toFixed(2)}, vs bad ${auroc(cf, runs.map(r => r.bad)).toFixed(2)}, within-task ${withinTask(runs, crossFail).concordance.toFixed(2)}. Tasks where at least one attempt added runnable tests: ${[...cross.values()].filter(c => c.length).length} of ${cross.size}.`,
	"",
	"## Hidden-test failures are mostly task-level",
	"",
	`Tasks where every baseline attempt fails the hidden tests: ${[...Map.groupBy(runs, r => r.task).values()].filter(g => g.every(r => !r.hidden)).length}; where some but not all fail: ${[...Map.groupBy(runs, r => r.task).values()].filter(g => g.some(r => !r.hidden) && g.some(r => r.hidden)).length}. Selection can only help the second kind.`,
	"",
	"## Stray-file detection",
	"",
);
const det = runs.map(r => r.checks!.stray.files.length > 0);
const jevStray = runs.map(r => r.jev.change.stray!);
const jevFile = runs.map(r => Math.max(0, ...r.jev.files.map(f => f.generated)));
const known = runs.map(r => /^diff --git a\/(data\/user_profile\.json|docs\/meetings\/)/m.test(fs.readFileSync(path.join(r.dir, "patch.diff"), "utf8")));
lines.push(
	`Runs committing the known runtime outputs (data/user_profile.json, docs/meetings/*): ${known.filter(Boolean).length}. Deterministic detector fires on ${det.filter(Boolean).length}; on the known-output runs it catches ${det.filter((d, i) => d && known[i]).length}/${known.filter(Boolean).length}, and fires on ${det.filter((d, i) => d && !known[i]).length} other runs.`,
	`Jev whole-change stray question: AUROC vs known outputs ${auroc(jevStray, known).toFixed(2)}; Jev per-file question (max over files): ${auroc(jevFile, known).toFixed(2)}; per-file >= 0.5 fires on ${jevFile.filter(x => x >= 0.5).length} runs (${jevFile.filter((x, i) => x >= 0.5 && known[i]).length} known).`,
);
fs.writeFileSync(path.join(ROOT, "replay", "HARD.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
