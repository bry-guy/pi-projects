// Role runs started by role_agent: waiting for one in the foreground, and delivering background results to the
// session that started them. No pi-ai import, so tests can load it.
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename } from "node:path";

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
	/** What the run is doing now; null when nothing. Absent in pi-background before it recorded this. */
	activity?: string | null;
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
	/** When the run was started (ms); bounds how long a live pid without a record is waited on. */
	started: number;
}

export const bg = (): BgApi | undefined => (globalThis as any)[Symbol.for("pi-background.v1")];

/**
 * A runner the host process offers in place of pi-background (pi-web's workers do). It runs the role in a sandbox
 * of its own, decides again whether the project may use the role, and rejects with a plain reason when it can't.
 */
export interface HostRunner {
	run(o: {
		/** Project name */
		project: string;
		role: string;
		/** First message of the run (roleRunStart) */
		msg: string;
		name: string;
		/** Folder relative to the project, "." for its root */
		cwd: string;
		/** Id of the calling session, where a late result is delivered */
		session: string;
		background: boolean;
		signal?: AbortSignal;
		onUpdate?: (text: string) => void;
	}): Promise<WaitResult>;
}

/** Who runs a role: the host's runner when it offers one (pi-background is then never used), else pi-background. */
export function runner(): { host: HostRunner; start?: undefined } | { host?: undefined; start: BgApi["start"] } | undefined {
	const host: HostRunner | undefined = (globalThis as any)[Symbol.for("pi-role-runner.v1")];
	if (host) return { host };
	const api = bg();
	return api?.start ? { start: (o) => api.start(o) } : undefined;
}

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

/** True if `pid` runs and is a node/pi process (like pi-background's alive(): a reused pid of another program is dead). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	try {
		return /node|pi/i.test(basename(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0]!));
	} catch {}
	try {
		return /node|pi/i.test(execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }));
	} catch {
		return true; // ps missing or failed: trust kill(0)
	}
}

/**
 * The newest pi-summarize activity line in a session file, from its last `max` bytes (a cut first or partial last
 * line is skipped). Only those entries, never model text or thinking.
 */
export function latestActivity(file: string, max = 64 * 1024): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		const len = Math.min(size, max);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		const lines = buf.toString("utf8").split("\n");
		if (len < size) lines.shift();
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i]!.includes('"pi-summarize"')) continue;
			try {
				const e = JSON.parse(lines[i]!);
				const text = e.type === "custom" && e.customType === "pi-summarize" && e.data?.kind === "activity" ? e.data.text : undefined;
				const clean = typeof text === "string" ? text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim() : "";
				if (clean) return clean.length > 100 ? `${clean.slice(0, 99)}…` : clean;
			} catch {}
		}
	} catch {
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return undefined;
}

/** Sends ended runs' results to their parent sessions; runs whose parent isn't open here stay pending. */
export function deliver(alive = pidAlive, now = Date.now) {
	if (!pending.length) return;
	const runs = bg()?.runs() ?? [];
	for (const p of [...pending]) {
		const to = sessions.get(p.parentFile);
		if (!to) continue;
		const r = runs.find((x) => x.pid === p.pid);
		if (r && !FINAL.has(r.status)) continue;
		// No record but a live pid: still starting, unless it's been too long (the pid may have been reused).
		if (!r && alive(p.pid) && now() - p.started < WAIT_LIMIT) continue;
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
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** What a foreground wait does next, given the run's current record. */
export function waitStep(
	run: RunInfo | undefined,
	role: string,
	elapsed: number,
	aborted: boolean,
	limit = WAIT_LIMIT,
	o: { activity?: string; gone?: boolean } = {},
): Step {
	const progress = (fallback: string) => ({ act: "wait" as const, progress: `${role}: ${o.activity || fallback} · ${clock(elapsed)}` });
	if (aborted) return { act: "stop" };
	// A missing record is a run still starting, or one caught mid-rewrite: dead only once its process is gone.
	if (!run) {
		if (elapsed < START_GRACE) return progress("starting");
		if (o.gone !== false) return { act: "final", status: "died" };
		// The pid may belong to another process now: hand over, and deliver() reports it died.
		if (elapsed >= limit) return { act: "handover", why: `it has no run record after ${clock(elapsed)}` };
		return progress("running");
	}
	if (FINAL.has(run.status)) return { act: "final", status: run.status, error: run.error };
	const q = run.waiting?.[0];
	if (q) return { act: "handover", why: `it is waiting on you: ${q.title}${q.message ? ` (${q.message})` : ""}` };
	if (elapsed >= limit) return { act: "handover", why: `it is still running after ${clock(elapsed)}` };
	return progress(run.status === "waiting" ? "starting" : "running");
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
	o: {
		signal?: AbortSignal;
		onUpdate?: (text: string) => void;
		now?: () => number;
		sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
		limit?: number;
		alive?: (pid: number) => boolean;
	} = {},
): Promise<WaitResult> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? sleepFor;
	const t0 = now();
	for (;;) {
		const api = bg();
		const r = api?.runs().find((x) => x.pid === run.pid);
		// The record's activity is live; the session's pi-summarize line is written when a step ends (older pi-background only).
		const activity = r && r.activity !== undefined ? (r.activity ?? undefined) : latestActivity(run.file);
		const gone = r ? undefined : !(o.alive ?? pidAlive)(run.pid);
		const step = waitStep(r, run.role, now() - t0, !!o.signal?.aborted, o.limit, { activity, gone });
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
