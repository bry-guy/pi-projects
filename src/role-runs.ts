// Role runs started by role_agent: waiting for one in the foreground, and delivering background results to the
// session that started them. No pi-ai import, so tests can load it.
import { readFileSync } from "node:fs";

export const RESULT = "role-result";
export const FINAL = new Set(["done", "error", "stopped", "stalled", "died"]);
export const WAIT_LIMIT = 15 * 60_000;
/** A run record appears once the runner starts; until then a missing record isn't a dead run. */
const START_GRACE = 30_000;

/** The parts of pi-background's Run (src/registry.ts) used here. */
export interface RunInfo {
	pid: number;
	status: string;
	error?: string;
	waiting?: { title: string; message?: string }[];
}
export interface BgApi {
	start(o: { cwd: string; msg: string; env?: Record<string, string>; name?: string }): { file: string; pid: number };
	runs(): RunInfo[];
	/** Missing in pi-background before stop() was published. */
	stop?(pid: number): boolean;
}
export interface Sender {
	sendMessage(message: any, options?: any): void;
}
export interface Pending {
	parentFile: string;
	pid: number;
	role: string;
	file: string;
}

export const bg = (): BgApi | undefined => (globalThis as any)[Symbol.for("pi-background.v1")];

// pi re-runs extension factories per session (in-process subagents too), so delivery state lives at module level.
export const pending: Pending[] = [];
/** Open sessions in this process by session file; a result goes only to the session that started the run. */
export const sessions = new Map<string, Sender>();
let poller: NodeJS.Timeout | undefined;

/** Last assistant text in a session file. */
export function lastReply(file: string): string {
	let text = "";
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const e = JSON.parse(line);
			if (e.type === "message" && e.message?.role === "assistant") {
				const t = [e.message.content].flat().filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
				if (t.trim()) text = t;
			}
		} catch {}
	}
	return text.length > 6000 ? `…${text.slice(-6000)}` : text;
}

function replyOf(file: string): string {
	try {
		return lastReply(file);
	} catch {
		return "";
	}
}

/** Sends ended runs' results to their parent sessions; runs whose parent isn't open here stay pending. */
export function deliver() {
	if (!pending.length) return;
	const runs = bg()?.runs() ?? [];
	for (const p of [...pending]) {
		const to = sessions.get(p.parentFile);
		if (!to) continue;
		const r = runs.find((x) => x.pid === p.pid);
		if (r && !FINAL.has(r.status)) continue;
		pending.splice(pending.indexOf(p), 1);
		const status = r?.status ?? "died";
		to.sendMessage(
			{
				customType: RESULT,
				display: true,
				content: `Role run ${p.role} ended: ${status}${r?.error ? ` (${r.error})` : ""}.\nSession: ${p.file}\n\n${replyOf(p.file) || "(no reply)"}`,
				details: { role: p.role, status, file: p.file },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}
	if (!pending.length && poller) {
		clearInterval(poller);
		poller = undefined;
	}
}

/** Deliver this run's result as a message when it ends. */
export function track(p: Pending) {
	if (!p.parentFile) return; // an unsaved session can't be found again
	pending.push(p);
	poller ??= setInterval(deliver, 10_000);
	poller.unref?.();
}

export type Step =
	| { act: "wait"; progress: string }
	| { act: "final"; status: string; error?: string }
	| { act: "handover"; why: string }
	| { act: "stop" };

const clock = (ms: number) => {
	const s = Math.floor(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** What a foreground wait does next, given the run's current record. */
export function waitStep(run: RunInfo | undefined, role: string, elapsed: number, aborted: boolean, limit = WAIT_LIMIT): Step {
	if (aborted) return { act: "stop" };
	if (!run) return elapsed < START_GRACE ? { act: "wait", progress: `${role}: starting ${clock(elapsed)}` } : { act: "final", status: "died" };
	if (FINAL.has(run.status)) return { act: "final", status: run.status, error: run.error };
	const q = run.waiting?.[0];
	if (q) return { act: "handover", why: `it is waiting on you: ${q.title}${q.message ? ` (${q.message})` : ""}` };
	if (elapsed >= limit) return { act: "handover", why: `it is still running after ${clock(elapsed)}` };
	return { act: "wait", progress: `${role}: ${run.status === "waiting" ? "starting" : "running"} ${clock(elapsed)}` };
}

export interface WaitResult {
	text: string;
	isError: boolean;
	status: string;
	/** The run continues; its result arrives later as a message. */
	background: boolean;
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((done) => {
		const t = setTimeout(done, ms);
		signal?.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
	});

/** Waits for a started run and returns its reply. Throws when aborted (after stopping the run, if pi-background can). */
export async function waitForRun(
	run: Pending,
	o: { signal?: AbortSignal; onUpdate?: (text: string) => void; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; limit?: number } = {},
): Promise<WaitResult> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? sleepFor;
	const t0 = now();
	for (;;) {
		const api = bg();
		const r = api?.runs().find((x) => x.pid === run.pid);
		const step = waitStep(r, run.role, now() - t0, !!o.signal?.aborted, o.limit);
		if (step.act === "wait") {
			o.onUpdate?.(step.progress);
			await sleep(5_000, o.signal);
			continue;
		}
		if (step.act === "final") {
			const head = `${run.role} run ${step.status} (session: ${run.file})${step.error ? `\nError: ${step.error}` : ""}`;
			return { text: `${head}\n\n${replyOf(run.file) || "(no reply)"}`, isError: step.status !== "done", status: step.status, background: false };
		}
		if (step.act === "handover") {
			track(run);
			return {
				text: `${run.role} continues in the background: ${step.why}. Its result will arrive here as a message when it ends. Session: ${run.file}`,
				isError: false,
				status: r?.status ?? "running",
				background: true,
			};
		}
		if (api?.stop) {
			api.stop(run.pid);
			throw new Error(`Aborted: stopped ${run.role} (session: ${run.file})`);
		}
		track(run);
		throw new Error(`Aborted, but this pi-background can't stop runs: ${run.role} keeps running and its result will arrive as a message (session: ${run.file})`);
	}
}
