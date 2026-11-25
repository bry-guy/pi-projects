import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { deliver, latestActivity, pending, type RunInfo, runner, sessions, stillRunning, waitForRun, waitStep } from "../src/role-runs.ts";
import { roleLines } from "../src/roles.ts";

const KEY = Symbol.for("pi-background.v1");

/** A session file whose last assistant reply is `reply`. */
function sessionFile(reply: string): string {
	const file = join(mkdtempSync(join(tmpdir(), "role-runs-")), "s.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }] } })}\n`);
	return file;
}

/** pi-background stand-in: runs() returns the next record of `seq` (the last one repeats). */
function fakeBg(seq: (RunInfo | undefined)[], withStop = true) {
	const stopped: number[] = [];
	let i = 0;
	const api: any = { runs: () => { const r = seq[Math.min(i++, seq.length - 1)]; return r ? [r] : []; } };
	if (withStop) api.stop = (pid: number) => (stopped.push(pid), true);
	(globalThis as any)[KEY] = api;
	return { stopped };
}

/** Fake clock: each sleep advances it by the slept time. */
function clock() {
	let t = 0;
	return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const run = (file: string, parentFile = "/parent.jsonl") => ({ parentFile, pid: 7, role: "r/dev", file, started: Date.now() });
const rec = (status: string, extra: Partial<RunInfo> = {}): RunInfo => ({ pid: 7, status, ...extra });

beforeEach(() => {
	pending.length = 0;
	sessions.clear();
});

test("waitStep decisions", () => {
	assert.deepEqual(waitStep(rec("running"), "r/dev", 130_000, false), { act: "wait", progress: "r/dev: running · 2m 10s" });
	assert.equal(waitStep(undefined, "r/dev", 5_000, false).act, "wait");
	assert.deepEqual(waitStep(undefined, "r/dev", 60_000, false), { act: "final", status: "died" });
	assert.deepEqual(waitStep(rec("error", { error: "boom" }), "r/dev", 0, false), { act: "final", status: "error", error: "boom" });
	assert.deepEqual(waitStep(rec("running", { waiting: [{ title: "Push?" }] }), "r/dev", 0, false), { act: "handover", why: "it is waiting on you: Push?" });
	assert.equal(waitStep(rec("running"), "r/dev", 15 * 60_000, false).act, "handover");
	assert.deepEqual(waitStep(rec("done"), "r/dev", 0, true), { act: "stop" });
});

test("done: returns the reply, reports progress, and is never delivered again", async () => {
	const file = sessionFile("all merged");
	fakeBg([rec("waiting"), rec("running"), rec("done")]);
	const updates: string[] = [];
	const r = await waitForRun(run(file), { ...clock(), onUpdate: (t) => updates.push(t) });
	assert.equal(r.text, `r/dev run done (session: ${file})\n\nall merged`);
	assert.equal(r.isError, false);
	assert.deepEqual(updates, ["r/dev: starting · 0s", "r/dev: running · 5s"]);
	assert.equal(pending.length, 0);
	const sent: any[] = [];
	sessions.set("/parent.jsonl", { sendMessage: (m) => sent.push(m) });
	deliver();
	assert.equal(sent.length, 0);
});

test("non-done status is an error result of the same shape", async () => {
	const file = sessionFile("half done");
	fakeBg([rec("stalled", { error: "no progress for 10 minutes" })]);
	const r = await waitForRun(run(file), clock());
	assert.equal(r.isError, true);
	assert.match(r.text, /^r\/dev run stalled \(session: .*\)\nError: no progress for 10 minutes\n\nhalf done$/);
});

test("a question hands the run over to background delivery", async () => {
	const file = sessionFile("asked and answered");
	fakeBg([rec("running"), rec("running", { waiting: [{ title: "Merge PR?", message: "#12" }] }), rec("done")]);
	const r = await waitForRun(run(file), clock());
	assert.equal(r.background, true);
	assert.match(r.text, /waiting on you: Merge PR\? \(#12\)/);
	assert.equal(pending.length, 1);
	const sent: any[] = [];
	sessions.set("/parent.jsonl", { sendMessage: (m) => sent.push(m) });
	deliver(); // the stand-in now reports done
	assert.equal(sent.length, 1);
	assert.match(sent[0].content, /asked and answered/);
	assert.equal(pending.length, 0);
});

test("the wait limit hands over", async () => {
	fakeBg([rec("running")]);
	const r = await waitForRun(run(sessionFile("x")), { ...clock(), limit: 20_000 });
	assert.equal(r.background, true);
	assert.equal(pending.length, 1);
});

test("abort stops the run", async () => {
	const { stopped } = fakeBg([rec("running")]);
	const ac = new AbortController();
	const c = clock();
	const sleep = async (ms: number) => (await c.sleep(ms), ac.abort());
	await assert.rejects(waitForRun(run(sessionFile("x")), { now: c.now, sleep, signal: ac.signal }), /Aborted: stopped r\/dev/);
	assert.deepEqual(stopped, [7]);
	assert.equal(pending.length, 0);
});

test("abort with an older pi-background (no stop) leaves the run to background delivery", async () => {
	fakeBg([rec("running")], false);
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(waitForRun(run(sessionFile("x")), { ...clock(), signal: ac.signal }), /keeps running/);
	assert.equal(pending.length, 1);
});

test("results go only to the session that started the run", () => {
	fakeBg([rec("done")]);
	const a: any[] = [];
	const b: any[] = [];
	sessions.set("/a.jsonl", { sendMessage: (m) => a.push(m) });
	sessions.set("/b.jsonl", { sendMessage: (m) => b.push(m) });
	pending.push(run(sessionFile("for b"), "/b.jsonl"), { ...run(sessionFile("for c"), "/c.jsonl"), pid: 7 });
	deliver();
	assert.equal(a.length, 0);
	assert.equal(b.length, 1);
	assert.match(b[0].content, /for b/);
	assert.equal(pending.length, 1); // c is not open here: stays pending
	assert.equal(pending[0].parentFile, "/c.jsonl");
});

test("unsandboxed session with grants lists roles and nudges role_agent", () => {
	const lines = roleLines(
		{ sandbox: false, grant: { name: "p", roles: ["pi-web/pi-web-developer", "infra/infra-developer"] } },
		(id) => (id === "pi-web/pi-web-developer" ? "Develop pi-web" : undefined),
	);
	assert.deepEqual(lines, [
		"",
		"Granted roles (role_agent):",
		"- pi-web/pi-web-developer: Develop pi-web",
		"- infra/infra-developer",
		"Prefer role_agent for work that fits one of these roles: it runs sandboxed with only that role's credentials.",
		"Do the work yourself when it needs access no role has.",
	]);
});

test("sandboxed role session keeps the old wording", () => {
	const lines = roleLines({ sandbox: true, roleId: "a/x", role: { description: "X" }, grant: { name: "p", roles: ["a/x", "b/y"] } }, () => "unused");
	assert.deepEqual(lines.slice(3), ["Role: a/x (X).", "Granted roles you can delegate to with role_agent: b/y."]);
});

const activity = (text: string) => JSON.stringify({ type: "custom", customType: "pi-summarize", data: { kind: "activity", text, at: 1 } });

test("progress shows the run's latest activity line", () => {
	assert.deepEqual(waitStep(rec("running"), "r/dev", 380_000, false, undefined, { activity: "Fixing the DOM test" }), {
		act: "wait",
		progress: "r/dev: Fixing the DOM test · 6m 20s",
	});
	assert.deepEqual(waitStep(rec("waiting"), "r/dev", 3_000, false, undefined, {}), { act: "wait", progress: "r/dev: starting · 3s" });
});

test("waitForRun reports activity from the session file, never assistant text", async () => {
	const file = sessionFile("secret plan");
	writeFileSync(file, `${activity("Running the e2e suite")}\n`, { flag: "a" });
	fakeBg([rec("running"), rec("done")]);
	const updates: string[] = [];
	await waitForRun(run(file), { ...clock(), onUpdate: (t) => updates.push(t) });
	assert.deepEqual(updates, ["r/dev: Running the e2e suite · 0s"]);
});

test("waitForRun prefers the run record's activity; null means nothing, not the stale session line", async () => {
	const file = sessionFile("secret plan");
	writeFileSync(file, `${activity("Previous step")}\n`, { flag: "a" });
	fakeBg([{ ...rec("running"), activity: "running bash" }, { ...rec("running"), activity: null }, rec("done")]);
	const updates: string[] = [];
	await waitForRun(run(file), { ...clock(), onUpdate: (t) => updates.push(t) });
	assert.deepEqual(updates, ["r/dev: running bash · 0s", "r/dev: running · 5s"]);
});

test("latestActivity: truncated last line, cut first line, none", () => {
	const d = mkdtempSync(join(tmpdir(), "role-act-"));
	const f = join(d, "s.jsonl");
	writeFileSync(f, `${"x".repeat(500)}\n${activity("Reading the brief")}\n${activity("Half written").slice(0, 60)}`);
	assert.equal(latestActivity(f), "Reading the brief");
	assert.equal(latestActivity(f, 80), undefined);
	writeFileSync(f, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } })}\n`);
	assert.equal(latestActivity(f), undefined);
	assert.equal(latestActivity(join(d, "missing.jsonl")), undefined);
});

test("a missing record is not death while the process lives", async () => {
	assert.deepEqual(waitStep(undefined, "r/dev", 60_000, false, undefined, { gone: false }), { act: "wait", progress: "r/dev: running · 1m 00s" });
	assert.deepEqual(waitStep(undefined, "r/dev", 60_000, false, undefined, { gone: true }), { act: "final", status: "died" });
	// One poll misses the record (caught mid-rewrite), the next sees it done.
	fakeBg([rec("running"), undefined, rec("done")]);
	const r = await waitForRun(run(sessionFile("fine")), { ...clock(), limit: 60 * 60_000, now: (() => { let t = 0; return () => (t += 40_000); })(), alive: () => true });
	assert.equal(r.status, "done");
	// Background delivery waits too, and reports died once the process is gone.
	pending.push(run(sessionFile("late")));
	const sent: any[] = [];
	sessions.set("/parent.jsonl", { sendMessage: (m) => sent.push(m) });
	fakeBg([undefined]);
	deliver(() => true);
	assert.equal(sent.length, 0);
	deliver(() => false);
	assert.match(sent[0].content, /ended: died/);
});

test("a live pid that never gets a record is bounded: handover in the foreground, died in delivery", async () => {
	assert.deepEqual(waitStep(undefined, "r/dev", 15 * 60_000, false, undefined, { gone: false }).act, "handover");
	fakeBg([undefined]);
	const r = await waitForRun(run(sessionFile("never")), { ...clock(), alive: () => true });
	assert.equal(r.background, true);
	assert.match(r.text, /no run record after 15m 00s/);
	const sent: any[] = [];
	sessions.set("/parent.jsonl", { sendMessage: (m) => sent.push(m) });
	const started = pending[0]!.started;
	deliver(() => true, () => started + 14 * 60_000);
	assert.equal(sent.length, 0);
	deliver(() => true, () => started + 15 * 60_000);
	assert.match(sent[0].content, /ended: died/);
	assert.equal(pending.length, 0);
});

test("the host's runner is used when it offers one, and pi-background is then never the runner", async () => {
	const HOST = Symbol.for("pi-role-runner.v1");
	const g = globalThis as any;
	const started: string[] = [];
	try {
		delete g[KEY];
		assert.equal(runner(), undefined, "neither: role_agent reports that it has no runner");
		g[KEY] = { runs: () => [], start: (o: { msg: string }) => (started.push(o.msg), { file: "/run.jsonl", pid: 7 }) };
		assert.deepEqual(runner()?.start?.({ cwd: "/", msg: "laptop" }), { file: "/run.jsonl", pid: 7 }, "pi-background alone: as before");
		g[HOST] = { run: async () => Promise.reject(new Error("no worker holds r/dev's grant")) };
		const via = runner();
		assert.equal(via?.start, undefined, "with a host runner there is no pi-background start to fall back to");
		await assert.rejects(via!.host!.run({ project: "p", role: "r/dev", msg: "m", name: "n", cwd: ".", session: "s", background: false }), /no worker holds/);
		assert.deepEqual(started, ["laptop"]);
	} finally {
		delete g[HOST];
		delete g[KEY];
	}
});

test("stillRunning: a live record for the session, or a runner just started on it that has no record yet", () => {
	(globalThis as any)[KEY] = { runs: () => [rec("done", { file: "/a.jsonl" }), rec("running", { pid: 8, file: "/b.jsonl" }), rec("waiting", { pid: 9, file: "/c.jsonl" })] };
	const up = () => true;
	assert.equal(stillRunning("/a.jsonl", { pid: 7, started: 0 }, up, () => 1_000), false, "its record says it ended");
	assert.equal(stillRunning("/b.jsonl"), true);
	assert.equal(stillRunning("/c.jsonl"), true, "waiting for the session lock");
	// Started a second ago, no record yet.
	assert.equal(stillRunning("/d.jsonl", { pid: 10, started: 0 }, up, () => 1_000), true);
	assert.equal(stillRunning("/d.jsonl", { pid: 10, started: 0 }, () => false, () => 1_000), false, "its runner is gone");
	assert.equal(stillRunning("/d.jsonl", { pid: 10, started: 0 }, up, () => 60_000), false, "that pid is someone else by now");
	delete (globalThis as any)[KEY];
});
