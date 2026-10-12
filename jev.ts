/**
 * Minimal client for TypeSafe's System One endpoint (Jev), with an on-disk cache so every replay is
 * reproducible and repeated analyses cost nothing. The model is pinned to a versioned ID.
 *
 * Key: JEV_API_KEY. Usage is appended to replay/jev-usage.jsonl (uncached calls only).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "./lib";

export const JEV_MODEL = process.env.JEV_MODEL ?? "jev-1.13.0";
/** USD per input token (output tokens are free). */
export const JEV_PRICE = 0.042 / 1_000_000;
const CACHE = path.join(ROOT, "replay", "jev-cache");
const USAGE = path.join(ROOT, "replay", "jev-usage.jsonl");
const MAX_IN_FLIGHT = Number(process.env.JEV_CONCURRENCY ?? 4);

export type Question =
	| { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
	| { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
	| { type: "score"; instructions: unknown; criteria: unknown[] };

export interface Answer {
	type: "noul" | "choice" | "score";
	noul?: number;
	choice?: string;
	score?: number;
	probabilities?: Record<string, number>;
	confidence?: number;
}

export interface JevResult {
	model: string;
	answers: Record<string, Answer>;
	inputTokens: number;
	ms: number;
	cached: boolean;
}

let inFlight = 0;
const waiters: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
	while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>(r => waiters.push(r));
	inFlight++;
	try {
		return await fn();
	} finally {
		inFlight--;
		waiters.shift()?.();
	}
}

/** Ask `questions` about `state`. `nocache` forces a live call (used to measure repeat-call stability). */
export async function jev(state: unknown, questions: Record<string, Question>, opts: { nocache?: boolean } = {}): Promise<JevResult> {
	const key = process.env.JEV_API_KEY;
	if (!key) throw new Error("JEV_API_KEY is not set");
	const body = JSON.stringify({ model: JEV_MODEL, state, questions });
	const file = path.join(CACHE, `${createHash("sha256").update(body).digest("hex")}.json`);
	if (!opts.nocache && fs.existsSync(file)) return { ...(JSON.parse(fs.readFileSync(file, "utf8")) as JevResult), cached: true };
	return slot(async () => {
		for (let attempt = 0; ; attempt++) {
			const t0 = performance.now();
			let res: Response;
			try {
				res = await fetch("https://api.typesafe.ai/v1/systemone", {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body,
					signal: AbortSignal.timeout(60_000),
				});
			} catch (err) {
				if (attempt >= 6) throw err;
				await Bun.sleep(1000 * 2 ** attempt);
				continue;
			}
			if (res.status === 429 || res.status >= 500) {
				if (attempt >= 6) throw new Error(`Jev HTTP ${res.status} after ${attempt + 1} attempts`);
				const retryAfter = Number(res.headers.get("retry-after"));
				await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
				continue;
			}
			if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
			const json = (await res.json()) as { model: string; answers: Record<string, Answer>; usage: { input_tokens: number } };
			const out: JevResult = { model: json.model, answers: json.answers, inputTokens: json.usage.input_tokens, ms: performance.now() - t0, cached: false };
			fs.mkdirSync(CACHE, { recursive: true });
			if (!opts.nocache) fs.writeFileSync(file, JSON.stringify(out));
			fs.appendFileSync(USAGE, `${JSON.stringify({ t: Date.now(), inputTokens: out.inputTokens, ms: Math.round(out.ms), questions: Object.keys(questions).length })}\n`);
			return out;
		}
	});
}

/** Total live Jev spend so far, from the usage ledger. */
export function jevSpend(): { calls: number; tokens: number; usd: number } {
	if (!fs.existsSync(USAGE)) return { calls: 0, tokens: 0, usd: 0 };
	const rows = fs.readFileSync(USAGE, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as { inputTokens: number });
	const tokens = rows.reduce((a, r) => a + r.inputTokens, 0);
	return { calls: rows.length, tokens, usd: tokens * JEV_PRICE };
}
