/**
 * checkers: the project's own checkers after every edit, new findings only, enforced before finishing.
 *
 * Detected per repository:
 * - Python: ruff (when configured in pyproject), mypy (when configured), else basedpyright errors.
 * - TypeScript/JavaScript: project-wide `tsc --noEmit` (when a tsconfig and tsc exist) and oxlint
 *   (when the project's lint script uses it).
 * Findings present before the agent's change are the baseline and never reported. After each edit,
 * findings new in the edited file are appended to the tool result (once each). When the agent is
 * about to finish, every edited file is re-checked; remaining new findings continue the session once.
 * Caches live outside the repository so the patch stays clean. Ledger: HOOK_LOG_DIR/checkers.jsonl.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CODE, editTargets, ledger, repoRoot, run, runAsync } from "../shared";

export interface Finding {
	file: string;
	line: number;
	tool: string;
	code: string;
	message: string;
}
export const keyOf = (f: Finding) => `${f.file}|${f.tool}|${f.code}|${f.message.replace(/\s+/g, " ").replace(/line \d+/g, "line N")}`;
const show = (f: Finding) => `- ${f.file}:${f.line} [${f.tool}${f.code ? ` ${f.code}` : ""}] ${f.message.split("\n")[0]!.slice(0, 220)}`;

export interface Toolchain {
	ruff?: string;
	mypy?: string;
	pyright?: string;
	python?: string;
	tsc?: string;
	oxlint?: string;
}

export function detect(root: string): Toolchain {
	const tc: Toolchain = {};
	const exists = (p: string) => fs.existsSync(path.join(root, p));
	const pyproject = exists("pyproject.toml") ? fs.readFileSync(path.join(root, "pyproject.toml"), "utf8") : "";
	if (pyproject) {
		if (exists(".venv/bin/python")) tc.python = path.join(root, ".venv/bin/python");
		if (exists(".venv/bin/ruff") && pyproject.includes("[tool.ruff")) tc.ruff = path.join(root, ".venv/bin/ruff");
		if (exists(".venv/bin/mypy") && pyproject.includes("[tool.mypy")) tc.mypy = path.join(root, ".venv/bin/mypy");
		else if (Bun.which("basedpyright")) tc.pyright = Bun.which("basedpyright")!;
	}
	if (exists("tsconfig.json") && exists("node_modules/.bin/tsc")) tc.tsc = path.join(root, "node_modules/.bin/tsc");
	const pkg = exists("package.json") ? fs.readFileSync(path.join(root, "package.json"), "utf8") : "";
	if (exists("node_modules/.bin/oxlint") && /"lint"\s*:\s*"[^"]*oxlint/.test(pkg)) tc.oxlint = path.join(root, "node_modules/.bin/oxlint");
	return tc;
}

/** Per-file checkers (everything except project-wide tsc). */
export function checkFile(root: string, tc: Toolchain, rel: string, cache: string): Finding[] {
	const out: Finding[] = [];
	if (!fs.existsSync(path.join(root, rel))) return out;
	if (rel.endsWith(".py")) {
		if (tc.ruff) {
			try {
				for (const d of JSON.parse(run([tc.ruff, "check", "--output-format", "json", "--no-cache", rel], root).out || "[]")) {
					out.push({ file: rel, line: d.location?.row ?? 0, tool: "ruff", code: d.code ?? "", message: d.message ?? "" });
				}
			} catch {}
		}
		if (tc.mypy) {
			const res = run([tc.mypy, "--cache-dir", path.join(cache, "mypy"), "--no-error-summary", "--show-error-codes", "--no-pretty", "--show-column-numbers", rel], root);
			for (const line of res.out.split("\n")) {
				const m = /^(.+?):(\d+):(?:\d+:)? error: (.*?)(?:\s+\[([\w-]+)\])?$/.exec(line);
				if (m && path.normalize(m[1]!) === rel) out.push({ file: rel, line: Number(m[2]), tool: "mypy", code: m[4] ?? "", message: m[3]! });
			}
		} else if (tc.pyright) {
			const args = [tc.pyright, "--outputjson", "--level", "error", ...(tc.python ? ["--pythonpath", tc.python] : []), rel];
			try {
				for (const d of JSON.parse(run(args, root).out).generalDiagnostics ?? []) {
					if (d.severity === "error") out.push({ file: rel, line: (d.range?.start?.line ?? 0) + 1, tool: "pyright", code: d.rule ?? "", message: d.message ?? "" });
				}
			} catch {}
		}
	} else if (tc.oxlint) {
		try {
			for (const d of JSON.parse(run([tc.oxlint, "-f", "json", rel], root).out).diagnostics ?? []) {
				out.push({ file: rel, line: d.labels?.[0]?.span?.line ?? 0, tool: "oxlint", code: d.code ?? "", message: d.message ?? "" });
			}
		} catch {}
	}
	return out;
}

export async function checkProject(root: string, tc: Toolchain, cache: string): Promise<Finding[]> {
	if (!tc.tsc) return [];
	const res = await runAsync([tc.tsc, "--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile", path.join(cache, "tsbuildinfo"), "-p", "tsconfig.json"], root);
	const out: Finding[] = [];
	for (const line of res.out.split("\n")) {
		const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line);
		if (m) out.push({ file: path.normalize(m[1]!), line: Number(m[2]), tool: "tsc", code: m[3]!, message: m[4]! });
	}
	return out;
}

export default function checkers(pi: any) {
	let root = "";
	let tc: Toolchain = {};
	let cache = "";
	let projectBaseline: Promise<Set<string>> | undefined;
	const fileBaseline = new Map<string, Set<string>>();
	const edited = new Set<string>();
	const reported = new Set<string>();
	let continued = false;

	const ensure = (cwd: string) => {
		if (root) return true;
		root = repoRoot(cwd);
		if (!root) return false;
		tc = detect(root);
		cache = fs.mkdtempSync(path.join(os.tmpdir(), "checkers-"));
		if (tc.tsc) projectBaseline = checkProject(root, tc, cache).then(fs_ => new Set(fs_.map(keyOf)));
		ledger("checkers", { toolchain: Object.keys(tc) });
		return true;
	};

	/** New findings in `files`, given the baselines. */
	const newFindings = async (files: string[]): Promise<Finding[]> => {
		const found: Finding[] = files.flatMap(f => checkFile(root, tc, f, cache).filter(x => !fileBaseline.get(f)?.has(keyOf(x))));
		if (tc.tsc && files.some(f => /\.(ts|tsx|js|jsx|mts|cts)$/.test(f))) {
			const base = await projectBaseline!;
			const set = new Set(files);
			found.push(...(await checkProject(root, tc, cache)).filter(x => set.has(x.file) && !base.has(keyOf(x))));
		}
		return found;
	};

	pi.on("session_start", (_e: any, ctx: any) => {
		ensure(ctx.cwd);
	});

	// Baseline each file before its first edit.
	pi.on("tool_call", (event: any, ctx: any) => {
		if ((event.toolName !== "edit" && event.toolName !== "write") || !ensure(ctx.cwd)) return;
		for (const t of editTargets(event, ctx.cwd, root)) {
			if (!CODE.test(t.rel) || fileBaseline.has(t.rel)) continue;
			fileBaseline.set(t.rel, new Set(checkFile(root, tc, t.rel, cache).map(keyOf)));
		}
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError || !ensure(ctx.cwd)) return;
		const files = editTargets(event, ctx.cwd, root).map(t => t.rel).filter(f => CODE.test(f));
		if (files.length === 0) return;
		for (const f of files) edited.add(f);
		const fresh = (await newFindings(files)).filter(f => !reported.has(keyOf(f)));
		for (const f of fresh) reported.add(keyOf(f));
		ledger("checkers", { after: event.toolName, files, newFindings: fresh });
		if (fresh.length === 0) return;
		return {
			additionalContext: `Project checkers report new findings in code you just changed (not present before your change):\n${fresh.slice(0, 12).map(show).join("\n")}${fresh.length > 12 ? `\n(+${fresh.length - 12} more)` : ""}`,
		};
	});

	pi.on("session_stop", async (event: any, ctx: any) => {
		if (continued || event.stop_hook_active || edited.size === 0 || !ensure(ctx.cwd)) return;
		const remaining = await newFindings([...edited]);
		ledger("checkers", { atStop: true, remaining });
		if (remaining.length === 0) return;
		continued = true;
		return {
			continue: true,
			additionalContext: `Before finishing: the project's checkers still report findings that your change introduced:\n${remaining.slice(0, 15).map(show).join("\n")}${remaining.length > 15 ? `\n(+${remaining.length - 15} more)` : ""}\nFix them, or state briefly why a finding is a false positive.`,
		};
	});
}
