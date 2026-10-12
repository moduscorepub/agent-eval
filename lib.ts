import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ROOT = import.meta.dir;
export const REAL_HOME = os.homedir();
export const AGENT_BIN = process.env.AGENT_BIN ?? path.join(REAL_HOME, ".local/bin/harness");

export interface RepoConfig {
	path: string;
	/** Installs dependencies in a fresh checkout. */
	setup: string;
	/** Test command; `{files}` is replaced with the hidden test files. */
	test: string;
}

export interface Task {
	id: string;
	repo: string;
	repoPath: string;
	sha: string;
	parent: string;
	setup: string;
	test: string;
	/** Every test-side file the reference commit touched (fixtures included). */
	testFiles: string[];
	/** Test files handed to the test runner. */
	runnableTests: string[];
	ref: { srcAdded: number; srcRemoved: number; files: number };
	message: string;
	statement: string;
}

export const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, REAL_HOME);
export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));
export const writeJson = (file: string, value: unknown) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
};
export const baseDir = (taskId: string) => path.join(ROOT, "work", "bases", taskId);

// The filename-suffix rule applies to code only: `docs/meetings/<date>-test.md` is a generated note, not a test.
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|rs|swift|go)$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|swift|go)$/;
const DEP_RE =
	/(^|\/)(package\.json|pnpm-lock\.yaml|bun\.lockb?|package-lock\.json|yarn\.lock|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|Cargo\.(toml|lock)|go\.(mod|sum))$/;
export type FileKind = "test" | "dep" | "src" | "other";
export const fileKind = (file: string): FileKind =>
	TEST_RE.test(file) ? "test" : DEP_RE.test(file) ? "dep" : CODE_RE.test(file) ? "src" : "other";
export const isCode = (file: string) => CODE_RE.test(file);

/** A run's patch without lockfile hunks (and without test files when `prodOnly`), capped for argv limits. */
export function readPatch(file: string, prodOnly: boolean): string {
	if (!fs.existsSync(file)) return "(no patch)";
	const text = fs
		.readFileSync(file, "utf8")
		.split(/^(?=diff --git )/m)
		.filter(chunk => {
			const target = chunk.match(/^diff --git a\/(\S+)/)?.[1] ?? "";
			return !/(lock|\.lockb)$/.test(target) && !(prodOnly && fileKind(target) === "test");
		})
		.join("");
	return text.length > 60_000 ? `${text.slice(0, 60_000)}\n... (truncated)` : text || "(empty patch: no changes)";
}

/** Every run directory under `runDir`: `<task>/<condition>-s<seed>` with a result.json. */
export function runDirs(runDir: string): { task: string; condition: string; seed: number; dir: string }[] {
	const out: { task: string; condition: string; seed: number; dir: string }[] = [];
	for (const task of fs.readdirSync(runDir)) {
		const taskDir = path.join(runDir, task);
		if (!fs.statSync(taskDir).isDirectory()) continue;
		for (const job of fs.readdirSync(taskDir)) {
			const m = /^(.+)-s(\d+)$/.exec(job);
			if (m && fs.existsSync(path.join(taskDir, job, "result.json"))) {
				out.push({ task, condition: m[1]!, seed: Number(m[2]), dir: path.join(taskDir, job) });
			}
		}
	}
	return out;
}

export interface ExecResult {
	code: number;
	out: string;
	ms: number;
	timedOut: boolean;
}

/** Run a command, merging stdout+stderr into `out` (or streaming stdout to `stdoutFile`). */
export async function exec(
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number; stdoutFile?: string; stdinText?: string } = {},
): Promise<ExecResult> {
	const start = Date.now();
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		stdin: opts.stdinText !== undefined ? new Blob([opts.stdinText]) : "ignore",
		stdout: opts.stdoutFile ? Bun.file(opts.stdoutFile) : "pipe",
		stderr: "pipe",
		timeout: opts.timeoutMs,
		killSignal: "SIGKILL",
	});
	const [out, err] = await Promise.all([
		proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : "",
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	const ms = Date.now() - start;
	return { code, out: out + err, ms, timedOut: opts.timeoutMs !== undefined && ms >= opts.timeoutMs };
}

export const sh = (script: string, opts: Parameters<typeof exec>[1] = {}) => exec(["bash", "-c", script], opts);

export async function mustSh(script: string, opts: Parameters<typeof exec>[1] = {}): Promise<string> {
	const res = await sh(script, opts);
	if (res.code !== 0) throw new Error(`command failed (${res.code}): ${script}\n${res.out.slice(-2000)}`);
	return res.out;
}

export const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Fresh repo holding history up to `parent` only, so the reference commit cannot leak. */
export async function ensureBase(task: Pick<Task, "id" | "repoPath" | "parent">): Promise<string> {
	const dir = baseDir(task.id);
	if (fs.existsSync(path.join(dir, ".git"))) return dir;
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	await mustSh(
		`git init -q && git fetch -q ${q(task.repoPath)} ${task.parent} && git checkout -q -b main FETCH_HEAD`,
		{ cwd: dir },
	);
	return dir;
}

/** Copy-on-write clone of a base checkout (APFS clonefile). */
export async function cloneBase(taskId: string, dest: string): Promise<void> {
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	await mustSh(`cp -cR ${q(baseDir(taskId))} ${q(dest)}`);
}

/** Write the reference commit's version of `files` into `dir` (deleting files the commit deleted). */
export function applyRef(task: Pick<Task, "repoPath" | "sha">, dir: string, files: string[]): void {
	for (const file of files) {
		const target = path.join(dir, file);
		const show = Bun.spawnSync(["git", "-C", task.repoPath, "show", `${task.sha}:${file}`]);
		if (show.exitCode !== 0) {
			fs.rmSync(target, { force: true });
			continue;
		}
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, show.stdout);
	}
}

export const testCommand = (task: Pick<Task, "test" | "runnableTests">) =>
	task.test.replace("{files}", task.runnableTests.map(q).join(" "));

/** Env for an isolated agent: throwaway HOME (no personal skills/config), shared caches, env auth. */
export function agentEnv(home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^(PI|OMP|HARNESS)_/.test(key)) env[key] = value;
	}
	const shared = path.join(ROOT, ".shared-data");
	fs.mkdirSync(path.join(shared, "harness"), { recursive: true });
	return {
		...env,
		HOME: home,
		XDG_DATA_HOME: shared,
		ANTHROPIC_API_KEY: process.env.EVAL_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
		UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(REAL_HOME, ".cache/uv"),
		UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR ?? path.join(REAL_HOME, ".local/share/uv/python"),
		npm_config_store_dir: process.env.npm_config_store_dir ?? path.join(REAL_HOME, "Library/pnpm/store/v11"),
		GIT_AUTHOR_NAME: "eval",
		GIT_AUTHOR_EMAIL: "eval@example.com",
		GIT_COMMITTER_NAME: "eval",
		GIT_COMMITTER_EMAIL: "eval@example.com",
	};
}

export interface Usage {
	cost: number;
	tokens: number;
	toolCalls: number;
	finalText: string;
	/** Stop reason of the last assistant message ("stop", "toolUse", "error", "aborted", ...). */
	lastStop: string;
	/** Error text of the last assistant message, when the provider call failed. */
	lastError: string;
}

/** A run that ended on a provider/transport failure or an external kill, not the agent's own decision. */
export const isInfraFailure = (u: Pick<Usage, "lastStop" | "toolCalls" | "cost">, exitCode: number, timedOut: boolean) =>
	!timedOut &&
	(u.lastStop === "error" || u.lastStop === "aborted" || u.lastStop === "" || exitCode === 143 || exitCode === 137 || (exitCode !== 0 && u.cost === 0));

/** Sum assistant usage and pick the final assistant text from a `--mode json` event stream. */
export function readUsage(eventsFile: string): Usage {
	const usage: Usage = { cost: 0, tokens: 0, toolCalls: 0, finalText: "", lastStop: "", lastError: "" };
	if (!fs.existsSync(eventsFile)) return usage;
	for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "tool_execution_end") usage.toolCalls++;
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		usage.cost += event.message.usage?.cost?.total ?? 0;
		usage.tokens += event.message.usage?.totalTokens ?? 0;
		usage.lastStop = String(event.message.stopReason ?? "");
		usage.lastError = String(event.message.errorMessage ?? "");
		const content = event.message.content;
		const text = Array.isArray(content)
			? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n")
			: typeof content === "string"
				? content
				: "";
		if (text.trim()) usage.finalText = text;
	}
	return usage;
}

/** One isolated headless agent run; events stream to `eventsFile`. */
export async function runAgent(args: {
	cwd: string;
	prompt: string;
	model: string;
	extensions?: string[];
	/** Config overlays (config.yml-style, relative to the eval root) loaded with --config. */
	configs?: string[];
	eventsFile: string;
	timeoutMs: number;
	tools?: string;
	/** Extra env for the agent process (e.g. GRAIN_LOG for per-run hook ledgers). */
	env?: Record<string, string>;
}): Promise<ExecResult & Usage> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pt-home-"));
	try {
		fs.mkdirSync(path.dirname(args.eventsFile), { recursive: true });
		const cmd = [
			AGENT_BIN,
			"--no-extensions",
			...(args.extensions ?? []).flatMap(ext => ["-e", path.resolve(ROOT, ext)]),
			...(args.configs ?? []).flatMap(cfg => ["--config", path.resolve(ROOT, cfg)]),
			"--model",
			args.model,
			"--mode",
			"json",
			...(args.tools ? ["--tools", args.tools] : []),
			"-p",
			// The prompt goes in on stdin: in argv it would be matched (and killed) by an agent's
			// `pkill -f <text from the task>` running in a concurrent run.
			"-",
		];
		const res = await exec(cmd, {
			cwd: args.cwd,
			env: { ...agentEnv(home), ...args.env },
			timeoutMs: args.timeoutMs,
			stdoutFile: args.eventsFile,
			stdinText: args.prompt,
		});
		return { ...res, ...readUsage(args.eventsFile) };
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) await fn(items[next++]!);
	});
	await Promise.all(workers);
}

export function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}
