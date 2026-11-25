import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

// pi loads an extension with "@earendil-works/pi-ai" resolved to its extension view, the one that has `Type`.
const view = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/pi-ai-extension-view.js", import.meta.url).href;
registerHooks({ resolve: (spec, context, next) => (spec === "@earendil-works/pi-ai" ? { url: view, shortCircuit: true } : next(spec, context)) });

const s = await import("../src/store.ts");
const r = await import("../src/roles.ts");
const { registerRoleAgent } = await import("../src/role-agent.ts");

const HOST = Symbol.for("pi-role-runner.v1");
const BG = Symbol.for("pi-background.v1");

let tmp: string;
let ran: any[];
let bgStarts: number;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-role-agent-"));
	process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
	process.env.PI_ROLES_ALLOWED_SIGNERS = join(tmp, "allowed_signers");
	process.env.PI_ROLES_SIGNING_KEY = join(tmp, "key");
	delete process.env.PI_PROJECTS_DIR;
	delete process.env.PI_ROLE;
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(tmp, "key")]);
	r.writeTrustAnchor(readFileSync(join(tmp, "key.pub"), "utf8"));
	ran = [];
	bgStarts = 0;
	// A host's runner (pi-web's worker), and a pi-background that must stay unused beside it.
	(globalThis as any)[HOST] = { run: async (o: any) => (ran.push(o), { text: "the host ran it", isError: false, status: "done", background: false }) };
	(globalThis as any)[BG] = { start: () => (bgStarts++, { file: "/bg.jsonl", pid: 1 }), runs: () => [] };
});
afterEach(() => {
	delete (globalThis as any)[HOST];
	delete (globalThis as any)[BG];
});

/** A project with repos/app cloned from a bare remote whose main has a role file .pi/roles/<role>.json for each of `roles`. */
function project(name = "p", roles = ["dev"]) {
	const p = s.createProject(name);
	const bare = join(tmp, `${name}-app.git`);
	const seed = join(tmp, `${name}-seed`);
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
	execFileSync("git", ["init", "-q", "-b", "main", seed]);
	mkdirSync(join(seed, ".pi", "roles"), { recursive: true });
	for (const role of roles) writeFileSync(join(seed, ".pi", "roles", `${role}.json`), JSON.stringify({ egress: [] }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", seed, ...args], { stdio: "ignore" });
	git("add", ".");
	git("commit", "-qm", "role");
	git("push", "-q", bare, "main");
	execFileSync("git", ["clone", "-q", bare, join(p.path, "repos", "app")], { stdio: "ignore" });
	return p;
}
const grant = (p: { id: string }, roles: string[]) => ({ projects: { [p.id]: { name: "p", roles } }, sources: {} });

/** Calls the registered role_agent tool from a session in `cwd` whose entries, as pi keeps them, are `entries`. */
function call(cwd: string, role: string, extra: object = {}, entries: any[] = []) {
	let tool: any;
	const appendEntry = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
	registerRoleAgent({ on() {}, registerTool: (t: any) => (tool = t), appendEntry } as any);
	const ctx = { cwd, sessionManager: { getSessionFile: () => "/parent.jsonl", getSessionId: () => "session-1", getEntries: () => entries } };
	return tool.execute("call-1", { role, task: "ship it\nand say so", ...extra }, undefined, undefined, ctx);
}

const said = (text: string) => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

/** No host runner, and a pi-background whose runs end at once: start() makes a session file, send() adds to one. */
function laptop() {
	delete (globalThis as any)[HOST];
	const bg = { started: [] as any[], sent: [] as any[], records: [] as any[] };
	let pid = 100;
	const ran = (file: string, reply: string) => {
		appendFileSync(file, said(reply));
		bg.records.push({ pid: ++pid, file, status: "done" });
		return { file, pid };
	};
	(globalThis as any)[BG] = {
		start: (o: any) => (bg.started.push(o), ran(join(tmp, `run-${pid}.jsonl`), "the first reply")),
		send: (o: any) => (bg.sent.push(o), ran(o.file, "the second reply")),
		runs: () => bg.records,
	};
	return bg;
}

test("every refusal comes before the host's runner: it is never asked to run", async () => {
	const p = project();
	r.saveSignedGrants(grant(p, ["app/dev", "app/ops"]));
	await assert.rejects(call(tmp, "app/dev"), /role_agent needs a pi project session/);
	await assert.rejects(call(p.path, "dev"), /Invalid role "dev"/);
	await assert.rejects(call(p.path, "app/admin"), /app\/admin is not granted to p\./);
	await assert.rejects(call(p.path, "app/admin", { session: "/run.jsonl" }), /app\/admin is not granted to p\./);
	// Granted, but origin's default branch has no such role file.
	await assert.rejects(call(p.path, "app/ops"), /Role app\/ops: no \.pi\/roles\/ops\.json on /);
	await assert.rejects(call(p.path, "app/dev", { cwd: ".." }), /cwd must be inside the project/);
	// The same grants, no longer trusted: edited after signing, then not signed at all.
	const file = JSON.parse(readFileSync(r.rolesFile(), "utf8"));
	writeFileSync(r.rolesFile(), JSON.stringify({ ...file, sources: { edited: true } }));
	await assert.rejects(call(p.path, "app/dev"), /Can't start app\/dev: .*invalid/);
	writeFileSync(r.rolesFile(), JSON.stringify(grant(p, ["app/dev"])));
	await assert.rejects(call(p.path, "app/dev"), /Can't start app\/dev: .*not signed/);
	assert.deepEqual(ran, []);
	assert.equal(bgStarts, 0);
});

test("a granted role with its role file runs once through the host's runner, not pi-background", async () => {
	const p = project();
	r.saveSignedGrants(grant(p, ["app/dev"]));
	mkdirSync(join(p.path, "worktrees", "app", "x"), { recursive: true });
	const result = await call(p.path, "app/dev", { cwd: "worktrees/app/x", background: true });
	assert.equal(ran.length, 1);
	const { msg, onUpdate, ...asked } = ran[0];
	assert.deepEqual(asked, { project: "p", role: "app/dev", name: r.runName("app/dev", "ship it\nand say so"), cwd: "worktrees/app/x", session: "session-1", background: true, signal: undefined });
	assert.equal(msg, r.roleRunStart("app/dev", "p", "ship it\nand say so").msg);
	assert.equal(typeof onUpdate, "function");
	assert.deepEqual(result, { content: [{ type: "text", text: "the host ran it" }], details: { role: "app/dev", status: "done", background: false }, isError: false });
	assert.equal(bgStarts, 0);
});

test("a follow-up is sent to the earlier run's own session with the role's environment, and its reply comes back", async () => {
	const p = project();
	r.saveSignedGrants(grant(p, ["app/dev"]));
	const bg = laptop();
	const entries: any[] = [];
	const first = await call(p.path, "app/dev", {}, entries);
	const file = first.details.file;
	assert.equal(first.content[0].text, `app/dev run done (session: ${file})\n\nthe first reply`);

	const second = await call(p.path, "app/dev", { task: "now also fix X", session: file }, entries);
	assert.equal(bg.started.length, 1, "no second session");
	assert.deepEqual(bg.sent, [{ file, msg: "now also fix X", env: { PI_ROLE: "app/dev", PI_SYNC_ALL_SESSIONS: "off" } }]);
	assert.deepEqual(bg.sent[0].env, bg.started[0].env, "what the first turn ran with");
	assert.equal(second.content[0].text, `app/dev run done (session: ${file})\n\nthe second reply`);
	assert.deepEqual(second.details, { role: "app/dev", pid: 102, file, status: "done", background: false });

	// And again, in the background.
	const third = await call(p.path, "app/dev", { task: "and Y", session: file, background: true }, entries);
	assert.equal(third.content[0].text, `Sent app/dev the follow-up (pid 103). Its result will arrive here as a message. Session: ${file}`);
	assert.deepEqual(bg.sent.map((o) => [o.file, o.msg]), [[file, "now also fix X"], [file, "and Y"]]);
});

test("a follow-up is refused, and nothing is sent, unless this session started that run as this role in this project and it has ended", async () => {
	const p = project("p", ["dev", "ops"]);
	const q = project("q");
	r.saveSignedGrants({ projects: { [p.id]: { name: "p", roles: ["app/dev", "app/ops"] }, [q.id]: { name: "q", roles: ["app/dev"] } }, sources: {} });
	const bg = laptop();
	const entries: any[] = [];
	const file = (await call(p.path, "app/dev", {}, entries)).details.file;
	const follow = (cwd: string, role: string, session: string, from = entries) => call(cwd, role, { task: "more", session }, from);

	// Another project's run, even from a session that holds p's record of it.
	await assert.rejects(follow(q.path, "app/dev", file, []), /Can't follow up on .*: it is not a app\/dev run that this session started in q\./);
	await assert.rejects(follow(q.path, "app/dev", file), /it is not a app\/dev run that this session started in q\./);
	// A run of another role.
	await assert.rejects(follow(p.path, "app/ops", file), /it is not a app\/ops run that this session started in p\./);
	// A session that is no role run of this session's, whatever it says about itself.
	const other = join(tmp, "other.jsonl");
	writeFileSync(other, `${JSON.stringify({ type: "message", message: { role: "user", content: r.roleRunStart("app/dev", "p", "x").msg } })}\n`);
	await assert.rejects(follow(p.path, "app/dev", other), /it is not a app\/dev run that this session started in p\./);
	await assert.rejects(follow(p.path, "app/dev", file, []), /it is not a app\/dev run that this session started in p\./);
	// Still running: not queued.
	bg.records[0].status = "running";
	await assert.rejects(follow(p.path, "app/dev", file), /app\/dev is still running there\. Wait for its result\./);
	bg.records[0].status = "done";
	// A pi-background from before send().
	const { send } = (globalThis as any)[BG];
	delete (globalThis as any)[BG].send;
	await assert.rejects(follow(p.path, "app/dev", file), /this pi-background can't send a run another message/);
	(globalThis as any)[BG].send = send;
	// Its session file is gone.
	rmSync(file);
	await assert.rejects(follow(p.path, "app/dev", file), /that session can't be found\./);
	assert.deepEqual(bg.sent, []);
	assert.equal(bg.started.length, 1);
});

test("on a host with its own runner the follow-up is the host's to send: it gets the run's id and the bare task", async () => {
	const p = project();
	r.saveSignedGrants(grant(p, ["app/dev"]));
	// A host from before follow-ups would start a new run: it is not asked.
	await assert.rejects(call(p.path, "app/dev", { task: "more", session: "r1" }), /Can't follow up on r1: this host can't send a role run another message yet/);
	assert.deepEqual(ran, []);
	(globalThis as any)[HOST].followUps = true;
	await call(p.path, "app/dev", { task: "more", session: "r1" });
	assert.deepEqual([ran[0].followUp, ran[0].msg, ran[0].role, ran[0].session], ["r1", "more", "app/dev", "session-1"]);
	assert.equal(bgStarts, 0);
});
