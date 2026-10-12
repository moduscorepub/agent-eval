/**
 * How good is each Jev question? Writes replay/QUESTIONS.md.
 *
 *   bun qreport.ts
 *
 * Per question: AUROC against the review-labelled cause it targets and against bad runs (merge
 * cost >= 4), within-task concordance with merge cost (what a picker needs), calibration against
 * its target, stability across phrasings, shift under a planted claim, and repeat-call drift.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Run, auroc, ece, loadRuns, mean, withinTask } from "./data";
import type { JevFeatures } from "./discover";
import { ROOT, readJson } from "./lib";

type Target = Parameters<Run["causes"]["has"]>[0];
/** Question -> cause it targets (undefined: judged only against merge cost) and whether yes means worse. */
export const QUESTIONS: Record<string, { target?: Target; worseIfYes: boolean }> = {
	stray: { target: "stray_artifact", worseIfYes: true },
	alt_stray_1: { target: "stray_artifact", worseIfYes: true },
	alt_stray_2: { target: "stray_artifact", worseIfYes: true },
	file_generated_max: { target: "stray_artifact", worseIfYes: true },
	unrequested: { target: "scope_other", worseIfYes: true },
	alt_unrequested_1: { target: "scope_other", worseIfYes: true },
	alt_unrequested_2: { target: "scope_other", worseIfYes: true },
	extra_feature: { target: "scope_other", worseIfYes: true },
	unrelated_edit: { target: "scope_other", worseIfYes: true },
	speculative: { target: "unrequested_change", worseIfYes: true },
	missing: { target: "missing_any", worseIfYes: true },
	alt_missing_1: { target: "missing_any", worseIfYes: true },
	alt_missing_2: { target: "missing_any", worseIfYes: true },
	complete: { target: "missing_any", worseIfYes: false },
	bug: { target: "bug", worseIfYes: true },
	alt_bug_1: { target: "bug", worseIfYes: true },
	alt_bug_2: { target: "bug", worseIfYes: true },
	slow: { target: "performance", worseIfYes: true },
	blocking_async: { target: "performance", worseIfYes: true },
	swallow: { target: "error_handling", worseIfYes: true },
	guessed: { worseIfYes: true },
	stale_text: { target: "stale_text", worseIfYes: true },
	wrong_place: { target: "wrong_place", worseIfYes: true },
	dup_within: { target: "duplication", worseIfYes: true },
	reimplements: { target: "duplication", worseIfYes: true },
	debris: { target: "readability", worseIfYes: true },
	tests_added: { worseIfYes: false },
	simpler: { worseIfYes: true },
	style_mismatch: { target: "convention", worseIfYes: true },
	focus: { target: "scope_other", worseIfYes: false },
	correct: { target: "bug", worseIfYes: false },
	merge_ready: { worseIfYes: false },
};

/** A question's raw value for a run (probability or scaled score). */
export function answer(f: JevFeatures, q: string): number {
	if (q === "file_generated_max") return Math.max(0, ...f.files.map(x => x.generated));
	if (q === "reimplements") return f.reuse.reimplements ?? 0;
	return f.change[q]!;
}
/** Risk orientation: higher = worse. */
export const risk = (f: JevFeatures, q: string) => (QUESTIONS[q]!.worseIfYes ? answer(f, q) : 1 - answer(f, q));

const pearson = (a: number[], b: number[]) => {
	const ma = mean(a);
	const mb = mean(b);
	let n = 0;
	let da = 0;
	let db = 0;
	a.forEach((x, i) => {
		n += (x - ma) * (b[i]! - mb);
		da += (x - ma) ** 2;
		db += (b[i]! - mb) ** 2;
	});
	return n / Math.sqrt(da * db);
};
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

if (import.meta.main) {
	const runs = loadRuns();
	const base = runs.filter(r => r.condition === "off");
	const robust = readJson<{ planted: { base: JevFeatures; planted: JevFeatures }[]; repeats: { first: JevFeatures; second: JevFeatures }[] }>(
		path.join(ROOT, "replay", "jev-robustness.json"),
	);
	const lines = [
		"# Jev question report",
		"",
		`${runs.length} runs (${base.length} baseline). Target = the cause the question is meant to detect, labelled from review comments (minor or worse, either review). Bad = merge cost >= 4.`,
		"Within-task = among same-task pairs whose merge cost differs by >= 1, how often the question rates the worse run as riskier (0.50 = chance). This is what a picker needs; AUROC across all runs can be driven by which tasks are hard.",
		"Planted shift = mean change in risk when the diff carries a planted 'this is correct and in scope' comment (negative = the claim made it look safer). Repeat drift = mean absolute change on an uncached repeat call.",
		"",
		"| Question | Target | Target prevalence | AUROC vs target | AUROC vs target (major+) | AUROC vs bad | Within-task (all) | Within-task (baseline) | ECE vs target | Planted shift | Repeat drift |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	];
	const rows: { q: string; within: number }[] = [];
	for (const [q, meta] of Object.entries(QUESTIONS)) {
		const score = runs.map(r => risk(r.jev, q));
		const tgt = meta.target ? runs.map(r => r.causes.has(meta.target!)) : [];
		const tgtMajor = meta.target ? runs.map(r => r.majorCauses.has(meta.target!)) : [];
		const within = withinTask(runs, r => risk(r.jev, q));
		const withinBase = withinTask(base, r => risk(r.jev, q));
		const planted = mean(robust.planted.map(p => risk(p.planted, q) - risk(p.base, q)));
		const drift = mean(robust.repeats.map(p => Math.abs(answer(p.second, q) - answer(p.first, q))));
		rows.push({ q, within: within.concordance });
		lines.push(
			`| ${q} | ${meta.target ?? "-"} | ${meta.target ? `${Math.round((100 * tgt.filter(Boolean).length) / runs.length)}%` : "-"} | ${meta.target ? f2(auroc(score, tgt)) : "-"} | ${meta.target ? f2(auroc(score, tgtMajor)) : "-"} | ${f2(auroc(score, runs.map(r => r.bad)))} | ${f2(within.concordance)} | ${f2(withinBase.concordance)} | ${meta.target && meta.worseIfYes ? f2(ece(score, tgt)) : "-"} | ${planted >= 0 ? "+" : ""}${f2(planted)} | ${f2(drift)} |`,
		);
	}
	const families: Record<string, string[]> = {
		stray: ["stray", "alt_stray_1", "alt_stray_2"],
		unrequested: ["unrequested", "alt_unrequested_1", "alt_unrequested_2"],
		missing: ["missing", "alt_missing_1", "alt_missing_2"],
		bug: ["bug", "alt_bug_1", "alt_bug_2"],
	};
	lines.push("", "## Phrasing stability (Pearson r between phrasings, all runs)", "", "| Question | r(main, alt 1) | r(main, alt 2) | r(alt 1, alt 2) |", "|---|---|---|---|");
	for (const [name, [a, b, c]] of Object.entries(families)) {
		const v = (q: string) => runs.map(r => answer(r.jev, q));
		lines.push(`| ${name} | ${f2(pearson(v(a!), v(b!)))} | ${f2(pearson(v(a!), v(c!)))} | ${f2(pearson(v(b!), v(c!)))} |`);
	}
	const usage = fs.readFileSync(path.join(ROOT, "replay", "jev-usage.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as { inputTokens: number; ms: number; questions: number });
	const big = usage.filter(u => u.questions > 20);
	const ms = big.map(u => u.ms).sort((a, b) => a - b);
	lines.push(
		"",
		"## Cost and speed",
		"",
		`Whole-change requests (${big.length}): median ${Math.round(ms[Math.floor(ms.length / 2)]!)} ms, p95 ${Math.round(ms[Math.floor(ms.length * 0.95)]!)} ms, median ${Math.round(big.map(u => u.inputTokens).sort((a, b) => a - b)[Math.floor(big.length / 2)]!)} input tokens.`,
		`Per candidate (all three requests): mean ${Math.round(mean(runs.map(r => r.jev.tokens)))} tokens = $${(mean(runs.map(r => r.jev.tokens)) * 0.042e-6).toFixed(5)}.`,
	);
	fs.writeFileSync(path.join(ROOT, "replay", "QUESTIONS.md"), `${lines.join("\n")}\n`);
	console.log(lines.join("\n"));
}
