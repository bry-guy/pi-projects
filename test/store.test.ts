import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

const s = await import("../src/store.ts");

beforeEach(() => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-projects-"));
	process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
	delete process.env.PI_PROJECTS_DIR;
});

function writeSession(cwd: string, id: string, parentSession?: string): string {
	const dir = s.sessionDirFor(cwd);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd, parentSession };
	writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message","id":"m1"}\n`);
	return file;
}

test("create, list, collisions and name validation", () => {
	const p = s.createProject("homelab");
	assert.ok(existsSync(join(p.path, "memory.md")));
	for (const d of s.SUBDIRS) assert.ok(existsSync(join(p.path, d)));
	assert.equal(s.listProjects().length, 1);
	assert.throws(() => s.createProject("homelab"), /already exists/);
	assert.throws(() => s.createProject("Bad Name"), /Invalid project name/);
	assert.throws(() => s.createProject("../x"), /Invalid project name/);
	assert.equal(s.projectForCwd(join(p.path, "repos", "x"))?.id, p.id);
	assert.equal(s.projectForCwd("/tmp"), undefined);
});

test("membership is derived from session cwd", () => {
	const p = s.createProject("a");
	writeSession(p.path, "s1");
	writeSession(join(p.path, "worktrees", "r", "main"), "s2");
	writeSession("/elsewhere", "s3");
	assert.deepEqual(s.projectSessions(p).map((x) => x.header.id).sort(), ["s1", "s2"]);
});

test("rename moves sessions, rewrites cwd and parentSession", () => {
	const p = s.createProject("old");
	const f1 = writeSession(p.path, "s1");
	writeSession(join(p.path, "repos", "r"), "s2", f1);
	writeSession("/elsewhere", "s3", f1);
	const { project: next, moved } = s.renameProject(p, "new");
	assert.equal(moved.get(f1), join(s.sessionDirFor(next.path), "2026-01-01T00-00-00-000Z_s1.jsonl"));
	assert.equal(next.name, "new");
	assert.ok(!existsSync(p.path));
	assert.equal(s.loadProject(next.path).name, "new");
	const byId = Object.fromEntries(s.allSessionFiles().map((x) => [x.header.id, x]));
	assert.equal(byId.s1.header.cwd, next.path);
	assert.equal(byId.s1.file, join(s.sessionDirFor(next.path), "2026-01-01T00-00-00-000Z_s1.jsonl"));
	assert.equal(byId.s2.header.cwd, join(next.path, "repos", "r"));
	assert.equal(byId.s2.header.parentSession, byId.s1.file);
	assert.equal(byId.s3.header.parentSession, byId.s1.file);
	assert.equal(byId.s3.header.cwd, "/elsewhere");
	assert.match(readFileSync(byId.s1.file, "utf8"), /"type":"message"/);
	assert.ok(!existsSync(f1));
	assert.throws(() => s.renameProject(next, "new2/../x"), /Invalid/);
});

test("archive blocks tools; restore re-enables", () => {
	const p = s.createProject("arch");
	const a = s.setState(p, "archived");
	assert.throws(() => s.remember(a, "x"), /archived/);
	const r = s.setState(a, "active");
	s.remember(r, "uses postgres 16");
	assert.match(s.readMemory(r), /- uses postgres 16\n$/);
});

test("delete removes folder and sessions, leaves others", () => {
	const p = s.createProject("del");
	const f = writeSession(join(p.path, "repos", "r"), "s1");
	const other = writeSession("/elsewhere", "s2");
	s.deleteProject(p);
	assert.ok(!existsSync(p.path));
	assert.ok(!existsSync(f));
	assert.ok(existsSync(other));
});

test("clone, worktree, scan and doctor", () => {
	const p = s.createProject("ws");
	const origin = mkdtempSync(join(tmpdir(), "origin-"));
	const g = (...a: string[]) => execFileSync("git", ["-C", origin, ...a], { stdio: "ignore" });
	g("init", "-q", "-b", "main");
	g("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
	s.cloneRepo(p, origin, "app");
	s.addWorktree(p, "app", "feature/x");
	assert.equal(s.addWorktree(p, "app", "feature/x"), join(p.path, "worktrees", "app", "feature/x"));
	assert.deepEqual(s.scanWorkspace(p), { repos: ["app"], worktrees: ["app/feature/x"] });
	assert.deepEqual(s.doctor(), []);
	writeFileSync(join(p.path, "stray.txt"), "");
	writeSession(join(s.projectsDir(), "gone"), "orphan");
	const issues = s.doctor();
	assert.ok(issues.some((i) => i.includes("stray item at project root: stray.txt")));
	assert.ok(issues.some((i) => i.includes("cwd no longer exists")));
});
