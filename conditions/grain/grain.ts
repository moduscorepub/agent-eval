/**
 * grain: work with the grain of the codebase.
 *
 * After each edit, grain looks at the source files the agent has changed and tells it, as
 * out-of-band context the user never sees, how the neighbouring code already does things:
 * - the closest existing sibling of each new function or class (with a short snippet)
 * - new public classes missing from the package's exports (__init__.py / index.ts)
 * - new public definitions without docs where the package documents its definitions
 * - for new modules, a library most sibling modules import that this one does not
 * Every note is emitted once per session; nothing is said when there is nothing specific.
 * Deterministic (git + regex), no model calls. Set GRAIN_LOG=<file> to record emitted notes.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const CODE = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.py$/;
const EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);
const MAX_SIBLINGS = 40;
const MAX_FILE_BYTES = 200_000;
const MAX_CONTEXT = 4000;
const NAME_STOPWORDS = new Set(["get", "set", "make", "create", "build", "to", "from", "the", "of", "for", "handle", "handler", "on", "is", "has", "do", "run", "new", "init", "with", "by", "and", "or", "in", "at", "data", "value", "item", "items", "list", "util", "utils", "helper"]);
const PY_STDLIB = new Set(["__future__", "abc", "argparse", "asyncio", "base64", "collections", "contextlib", "copy", "csv", "dataclasses", "datetime", "enum", "functools", "glob", "hashlib", "heapq", "inspect", "io", "itertools", "json", "logging", "math", "os", "pathlib", "pickle", "random", "re", "shutil", "signal", "socket", "sqlite3", "statistics", "string", "struct", "subprocess", "sys", "tempfile", "textwrap", "threading", "time", "traceback", "types", "typing", "unittest", "urllib", "uuid", "warnings", "weakref"]);

type Lang = "py" | "ts";
interface Def {
	name: string;
	line: number;
	indent: number;
	kind: "class" | "function";
	exported: boolean;
	documented: boolean;
}
interface Parsed {
	lines: string[];
	defs: Def[];
	imports: Set<string>;
}
interface Note {
	/** One key per fact (a name or a library) so a fact is never repeated in a session. */
	keys: string[];
	text: string;
}

const nameList = (names: string[]) =>
	names.length > 4 ? `${names.slice(0, 4).map(n => `\`${n}\``).join(", ")} and ${names.length - 4} more` : names.map(n => `\`${n}\``).join(", ");

const langOf = (file: string): Lang => (file.endsWith(".py") ? "py" : "ts");
const indentOf = (line: string) => line.length - line.trimStart().length;

function git(cwd: string, args: string[]): string | undefined {
	const res = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
	return res.exitCode === 0 ? res.stdout.toString() : undefined;
}

function readSmall(file: string): string | undefined {
	try {
		return fs.statSync(file).size <= MAX_FILE_BYTES ? fs.readFileSync(file, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

function pyDocumented(lines: string[], i: number): boolean {
	let j = i;
	while (j < Math.min(lines.length, i + 12) && !lines[j]!.trimEnd().endsWith(":")) j++;
	let k = j + 1;
	while (k < lines.length && !lines[k]!.trim()) k++;
	return /^\s*[rbuRBU]?("""|''')/.test(lines[k] ?? "");
}

function tsDocumented(lines: string[], i: number): boolean {
	let k = i - 1;
	while (k >= 0 && (!lines[k]!.trim() || lines[k]!.trim().startsWith("@"))) k--;
	return (lines[k] ?? "").trim().endsWith("*/");
}

function parse(file: string, text: string): Parsed {
	const lang = langOf(file);
	const lines = text.split("\n");
	const defs: Def[] = [];
	const imports = new Set<string>();
	lines.forEach((line, i) => {
		if (lang === "py") {
			const m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line) ?? /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
			if (m) {
				defs.push({
					name: m[2]!,
					line: i + 1,
					indent: m[1]!.length,
					kind: line.trimStart().startsWith("class") ? "class" : "function",
					exported: !m[2]!.startsWith("_"),
					documented: pyDocumented(lines, i),
				});
			}
			const imp = /^(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/.exec(line);
			const mod = imp && (imp[1] ?? imp[2])!.split(".")[0]!;
			if (mod && !PY_STDLIB.has(mod)) imports.add(mod);
		} else {
			const m =
				/^(\s*)(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line) ??
				/^(\s*)(export\s+)?const\s+([a-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.exec(line) ??
				/^(\s*)(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
			if (m) {
				defs.push({
					name: m[3]!,
					line: i + 1,
					indent: m[1]!.length,
					kind: /\bclass\s/.test(line) ? "class" : "function",
					exported: Boolean(m[2]),
					documented: tsDocumented(lines, i),
				});
			}
			const imp = /^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/.exec(line);
			if (imp && !imp[1]!.startsWith(".") && !imp[1]!.startsWith("node:")) {
				imports.add(imp[1]!.startsWith("@") ? imp[1]!.split("/").slice(0, 2).join("/") : imp[1]!.split("/")[0]!);
			}
		}
	});
	return { lines, defs, imports };
}

/** Lines added since HEAD (all lines for an untracked file), with their new line numbers. */
function addedLines(root: string, rel: string, untracked: boolean, text: string): { line: number; text: string }[] {
	if (untracked) return text.split("\n").map((t, i) => ({ line: i + 1, text: t }));
	const diff = git(root, ["diff", "-U0", "HEAD", "--", rel]) ?? "";
	const out: { line: number; text: string }[] = [];
	let next = 0;
	for (const line of diff.split("\n")) {
		const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
		if (hunk) next = Number(hunk[1]);
		else if (line.startsWith("+") && !line.startsWith("+++")) out.push({ line: next++, text: line.slice(1) });
	}
	return out;
}

function nameTokens(name: string): Set<string> {
	return new Set(
		name
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(t => t.length > 1 && !NAME_STOPWORDS.has(t)),
	);
}

function similarity(a: Set<string>, b: Set<string>): number {
	const shared = [...a].filter(t => b.has(t)).length;
	return shared === 0 ? 0 : shared / (a.size + b.size - shared);
}

function snippet(lines: string[], def: Def): string {
	const out: string[] = [];
	for (let i = def.line - 1; i < lines.length; i++) {
		const l = lines[i]!;
		const closesBlock = /^\s*[)\]}]/.test(l);
		if (i > def.line - 1 && l.trim() && indentOf(l) <= def.indent && !closesBlock && !l.trim().startsWith("@")) break;
		if (out.length === 14) {
			out.push(`${" ".repeat(def.indent)}...`);
			break;
		}
		out.push(l);
		if (i > def.line - 1 && closesBlock && indentOf(l) <= def.indent) break;
	}
	while (out.length && !out.at(-1)!.trim()) out.pop();
	return out.map(l => l.slice(Math.min(def.indent, indentOf(l)))).join("\n");
}

/** Convention notes for one changed source file. */
function notesFor(root: string, rel: string, untracked: boolean, seen: (key: string) => boolean): Note[] {
	const abs = path.join(root, rel);
	const text = readSmall(abs);
	if (text === undefined) return [];
	const lang = langOf(rel);
	const self = parse(rel, text);
	const added = addedLines(root, rel, untracked, text);
	if (added.length === 0) return [];
	const addedAt = new Set(added.map(a => a.line));
	const newDefs = self.defs.filter(d => addedAt.has(d.line));
	const dir = path.dirname(abs);
	const relDir = path.dirname(rel);
	const siblings = fs
		.readdirSync(dir)
		.filter(n => CODE.test(n) && langOf(n) === lang && n !== path.basename(rel) && !TEST.test(path.join(relDir, n)))
		.slice(0, MAX_SIBLINGS)
		.map(n => ({ rel: path.join(relDir, n), parsed: parse(n, readSmall(path.join(dir, n)) ?? "") }))
		.filter(s => s.parsed.lines.length > 1);
	const notes: Note[] = [];

	// 1. Closest existing sibling for each new definition.
	const pool = [
		...self.defs.filter(d => !newDefs.includes(d)).map(d => ({ def: d, rel, lines: self.lines })),
		...siblings.flatMap(s => s.parsed.defs.map(d => ({ def: d, rel: s.rel, lines: s.parsed.lines }))),
	];
	for (const def of newDefs.filter(d => !seen(`sibling:${d.name}`)).slice(0, 2)) {
		const want = nameTokens(def.name);
		let best: (typeof pool)[number] | undefined;
		let bestScore = 0.3;
		for (const cand of pool) {
			if (cand.def.kind !== def.kind || cand.def.name === def.name) continue;
			const score = similarity(want, nameTokens(cand.def.name)) + (cand.rel === rel ? 0.01 : 0);
			if (score > bestScore) {
				best = cand;
				bestScore = score;
			}
		}
		if (best) {
			notes.push({
				keys: [`sibling:${def.name}`],
				text: `Closest existing ${def.kind} to your new \`${def.name}\` is \`${best.def.name}\` (${best.rel}:${best.def.line}). Match its shape where the two do the same job:\n\`\`\`\n${snippet(best.lines, best.def)}\n\`\`\``,
			});
		}
	}

	// 2. Public classes/exports the package index would normally re-export.
	const index = (lang === "py" ? ["__init__.py"] : ["index.ts", "index.tsx", "index.js"])
		.map(n => path.join(dir, n))
		.find(f => fs.existsSync(f) && path.basename(f) !== path.basename(rel));
	if (index) {
		const indexText = readSmall(index) ?? "";
		const reexports = indexText
			.split("\n")
			.filter(l => (lang === "py" ? /^from\s+\.\w*\s+import\s/ : /^export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+["']\.\//).test(l));
		const moduleName = path.basename(rel).replace(/\.\w+$/, "");
		const candidates = newDefs.filter(d =>
			d.indent === 0 && (lang === "py" ? d.kind === "class" && d.exported : d.exported),
		);
		const missing = candidates.filter(
			d =>
				!seen(`export:${d.name}`) &&
				!new RegExp(`\\b${d.name}\\b`).test(indexText) &&
				!new RegExp(`export\\s+\\*\\s+from\\s+["']\\./${moduleName}["']`).test(indexText),
		);
		if (reexports.length >= 2 && missing.length > 0) {
			notes.push({
				keys: missing.map(d => `export:${d.name}`),
				text: `${path.relative(root, index)} re-exports the package's public ${lang === "py" ? "classes" : "API"} (e.g. \`${reexports[0]!.trim()}\`); new public ${nameList(missing.map(d => d.name))} ${missing.length > 1 ? "are" : "is"} not exported there.`,
			});
		}
	}

	// 3. Docs where the package documents its public definitions.
	const publicDefs = [...self.defs.filter(d => !newDefs.includes(d)), ...siblings.flatMap(s => s.parsed.defs)].filter(d => d.exported);
	const documented = publicDefs.filter(d => d.documented).length;
	if (publicDefs.length >= 5 && documented / publicDefs.length >= 0.7) {
		const undocumented = newDefs.filter(d => d.exported && !d.documented && !seen(`docs:${d.name}`));
		if (undocumented.length > 0) {
			notes.push({
				keys: undocumented.map(d => `docs:${d.name}`),
				text: `New public ${nameList(undocumented.map(d => d.name))} in ${rel} ${undocumented.length > 1 ? "have" : "has"} no ${lang === "py" ? "docstring" : "doc comment"}; ${Math.round((100 * documented) / publicDefs.length)}% of public definitions in this package have one.`,
			});
		}
	}

	// 4. New modules: a library most siblings rely on.
	if (untracked && added.length >= 8 && siblings.length >= 3) {
		const counts = new Map<string, number>();
		for (const s of siblings) for (const lib of s.parsed.imports) counts.set(lib, (counts.get(lib) ?? 0) + 1);
		const [lib, count] = [...counts].filter(([l]) => !self.imports.has(l)).sort((a, b) => b[1] - a[1])[0] ?? [];
		if (lib && count && count >= 3 && count / siblings.length >= 0.6 && !seen(`lib:${lib}`)) {
			notes.push({
				keys: [`lib:${lib}`],
				text: `Sibling modules in ${relDir}/ use \`${lib}\` (${count}/${siblings.length}); your new ${path.basename(rel)} does not. Prefer it over hand-written equivalents where it applies.`,
			});
		}
	}
	return notes;
}

export default function grain(pi: any) {
	let emitted = new Set<string>();
	pi.on("session_start", () => {
		emitted = new Set();
	});
	pi.on("tool_result", (event: any, ctx: any) => {
		if (event.isError || !EDIT_TOOLS.has(event.toolName)) return;
		const root = git(ctx.cwd, ["rev-parse", "--show-toplevel"])?.trim();
		if (!root) return;
		const tracked = (git(root, ["diff", "--name-only", "HEAD"]) ?? "").split("\n").filter(Boolean);
		const untracked = (git(root, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter(Boolean);
		const sections: string[] = [];
		for (const [rel, isNew] of [...tracked.map(f => [f, false] as const), ...untracked.map(f => [f, true] as const)]) {
			if (!CODE.test(rel) || TEST.test(rel)) continue;
			const fresh = notesFor(root, rel, isNew, key => emitted.has(`${rel}::${key}`));
			if (fresh.length === 0) continue;
			for (const n of fresh) for (const key of n.keys) emitted.add(`${rel}::${key}`);
			sections.push(...fresh.map(n => `- ${n.text}`));
			if (process.env.GRAIN_LOG) {
				fs.appendFileSync(process.env.GRAIN_LOG, `${JSON.stringify({ file: rel, notes: fresh })}\n`);
			}
		}
		if (sections.length === 0) return;
		const body = `Codebase conventions around your edits (derived from neighbouring code; apply where they fit, ignore where they don't):\n${sections.join("\n")}`;
		return { additionalContext: body.length > MAX_CONTEXT ? `${body.slice(0, MAX_CONTEXT)}\n...` : body };
	});
}
