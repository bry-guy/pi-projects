import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** Project "p" with repos/app cloned from a bare remote whose main has the role file .pi/roles/dev.json. */
function project() {
	const p = s.createProject("p");
	const bare = join(tmp, "app.git");
	const seed = join(tmp, "seed");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
	execFileSync("git", ["init", "-q", "-b", "main", seed]);
	mkdirSync(join(seed, ".pi", "roles"), { recursive: true });
	writeFileSync(join(seed, ".pi", "roles", "dev.json"), JSON.stringify({ egress: [] }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", seed, ...args], { stdio: "ignore" });
	git("add", ".");
	git("commit", "-qm", "role");
	git("push", "-q", bare, "main");
	execFileSync("git", ["clone", "-q", bare, join(p.path, "repos", "app")], { stdio: "ignore" });
	return p;
}
const grant = (p: { id: string }, roles: string[]) => ({ projects: { [p.id]: { name: "p", roles } }, sources: {} });

/** Calls the registered role_agent tool from a session in `cwd`. */
function call(cwd: string, role: string, extra: object = {}) {
	let tool: any;
	registerRoleAgent({ on() {}, registerTool: (t: any) => (tool = t) } as any);
	const ctx = { cwd, sessionManager: { getSessionFile: () => "/parent.jsonl", getSessionId: () => "session-1" } };
	return tool.execute("call-1", { role, task: "ship it\nand say so", ...extra }, undefined, undefined, ctx);
}

test("every refusal comes before the host's runner: it is never asked to run", async () => {
	const p = project();
	r.saveSignedGrants(grant(p, ["app/dev", "app/ops"]));
	await assert.rejects(call(tmp, "app/dev"), /role_agent needs a pi project session/);
	await assert.rejects(call(p.path, "dev"), /Invalid role "dev"/);
	await assert.rejects(call(p.path, "app/admin"), /app\/admin is not granted to p\./);
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
