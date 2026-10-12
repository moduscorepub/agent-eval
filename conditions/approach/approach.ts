/**
 * approach: choose the approach before coding.
 *
 * The agent's first edit to a source file is blocked until it calls `choose_approach` with 2-3
 * genuinely different approaches (a summary and the files each would touch). A separate, cheaper
 * model reads the repository, picks one, and the agent implements that one.
 * Ledger: HOOK_LOG_DIR/approach.jsonl.
 */
import { editTargets, isSource, ledger, repoRoot, runAsync } from "../shared";

const PICKER_MODEL = process.env.APPROACH_PICKER_MODEL ?? "anthropic/claude-haiku-5-5";
const MAX_BLOCKS = 6;

const PICK_PROMPT = (issue: string, list: string) => `An engineer is about to resolve the issue below in this repository and has proposed approaches. The working tree is the code before any change. Read the repository as needed to check existing helpers, sibling implementations, call paths, and conventions.

Pick the approach a strong maintainer would merge: it fixes the real problem in the right place (the shared code path, not one call site), reuses what already exists, follows the codebase's conventions, adds nothing the issue does not need, and leaves nothing the issue requires undone.

Issue:
${issue}

Approaches:
${list}

End your reply with exactly one line of JSON: {"choice": <number>, "reason": "<one sentence>", "caution": "<one sentence on what to watch while implementing it, or empty>"}`;

export default function approach(pi: any) {
	const { Type } = pi.typebox;
	let issue = "";
	let chosen: string | undefined;
	let blocks = 0;

	pi.on("before_agent_start", (event: any) => {
		if (!issue && typeof event.prompt === "string") issue = event.prompt;
	});

	pi.registerTool({
		name: "choose_approach",
		label: "Choose approach",
		description:
			"Before your first code edit: propose 2-3 genuinely different approaches to the task (each a short summary plus the files it would touch). An independent reviewer reads the repository and picks the one to implement.",
		parameters: Type.Object({
			approaches: Type.Array(
				Type.Object({
					summary: Type.String({ description: "What this approach does and where the change lives" }),
					files: Type.Array(Type.String(), { description: "Files this approach would create or modify" }),
				}),
				{ minItems: 2, maxItems: 3 },
			),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
			const list = params.approaches
				.map((a: any, i: number) => `${i + 1}. ${a.summary}\n   Files: ${a.files.join(", ") || "(none listed)"}`)
				.join("\n");
			const bin = process.env.EVAL_AGENT_BIN ?? process.execPath;
			const res = await runAsync(
				[bin, "--no-extensions", "--no-session", "--model", PICKER_MODEL, "--tools", "read,grep,glob", "--mode", "json", "-p", PICK_PROMPT(issue, list)],
				ctx.cwd,
				8 * 60_000,
			);
			if (signal?.aborted) throw new Error("aborted");
			let text = "";
			let cost = 0;
			for (const line of res.out.split("\n")) {
				if (!line.startsWith("{")) continue;
				try {
					const ev = JSON.parse(line);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						cost += ev.message.usage?.cost?.total ?? 0;
						const t = (ev.message.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
						if (t.trim()) text = t;
					}
				} catch {}
			}
			let pick: { choice?: number; reason?: string; caution?: string } = {};
			try {
				pick = JSON.parse(text.slice(text.lastIndexOf('{"choice"'), text.lastIndexOf("}") + 1));
			} catch {}
			const index = Number.isInteger(pick.choice) && pick.choice! >= 1 && pick.choice! <= params.approaches.length ? pick.choice! : 1;
			const a = params.approaches[index - 1];
			chosen = a.summary;
			ledger("approach", { approaches: params.approaches, choice: index, reason: pick.reason ?? "picker output unparseable; defaulted to 1", caution: pick.caution, pickerCost: cost });
			const caution = pick.caution ? `\nWatch: ${pick.caution}` : "";
			return {
				content: [
					{
						type: "text",
						text: `Chosen approach ${index}: ${a.summary}\nFiles: ${a.files.join(", ")}\nWhy: ${pick.reason ?? "(no reason given)"}${caution}\nImplement this approach.`,
					},
				],
				details: { choice: index, pickerCost: cost },
			};
		},
	});

	pi.on("tool_call", (event: any, ctx: any) => {
		if (chosen || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const root = repoRoot(ctx.cwd);
		if (!root || !editTargets(event, ctx.cwd, root).some(t => isSource(t.rel))) return;
		if (blocks >= MAX_BLOCKS) return;
		blocks++;
		ledger("approach", { blocked: event.toolName, blocks });
		return {
			block: true,
			reason:
				"Before your first code edit, call choose_approach with 2-3 genuinely different approaches to this task (a short summary and the files each would touch). An independent reviewer will pick one; then implement the chosen approach.",
		};
	});
}
