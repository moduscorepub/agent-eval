/**
 * Label every review comment with the cause it describes, using Jev (one Choice, asked with the
 * options in both orders and averaged, because Jev leans toward the first option).
 *
 *   bun causes.ts runs/final
 *
 * Writes replay/causes.json: one entry per comment {run, review, index, severity, category, file,
 * comment, cause, confidence, probabilities}.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Question, jev, jevSpend } from "./jev";
import { ROOT, pool, runDirs, writeJson } from "./lib";
import { readReviews } from "./review";

export const CAUSES = {
	stray_artifact:
		"The comment says a committed file is output produced by running the program or its tests (runtime state, logs, caches, generated reports) and does not belong in the change.",
	unrequested_change:
		"The comment says the change does something the issue did not ask for: an extra feature, an unrelated edit, speculative code, or a behaviour change outside the issue.",
	missing_requirement: "The comment says something the issue asks for is not done or is only partly done.",
	bug: "The comment says the code behaves wrongly: a logic error, crash, wrong result, mishandled edge case, or broken existing behaviour.",
	performance:
		"The comment says the code is slow, blocks, or wastes resources: loops where vectorised operations exist, blocking calls in async code, repeated or unnecessary work.",
	duplication: "The comment says the change re-implements or copies logic that already exists in the codebase or elsewhere in the same change.",
	wrong_place: "The comment says the change lives in the wrong place or layer, or patches one call site instead of the shared code path.",
	convention: "The comment says the change departs from how similar code is written elsewhere in this codebase.",
	error_handling: "The comment is about missing, wrong, or swallowed error handling, or missing input validation.",
	stale_text: "The comment says a message, docstring, code comment, or documentation is outdated, wrong, or misleading.",
	readability: "The comment is about naming, clarity, structure, typing, or dead code, and does not claim a behaviour problem.",
	other: "None of the other options describes the comment.",
} as const;
export type Cause = keyof typeof CAUSES;

export interface LabeledComment {
	run: string;
	review: number;
	index: number;
	severity: string;
	category: string;
	file?: string;
	comment: string;
	cause: Cause;
	confidence: number;
	probabilities: Record<Cause, number>;
}

const reversed = Object.fromEntries(Object.entries(CAUSES).reverse());
const INSTRUCTION = "Which problem does the code-review comment in `comment` describe?";

if (import.meta.main) {
	const runDir = path.resolve(ROOT, process.argv[2] ?? "runs/final");
	const items = runDirs(runDir)
		.filter(j => j.condition !== "bestof2")
		.flatMap(j =>
			readReviews(j.dir).flatMap((r, ri) =>
				r.comments.map((c, index) => ({ run: path.relative(runDir, j.dir), review: ri + 1, index, severity: c.severity, category: c.category, file: c.file, comment: c.comment })),
			),
		);
	const out: LabeledComment[] = [];
	let done = 0;
	await pool(items, 8, async item => {
		const questions: Record<string, Question> = {
			fwd: { type: "choice", instructions: INSTRUCTION, criteria: CAUSES },
			rev: { type: "choice", instructions: INSTRUCTION, criteria: reversed },
		};
		const r = await jev({ comment: { file: item.file ?? "", reviewer_category: item.category, text: item.comment } }, questions);
		const probabilities = Object.fromEntries(
			Object.keys(CAUSES).map(k => [k, ((r.answers.fwd!.probabilities![k] ?? 0) + (r.answers.rev!.probabilities![k] ?? 0)) / 2]),
		) as Record<Cause, number>;
		const cause = (Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0]) as Cause;
		const n = Object.keys(CAUSES).length;
		out.push({ ...item, cause, confidence: Math.max(0, (n * probabilities[cause] - 1) / (n - 1)), probabilities });
		if (++done % 200 === 0) console.log(`${done}/${items.length}`);
	});
	out.sort((a, b) => a.run.localeCompare(b.run) || a.review - b.review || a.index - b.index);
	writeJson(path.join(ROOT, "replay", "causes.json"), out);
	const counts = Object.fromEntries(Object.keys(CAUSES).map(k => [k, out.filter(c => c.cause === k).length]));
	const majors = Object.fromEntries(Object.keys(CAUSES).map(k => [k, out.filter(c => c.cause === k && (c.severity === "major" || c.severity === "blocker")).length]));
	console.log({ comments: out.length, counts, majorOrBlocker: majors, jev: jevSpend() });
	fs.mkdirSync(path.join(ROOT, "replay"), { recursive: true });
}
