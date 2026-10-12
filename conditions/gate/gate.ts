/**
 * gate: evidence before the first edit (after ECLoop, arXiv 2607.28815), v2.
 *
 * Before the agent first edits a definition in a source file, gate finds where that definition is
 * used elsewhere: real call sites and imports (Python: ast; TypeScript/JavaScript: word matches
 * classified as calls or imports), same-named implementations in other files (overrides, siblings
 * implementing the same interface), and tests that use it. For a new file it looks at the package
 * index. If any of those files has not been observed yet (read, or shown by a search/bash result),
 * the edit is blocked once and the block reason shows the concrete lines, so the agent sees the
 * evidence immediately. The next edit to that file always goes through.
 * Ledger: HOOK_LOG_DIR/gate.jsonl.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST, editTargets, enclosing, git, isSource, ledger, parseDefs, repoRoot, resultText, run, stripSelector } from "../shared";

const GENERIC = new Set(["main", "init", "setup", "render", "handler", "update", "create", "build", "parse", "start", "close", "reset", "run", "get", "set", "load", "save", "default", "value", "items", "call", "execute", "process"]);
const MAX_LINES = 10;
const MAX_USES = 40;
const CALLSITES = path.join(import.meta.dir, "callsites.py");

type Use = [file: string, line: number, code: string];
interface Uses {
	calls: Use[];
	imports: Use[];
	defs: Use[];
}

const interesting = (name: string) => name.length >= 4 && !/^__.*__$/.test(name) && !GENERIC.has(name.toLowerCase());

function pythonUses(root: string, rel: string, names: string[]): Record<string, Uses> {
	const res = run(["python3", CALLSITES, root, rel, names.join(",")], root, 60_000);
	try {
		return JSON.parse(res.out);
	} catch {
		return {};
	}
}

function scriptUses(root: string, rel: string, names: string[]): Record<string, Uses> {
	const out: Record<string, Uses> = {};
	for (const name of names) {
		const uses: Uses = { calls: [], imports: [], defs: [] };
		const hits = git(root, ["grep", "-n", "-w", "-e", name, "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"]).split("\n");
		for (const hit of hits) {
			const m = /^([^:]+):(\d+):(.*)$/.exec(hit);
			if (!m || m[1] === rel) continue;
			const use: Use = [m[1]!, Number(m[2]), m[3]!.trim().slice(0, 160)];
			const code = use[2];
			if (/^\s*import\b|\bfrom\s+["']|require\(/.test(code)) uses.imports.push(use);
			else if (new RegExp(`(function\\s+${name}\\b|(const|let)\\s+${name}\\s*[:=]|^\\s*(async\\s+)?${name}\\s*\\([^)]*\\)\\s*[:{])`).test(code)) uses.defs.push(use);
			else if (new RegExp(`(\\.|\\b)${name}\\s*(<[^>]*>)?\\(`).test(code) || new RegExp(`\\b${name}\\b`).test(code)) uses.calls.push(use);
		}
		out[name] = uses;
	}
	return out;
}

/** Definitions a change touches: enclosing defs of edited lines, or defs whose text a write changed. */
function touched(abs: string, rel: string, lines: number[] | undefined, content: string | undefined): string[] {
	const old = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
	if (content !== undefined) {
		const next = content.split("\n");
		return parseDefs(rel, content)
			.filter(d => old && !old.includes(next.slice(d.start - 1, d.end).join("\n")))
			.map(d => d.name);
	}
	const defs = parseDefs(rel, old);
	return [...new Set((lines ?? []).map(n => enclosing(defs, n)?.name).filter((n): n is string => !!n))];
}

export default function gate(pi: any) {
	let read = new Set<string>();
	let shown = "";
	let gated = new Set<string>();
	pi.on("session_start", () => {
		read = new Set();
		shown = "";
		gated = new Set();
	});

	pi.on("tool_result", (event: any, ctx: any) => {
		if (event.isError) return;
		if (event.toolName === "read" && typeof event.input?.path === "string" && !event.input.path.includes("://")) {
			const root = repoRoot(ctx.cwd);
			if (root) read.add(path.relative(root, path.resolve(ctx.cwd, stripSelector(event.input.path))));
		} else if (["grep", "glob", "find", "bash", "ast_grep", "search"].includes(event.toolName) && shown.length < 4_000_000) {
			shown += `\n${resultText(event)}`;
		}
	});

	pi.on("tool_call", (event: any, ctx: any) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const root = repoRoot(ctx.cwd);
		if (!root) return;
		const observed = (f: string) => read.has(f) || shown.includes(f);
		const sections: string[] = [];
		for (const t of editTargets(event, ctx.cwd, root)) {
			if (!isSource(t.rel) || gated.has(t.rel)) continue;
			gated.add(t.rel);
			const isNew = !fs.existsSync(t.abs);
			const names = isNew ? [] : touched(t.abs, t.rel, t.lines, t.content).filter(interesting).slice(0, 4);
			const evidence: { label: string; uses: Use[] }[] = [];
			if (names.length) {
				const all = t.rel.endsWith(".py") ? pythonUses(root, t.rel, names) : scriptUses(root, t.rel, names);
				for (const name of names) {
					const u = all[name];
					if (!u) continue;
					// A name used everywhere (e.g. a `fetch` method) says nothing about this change: skip it.
					if (u.calls.length + u.imports.length > MAX_USES) continue;
					const callers = [...u.calls, ...u.imports].filter(x => !TEST.test(x[0]));
					const tests = [...u.calls, ...u.imports].filter(x => TEST.test(x[0]));
					const impls = u.defs.filter(x => !TEST.test(x[0]));
					if (callers.length) evidence.push({ label: `callers of \`${name}\``, uses: callers });
					if (impls.length) evidence.push({ label: `other definitions named \`${name}\` (overrides or siblings of the same interface)`, uses: impls });
					if (tests.length) evidence.push({ label: `tests using \`${name}\``, uses: tests });
				}
			}
			if (isNew) {
				const dir = path.dirname(t.rel);
				for (const index of ["__init__.py", "index.ts", "index.tsx", "index.js"]) {
					const f = path.join(dir, index);
					if (fs.existsSync(path.join(root, f))) {
						const exports = fs.readFileSync(path.join(root, f), "utf8").split("\n").map((l, i) => [f, i + 1, l.trim()] as Use).filter(u => /^(from|export|import)\b/.test(u[2])).slice(0, 4);
						evidence.push({ label: `package index ${f} (how this package exposes its modules)`, uses: exports.length ? exports : [[f, 1, "(no exports)"]] });
					}
				}
			}
			const unobservedFiles = new Set(evidence.flatMap(e => e.uses.map(u => u[0])).filter(f => !observed(f)));
			ledger("gate", { file: t.rel, names, evidence: evidence.map(e => ({ label: e.label, files: [...new Set(e.uses.map(u => u[0]))] })), unobserved: [...unobservedFiles] });
			if (unobservedFiles.size === 0) continue;
			let budget = MAX_LINES;
			const body = evidence
				.map(e => {
					const shownUses = e.uses.slice(0, Math.max(0, budget));
					budget -= shownUses.length;
					const more = e.uses.length - shownUses.length;
					return [`- ${e.label}:`, ...shownUses.map(([f, l, c]) => `    ${f}:${l}  ${c}`), ...(more > 0 ? [`    (+${more} more)`] : [])].join("\n");
				})
				.join("\n");
			sections.push(`${t.rel}${names.length ? ` (changing ${names.map(n => `\`${n}\``).join(", ")})` : " (new file)"}:\n${body}`);
		}
		if (sections.length === 0) return;
		return {
			block: true,
			reason: `Evidence gate: this edit affects code you have not looked at yet.\n${sections.join("\n\n")}\n\nCheck that your change keeps each of these working and consistent (read the surrounding code where it matters), then retry the edit. It will not be blocked again.`,
		};
	});
}
