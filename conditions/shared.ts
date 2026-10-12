/** Helpers shared by the eval hooks (gate, checkers, approach, history). */
import * as fs from "node:fs";
import * as path from "node:path";

export const CODE = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/;
export const TEST = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.py$/;
export const LOCK = /(^|\/)(pnpm-lock\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock|uv\.lock|Cargo\.lock|go\.sum)$/;
export const isSource = (rel: string) => CODE.test(rel) && !TEST.test(rel);

export function run(cmd: string[], cwd: string, timeoutMs = 120_000): { code: number; out: string } {
	const res = Bun.spawnSync(cmd, { cwd, stderr: "pipe", timeout: timeoutMs, env: process.env });
	return { code: res.exitCode ?? -1, out: res.stdout.toString() + res.stderr.toString() };
}

export async function runAsync(cmd: string[], cwd: string, timeoutMs = 300_000): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, env: process.env });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out: out + err };
}

export function git(cwd: string, args: string[]): string {
	const res = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
	return res.exitCode === 0 ? res.stdout.toString() : "";
}

const roots = new Map<string, string>();
export function repoRoot(cwd: string): string {
	let root = roots.get(cwd);
	if (root === undefined) {
		root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
		roots.set(cwd, root);
	}
	return root;
}

/** Strip a read selector (`file.py:10-20`, `file.ts:raw`) from a path argument. */
export function stripSelector(raw: string): string {
	const base = path.basename(raw);
	return base.includes(":") ? path.join(path.dirname(raw), base.slice(0, base.indexOf(":"))) : raw;
}

/** Repo-relative paths an edit/write tool call targets, with hashline line numbers when present. */
export function editTargets(event: any, cwd: string, root: string): { rel: string; abs: string; lines?: number[]; content?: string }[] {
	const out: { rel: string; abs: string; lines?: number[]; content?: string }[] = [];
	const add = (given: string, extra: { lines?: number[]; content?: string }) => {
		const abs = path.resolve(cwd, given);
		const rel = path.relative(root, abs);
		if (!rel.startsWith("..")) out.push({ rel, abs, ...extra });
	};
	if (event.toolName === "write" && typeof event.input?.path === "string") {
		add(event.input.path, { content: String(event.input.content ?? "") });
	} else if (event.toolName === "edit") {
		const lines = typeof event.input?.input === "string" ? hashlineLines(event.input.input) : new Map<string, number[]>();
		const paths: string[] = event.input?.paths ?? (event.input?.path ? [event.input.path] : []);
		for (const p of paths) add(p, { lines: lines.get(p) });
	}
	return out;
}

/** Line numbers a hashline edit touches, per `[path#TAG]` header. */
export function hashlineLines(input: string): Map<string, number[]> {
	const out = new Map<string, number[]>();
	let current: string | undefined;
	for (const line of input.split("\n")) {
		const header = /^\[(.+?)#[0-9A-Fa-f]{4}\]\s*$/.exec(line);
		if (header) {
			current = header[1]!;
			if (!out.has(current)) out.set(current, []);
			continue;
		}
		const op = /^(?:PUT|CUT)\s+[<>]?(\d+)/.exec(line);
		if (op && current) out.get(current)!.push(Number(op[1]));
	}
	return out;
}

export interface Def {
	name: string;
	kind: "class" | "function";
	start: number;
	end: number;
	indent: number;
	/** Enclosing class, for methods. */
	owner?: string;
}

/** Function/class/method definitions with line spans (1-based, inclusive). */
export function parseDefs(file: string, text: string): Def[] {
	const lines = text.split("\n");
	const py = file.endsWith(".py");
	const starts: { name: string; kind: Def["kind"]; line: number; indent: number }[] = [];
	lines.forEach((line, i) => {
		let m: RegExpExecArray | null;
		if (py) {
			m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
			if (m) return void starts.push({ name: m[2]!, kind: "function", line: i + 1, indent: m[1]!.length });
			m = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
			if (m) starts.push({ name: m[2]!, kind: "class", line: i + 1, indent: m[1]!.length });
			return;
		}
		m = /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
		if (m) return void starts.push({ name: m[2]!, kind: "class", line: i + 1, indent: m[1]!.length });
		m =
			/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line) ??
			/^(\s*)(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/.exec(line) ??
			/^(\s*)(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/.exec(line) ??
			/^(\s+)(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{;]+)?\{\s*$/.exec(line);
		if (m && !/^(if|for|while|switch|catch|return|function|constructor)$/.test(m[2]!)) {
			starts.push({ name: m[2]!, kind: "function", line: i + 1, indent: m[1]!.length });
		}
	});
	return starts.map((d, k) => {
		const next = starts.slice(k + 1).find(o => o.indent <= d.indent);
		const owner = [...starts.slice(0, k)].reverse().find(o => o.kind === "class" && o.indent < d.indent);
		return { name: d.name, kind: d.kind, start: d.line, end: next ? next.line - 1 : lines.length, indent: d.indent, owner: owner?.name };
	});
}

/** Innermost definition containing `line`. */
export function enclosing(defs: Def[], line: number): Def | undefined {
	return defs.filter(d => d.start <= line && line <= d.end).sort((a, b) => b.indent - a.indent)[0];
}

/** Append one JSON record to the run's hook ledger (HOOK_LOG_DIR/<hook>.jsonl). */
export function ledger(hook: string, record: Record<string, unknown>): void {
	const dir = process.env.HOOK_LOG_DIR;
	if (dir) fs.appendFileSync(path.join(dir, `${hook}.jsonl`), `${JSON.stringify({ t: Date.now(), ...record })}\n`);
}

/** Text of a tool result's content blocks. */
export const resultText = (event: any): string =>
	Array.isArray(event.content) ? event.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";

const STOP = new Set(
	"the a an and or of to in for on with is are be by as at from this that it its into should when not no all any each new add use used using make made fix only also than then there their them they which what will would can could may must does done".split(
		" ",
	),
);
export const wordTokens = (text: string) =>
	new Set(
		text
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(t => t.length >= 3 && !STOP.has(t)),
	);
