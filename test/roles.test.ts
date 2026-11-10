import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

const s = await import("../src/store.ts");
const r = await import("../src/roles.ts");

const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "pi-roles-"));
	process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
	process.env.PI_ROLES_ALLOWED_SIGNERS = join(tmp, "allowed_signers");
	process.env.PI_ROLES_SIGNING_KEY = join(tmp, "key");
	delete process.env.PI_PROJECTS_DIR;
	delete process.env.PI_ROLE;
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(tmp, "key")]);
	r.writeTrustAnchor(readFileSync(join(tmp, "key.pub"), "utf8"));
});

/** A project with repos/app cloned from a bare remote whose main has a role file. */
function fixture(role: object) {
	const p = s.createProject("p");
	const bare = join(tmp, "app.git");
	const seed = join(tmp, "seed");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
	execFileSync("git", ["init", "-q", "-b", "main", seed]);
	mkdirSync(join(seed, ".pi", "roles"), { recursive: true });
	writeFileSync(join(seed, ".pi", "roles", "dev.json"), JSON.stringify(role));
	sh(seed, "add", ".");
	sh(seed, "commit", "-qm", "role");
	sh(seed, "push", "-q", bare, "main");
	execFileSync("git", ["clone", "-q", bare, join(p.path, "repos", "app")]);
	return { p, seed, bare };
}

test("signed grants verify; edits after signing don't", () => {
	const g = { projects: { x: { name: "x", roles: ["app/dev"] } }, sources: {} };
	r.saveSignedGrants(g);
	assert.equal(r.verifyGrants(r.readGrants()), undefined);
	const file = JSON.parse(readFileSync(r.rolesFile(), "utf8"));
	file.projects.x.roles.push("infra/admin");
	writeFileSync(r.rolesFile(), JSON.stringify(file));
	assert.match(r.verifyGrants(r.readGrants()) ?? "", /invalid/);
	assert.deepEqual(r.trustedGrants().grants.projects, {});
});

test("unsigned grants are ignored", () => {
	mkdirSync(join(tmp, "agent"), { recursive: true });
	writeFileSync(r.rolesFile(), JSON.stringify({ projects: { x: { name: "x", roles: ["a/b"] } }, sources: {} }));
	assert.match(r.trustedGrants().problem ?? "", /not signed/);
});

test("roles come from origin's default branch, not the local checkout", () => {
	const { p, seed, bare } = fixture({ egress: ["a.example"] });
	r.saveSignedGrants({ projects: { [p.id]: { name: "p", default: "app/dev", roles: ["app/dev"] } }, sources: {} });
	const repo = join(p.path, "repos", "app");
	writeFileSync(join(repo, ".pi", "roles", "dev.json"), JSON.stringify({ egress: ["evil.example"] }));
	sh(repo, "commit", "-qam", "local widen");
	assert.deepEqual(r.sessionRole(p, {}).role?.egress, ["a.example"]);
	writeFileSync(join(seed, ".pi", "roles", "dev.json"), JSON.stringify({ egress: ["b.example"] }));
	sh(seed, "commit", "-qam", "merged change");
	sh(seed, "push", "-q", bare, "main");
	assert.deepEqual(r.sessionRole(p, {}).role?.egress, ["b.example"]);
});

test("PI_ROLE must be granted; tampering fails closed into the sandbox", () => {
	const { p } = fixture({});
	r.saveSignedGrants({ projects: { [p.id]: { name: "p", roles: ["app/dev"] } }, sources: {} });
	assert.equal(r.sessionRole(p, {}).sandbox, false);
	assert.equal(r.sessionRole(p, { PI_ROLE: "app/dev" }).roleId, "app/dev");
	const other = r.sessionRole(p, { PI_ROLE: "app/admin" });
	assert.equal(other.role, undefined);
	assert.match(other.problem ?? "", /not granted/);
	assert.equal(other.sandbox, true);
	const file = JSON.parse(readFileSync(r.rolesFile(), "utf8"));
	file.projects[p.id].roles.push("app/admin");
	writeFileSync(r.rolesFile(), JSON.stringify(file));
	const t = r.sessionRole(p, {});
	assert.equal(t.sandbox, true);
	assert.equal(t.grant, undefined);
});

test("unsigned grants fail closed once a trust anchor exists", () => {
	const { p } = fixture({});
	writeFileSync(r.rolesFile(), JSON.stringify({ projects: { [p.id]: { name: "p", default: "app/dev", roles: ["app/dev"] } }, sources: {} }));
	const t = r.sessionRole(p, {});
	assert.equal(t.sandbox, true);
	assert.equal(t.grant, undefined);
	assert.equal(t.roleId, undefined);
	assert.match(t.notice ?? "", /signature check/);
});

test("unsigned grants without a trust anchor: no grants, no sandbox", () => {
	const { p } = fixture({});
	rmSync(join(tmp, "allowed_signers"));
	writeFileSync(r.rolesFile(), JSON.stringify({ projects: { [p.id]: { name: "p", default: "app/dev", roles: ["app/dev"] } }, sources: {} }));
	const t = r.sessionRole(p, {});
	assert.equal(t.sandbox, false);
	assert.equal(t.grant, undefined);
	assert.match(t.notice ?? "", /not signed/);
	assert.equal(r.grantsStatus(r.readGrants(), r.trustedGrants().problem), "unsigned");
});

test("missing or empty grants and signed grants show no notice", () => {
	const { p } = fixture({});
	assert.equal(r.sessionRole(p, {}).notice, undefined);
	assert.equal(r.sessionRole(p, {}).sandbox, false);
	writeFileSync(r.rolesFile(), JSON.stringify({ projects: {}, sources: {} }));
	assert.equal(r.sessionRole(p, {}).notice, undefined);
	assert.equal(r.sessionRole(p, {}).sandbox, false);
	r.saveSignedGrants({ projects: { [p.id]: { name: "p", default: "app/dev", roles: ["app/dev"] } }, sources: {} });
	const t = r.sessionRole(p, {});
	assert.equal(t.notice, undefined);
	assert.equal(t.sandbox, false);
	assert.equal(t.roleId, "app/dev");
});
