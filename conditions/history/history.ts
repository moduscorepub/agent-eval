/**
 * history: experience cards from git (Chronos-lite, after arXiv 2610.11578).
 *
 * The first time the agent reads a source file, history appends a card to that read with facts the
 * code alone does not show:
 * - the files that past commits changed together with this one (co-change partners)
 * - the past commits touching this file that are most similar to the current task, and the shape of
 *   each change (files touched, lines added/removed, whether tests changed)
 * Only history up to the task's starting commit exists in the repo, so nothing leaks from the future.
 * Deterministic (git only). Ledger: HOOK_LOG_DIR/history.jsonl.
 */
import { LOCK, git, isSource, ledger, repoRoot, stripSelector, wordTokens } from "../shared";
import * as path from "node:path";

const MAX_COMMITS = 300;
const MIN_COMMITS = 3;

interface Commit {
	sha: string;
	subject: string;
	body: string;
	files: string[];
}

function commitsTouching(root: string, rel: string): Commit[] {
	// --full-diff lists every file of each commit that touched `rel`.
	const raw = git(root, ["log", "--full-diff", "--name-only", `-n${MAX_COMMITS}`, "--format=%x1e%H%x1f%s%x1f%b%x1f", "--", rel]);
	return raw
		.split("\x1e")
		.slice(1)
		.map(chunk => {
			const [sha, subject, body, rest] = chunk.split("\x1f");
			return {
				sha: sha!.trim(),
				subject: (subject ?? "").trim(),
				body: (body ?? "").trim(),
				files: (rest ?? "").split("\n").map(f => f.trim()).filter(Boolean),
			};
		});
}

/** `file +a/-r` list for one commit, tests marked, lockfiles dropped. */
function shapeOf(root: string, sha: string, rel: string): string {
	const rows = git(root, ["show", "--numstat", "--format=", sha])
		.trim()
		.split("\n")
		.map(l => l.split("\t"))
		.filter(([, , f]) => f && !LOCK.test(f));
	const parts = rows.slice(0, 8).map(([a, r, f]) => `${f === rel ? "this file" : f} +${a}/-${r}`);
	if (rows.length > 8) parts.push(`${rows.length - 8} more files`);
	return parts.join(", ");
}

export default function history(pi: any) {
	let task = "";
	let carded = new Set<string>();
	let citedCommits = new Set<string>();
	pi.on("session_start", () => {
		carded = new Set();
		citedCommits = new Set();
	});
	pi.on("before_agent_start", (event: any) => {
		if (!task && typeof event.prompt === "string") task = event.prompt;
	});

	pi.on("tool_result", (event: any, ctx: any) => {
		if (event.toolName !== "read" || event.isError || typeof event.input?.path !== "string" || event.input.path.includes("://")) return;
		const root = repoRoot(ctx.cwd);
		if (!root) return;
		const rel = path.relative(root, path.resolve(ctx.cwd, stripSelector(event.input.path)));
		if (rel.startsWith("..") || !isSource(rel) || carded.has(rel)) return;
		carded.add(rel);

		const commits = commitsTouching(root, rel);
		if (commits.length < MIN_COMMITS) return;
		const partners = new Map<string, number>();
		for (const c of commits) for (const f of new Set(c.files)) if (f !== rel && !LOCK.test(f)) partners.set(f, (partners.get(f) ?? 0) + 1);
		const top = [...partners]
			.filter(([, n]) => n >= 2 && n / commits.length >= 0.15)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 6);

		const want = wordTokens(task);
		const similar = commits
			.map(c => {
				const have = wordTokens(`${c.subject} ${c.body}`);
				const shared = [...want].filter(t => have.has(t)).length;
				return { c, score: shared / Math.sqrt(Math.max(1, have.size)) };
			})
			.filter(s => s.score > 0.6 && !citedCommits.has(s.c.sha))
			.sort((a, b) => b.score - a.score)
			.slice(0, 2);
		for (const s of similar) citedCommits.add(s.c.sha);

		if (top.length === 0 && similar.length === 0) return;
		const lines = [`Git history of ${rel} (${commits.length} commits):`];
		if (top.length) lines.push(`- Usually changed together with: ${top.map(([f, n]) => `${f} (${n} of ${commits.length})`).join(", ")}`);
		for (const { c } of similar) {
			lines.push(`- Past change similar to this task: ${c.sha.slice(0, 8)} "${c.subject.slice(0, 100)}": ${shapeOf(root, c.sha, rel)}`);
		}
		const card = lines.join("\n");
		ledger("history", { file: rel, commits: commits.length, partners: top.length, similar: similar.map(s => s.c.sha.slice(0, 8)), card });
		return { additionalContext: card };
	});
}
