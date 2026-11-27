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

test("sessionInfo marks role runs by the first user message's prefix", () => {
	const p = s.createProject("a");
	const write = (id: string, text: string) => {
		const file = writeSession(p.path, id);
		writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`, { flag: "a" });
		return file;
	};
	const run = write("s1", `${s.ROLE_RUN_PREFIX}pi-web/dev for project a, ...\n\nTask:\nfix it`);
	const normal = write("s2", "please fix it");
	const quoted = write("s3", `look at this: ${s.ROLE_RUN_PREFIX}pi-web/dev`);
	assert.equal(s.sessionInfo(run).roleRun, true);
	assert.deepEqual(s.sessionInfo(normal), { title: "please fix it", roleRun: false });
	assert.equal(s.sessionInfo(quoted).roleRun, false);
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

test("an adopted clone records the origin branch it follows, not its local branch name", () => {
	const p = s.createProject("fork");
	const origin = mkdtempSync(join(tmpdir(), "origin-"));
	execFileSync("git", ["-C", origin, "init", "-q", "-b", "master"]);
	execFileSync("git", ["-C", origin, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"]);
	const dest = join(p.path, "repos", "code");
	execFileSync("git", ["clone", "-q", origin, dest]);
	execFileSync("git", ["-C", dest, "checkout", "-q", "-b", "fork-main", "--track", "origin/master"]);
	assert.equal(s.recordExistingRepos(p), 1);
	assert.equal(s.loadProject(p.path).repos?.[0].branch, "master");
});

test("clone records repos; missing repos are listed; remove forgets", () => {
	const src = mkdtempSync(join(tmpdir(), "src-"));
	execFileSync("git", ["init", "-q", "-b", "main", src]);
	execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
	const p = s.createProject("multi");
	s.cloneRepo(p, src, "code");
	const saved = s.loadProject(p.path);
	assert.deepEqual(saved.repos, [{ name: "code", url: src, branch: "main" }]);
	assert.equal(s.missingRepos(saved).length, 0);
	s.removeRepo(saved, "code");
	assert.equal(existsSync(join(p.path, "repos", "code")), false);
	assert.deepEqual(s.loadProject(p.path).repos, []);
});

test("state repo: share, remember on two machines merges memory", async () => {
	const remote = mkdtempSync(join(tmpdir(), "remote-"));
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
	Object.assign(process.env, env);
	const a = mkdtempSync(join(tmpdir(), "a-"));
	const b = mkdtempSync(join(tmpdir(), "b-"));
	process.env.PI_PROJECTS_DIR = a;
	const pa = s.createProject("shared");
	await s.shareState(remote);
	process.env.PI_PROJECTS_DIR = b;
	await s.shareState(remote);
	const pb = s.getProject("shared");
	s.remember(pb, "from b");
	await s.pushState("b");
	process.env.PI_PROJECTS_DIR = a;
	s.remember(pa, "from a");
	await s.pushState("a"); // rejected, rebases with union merge, retries
	await s.pullState();
	const mem = readFileSync(join(pa.path, "memory.md"), "utf8");
	assert.match(mem, /from a/);
	assert.match(mem, /from b/);
	assert.equal(existsSync(join(a, ".gitignore")), true);
});

test("sessionInfo title prefers name, then first user message", () => {
	const p = s.createProject("titles");
	const file = writeSession(p.path, "t1");
	assert.match(s.sessionInfo(file).title, /t1\.jsonl$/);
	writeFileSync(file, readFileSync(file, "utf8") + `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello there" }] } })}\n`);
	assert.equal(s.sessionInfo(file).title, "hello there");
	writeFileSync(file, readFileSync(file, "utf8") + `${JSON.stringify({ type: "session_info", name: "Named" })}\n`);
	assert.equal(s.sessionInfo(file).title, "Named");
});

test("saves keep keys written to project.json after this copy was loaded", () => {
	const p = s.createProject("keep");
	const file = join(p.path, "project.json");
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), extra: { a: 1 } }));
	s.setState(p, "archived");
	const disk = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual([disk.state, disk.extra], ["archived", { a: 1 }]);
});

test("server sessions merge into a project's list by time, without duplicates, and never get in the way", async () => {
	const local = (id: string, timestamp: string) => ({ file: `/s/${id}.jsonl`, header: { id, timestamp } });
	const server = (sessionId: string, updatedAt: string, more = {}) => ({ sessionId, title: sessionId, project: "eco", updatedAt, devices: [{ label: "web" }], local: false, ...more });
	const mine = [local("old", "2026-01-01T00:00:00.000Z"), local("new", "2026-01-03T00:00:00.000Z")];
	const theirs = [
		server("between", "2026-01-02T00:00:00Z"),
		server("newest", "2026-01-04T00:00:00Z"),
		server("new", "2026-01-05T00:00:00Z"), // this machine has it: same id as a local file
		server("elsewhere", "2026-01-05T00:00:00Z", { local: true }), // or pi-sync says so
		server("other-project", "2026-01-05T00:00:00Z", { project: "eco2" }),
		server("no-project", "2026-01-05T00:00:00Z", { project: undefined }),
	];
	const ids = async (sync: any, timeoutMs?: number) =>
		(await s.withServerSessions(mine, "eco", sync, timeoutMs)).map((x: any) => x.sessionId ?? x.header.id);
	assert.deepEqual(await ids({ list: async () => theirs }), ["newest", "new", "between", "old"]);
	const localOnly = ["new", "old"];
	assert.deepEqual(await ids(undefined), localOnly, "pi-sync is not installed");
	assert.deepEqual(await ids({ list: async () => Promise.reject(new Error("offline")) }), localOnly, "the list fails");
	const started = Date.now();
	assert.deepEqual(await ids({ list: () => new Promise((resolve) => setTimeout(() => resolve(theirs), 500)) }, 20), localOnly, "the list is slow");
	assert.ok(Date.now() - started < 400, "a slow list is not waited for");
});
