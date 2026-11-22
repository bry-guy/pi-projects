import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

export type ProjectState = "active" | "archived";

export interface Project {
	id: string;
	name: string;
	state: ProjectState;
	created: string;
	memory: { enabled: boolean; prompt?: string };
	/** Repos this project uses; re-cloned into repos/<name> on any machine. */
	repos?: RepoRef[];
	/** Absolute project folder; not persisted. */
	path: string;
}

export interface RepoRef {
	name: string;
	url: string;
	branch?: string;
}

export const SUBDIRS = ["repos", "worktrees", "artifacts"] as const;
const ROOT_FILES = new Set(["project.json", "memory.md", ...SUBDIRS]);

export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return resolve(env.replace(/^~(?=$|\/)/, homedir()));
	return join(homedir(), ".pi", "agent");
}

/** Resolve symlinks (e.g. macOS /var -> /private/var) so cwd comparisons match. */
function real(path: string): string {
	const abs = resolve(path);
	if (existsSync(abs)) return realpathSync(abs);
	const parent = dirname(abs);
	return parent === abs ? abs : join(real(parent), basename(abs));
}

export function projectsDir(): string {
	const env = process.env.PI_PROJECTS_DIR;
	return real(env ? env.replace(/^~(?=$|\/)/, homedir()) : join(agentDir(), "pi-projects"));
}

/** Must match pi's getDefaultSessionDirPath (session-manager.js). */
export function sessionDirFor(cwd: string): string {
	const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(agentDir(), "sessions", safe);
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function validateName(name: string): string {
	const n = name.trim();
	if (!SLUG.test(n)) {
		throw new Error(`Invalid project name "${name}": use lowercase letters, digits, ".", "_" or "-" (max 63 chars).`);
	}
	return n;
}

function writeJsonAtomic(file: string, data: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`);
	renameSync(tmp, file);
}

/** Merges over the file on disk, so keys this copy never loaded (e.g. pulled from the state repo) survive. */
export function saveProject(p: Project): void {
	const { path, ...data } = p;
	const file = join(path, "project.json");
	let disk: Record<string, unknown> = {};
	try {
		disk = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// new or unreadable: write ours
	}
	writeJsonAtomic(file, { ...disk, ...data });
}

export function loadProject(path: string): Project {
	const data = JSON.parse(readFileSync(join(path, "project.json"), "utf8"));
	return { memory: { enabled: true }, ...data, path };
}

export function listProjects(): Project[] {
	const root = projectsDir();
	if (!existsSync(root)) return [];
	const out: Project[] = [];
	for (const name of readdirSync(root).sort()) {
		const path = join(root, name);
		if (!existsSync(join(path, "project.json"))) continue;
		try {
			out.push(loadProject(path));
		} catch {
			// malformed project.json; doctor reports it
		}
	}
	return out;
}

export function getProject(name: string): Project {
	const p = listProjects().find((x) => x.name === name);
	if (!p) throw new Error(`No project named "${name}".`);
	return p;
}

/** The project whose folder contains cwd, if any. */
export function projectForCwd(cwd: string): Project | undefined {
	const root = projectsDir();
	const abs = real(cwd);
	if (!abs.startsWith(root + sep)) return undefined;
	const name = abs.slice(root.length + 1).split(sep)[0];
	const path = join(root, name);
	return existsSync(join(path, "project.json")) ? loadProject(path) : undefined;
}

export function createProject(name: string): Project {
	const n = validateName(name);
	const path = join(projectsDir(), n);
	if (existsSync(path)) throw new Error(`Project "${n}" already exists.`);
	mkdirSync(path, { recursive: true });
	for (const d of SUBDIRS) mkdirSync(join(path, d));
	writeFileSync(join(path, "memory.md"), `# ${n} memory\n`);
	const p: Project = {
		id: randomUUID(),
		name: n,
		state: "active",
		created: new Date().toISOString(),
		memory: { enabled: true },
		path,
	};
	saveProject(p);
	return p;
}

export function setState(p: Project, state: ProjectState): Project {
	const next = { ...p, state };
	saveProject(next);
	return next;
}

export function assertActive(p: Project): void {
	if (p.state !== "active") throw new Error(`Project "${p.name}" is archived. Run /project restore ${p.name} first.`);
}

export function isInside(path: string, dir: string): boolean {
	const a = real(path);
	const d = real(dir);
	return a === d || a.startsWith(d + sep);
}

// ---------- sessions (raw files, so tests and rename need no pi runtime) ----------

export interface SessionFile {
	file: string;
	header: { cwd?: string; parentSession?: string; id?: string; [k: string]: unknown };
}

function readFirstLine(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(64 * 1024);
		const n = readSync(fd, buf, 0, buf.length, 0);
		const text = buf.subarray(0, n).toString("utf8");
		const i = text.indexOf("\n");
		return i === -1 ? text : text.slice(0, i);
	} finally {
		closeSync(fd);
	}
}

export function allSessionFiles(): SessionFile[] {
	const root = join(agentDir(), "sessions");
	if (!existsSync(root)) return [];
	const out: SessionFile[] = [];
	for (const d of readdirSync(root)) {
		const dir = join(root, d);
		if (!statSync(dir).isDirectory()) continue;
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".jsonl")) continue;
			const file = join(dir, f);
			try {
				const header = JSON.parse(readFirstLine(file));
				if (header?.type === "session") out.push({ file, header });
			} catch {
				// unreadable session; skip
			}
		}
	}
	return out;
}

export function projectSessions(p: Project): SessionFile[] {
	return allSessionFiles().filter((s) => s.header.cwd && isInside(s.header.cwd, p.path));
}

/** Start of a role run's first user message (written by role_agent); marks the session as a role run. */
export const ROLE_RUN_PREFIX = "You are running as role ";

/** Display title (latest session name, else the first user message, else the file name), and whether it is a role run. */
export function sessionInfo(file: string): { title: string; roleRun: boolean } {
	let name: string | undefined;
	let first: string | undefined;
	let roleRun = false;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"session_info"') && (first || !line.includes('"user"'))) continue;
		try {
			const e = JSON.parse(line);
			if (e.type === "session_info" && e.name) name = e.name;
			else if (!first && e.type === "message" && e.message?.role === "user") {
				const c = e.message.content;
				const t = typeof c === "string" ? c : c?.find?.((x: any) => x.type === "text")?.text;
				if (t) {
					first = t.replace(/\s+/g, " ").trim().slice(0, 60);
					roleRun = t.startsWith(ROLE_RUN_PREFIX);
				}
			}
		} catch {}
	}
	return { title: name ?? first ?? basename(file), roleRun };
}

function rewriteHeader(from: string, to: string, header: SessionFile["header"]): void {
	const text = readFileSync(from, "utf8");
	const i = text.indexOf("\n");
	const rest = i === -1 ? "" : text.slice(i);
	mkdirSync(dirname(to), { recursive: true });
	const tmp = `${to}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(header) + rest);
	renameSync(tmp, to);
	if (from !== to) unlinkSync(from);
}

/**
 * Rename a project: move its sessions to the new cwd-derived session dirs, rewrite
 * header cwd and parentSession links, then move the folder. Each step is idempotent.
 */
export function renameProject(p: Project, newName: string): { project: Project; moved: Map<string, string> } {
	const n = validateName(newName);
	if (n === p.name) return { project: p, moved: new Map() };
	const newPath = join(projectsDir(), n);
	if (existsSync(newPath)) throw new Error(`Project "${n}" already exists.`);

	const remap = (cwd: string) => newPath + resolve(cwd).slice(resolve(p.path).length);
	const all = allSessionFiles();
	const moved = new Map<string, string>();
	for (const s of all) {
		if (s.header.cwd && isInside(s.header.cwd, p.path)) {
			moved.set(s.file, join(sessionDirFor(remap(s.header.cwd)), basename(s.file)));
		}
	}
	for (const s of all) {
		const to = moved.get(s.file);
		const parent = s.header.parentSession && moved.get(s.header.parentSession);
		if (!to && !parent) continue;
		const header = { ...s.header };
		if (to) header.cwd = remap(s.header.cwd!);
		if (parent) header.parentSession = parent;
		rewriteHeader(s.file, to ?? s.file, header);
	}

	renameSync(p.path, newPath);
	const next = { ...p, name: n, path: newPath };
	saveProject(next);
	return { project: next, moved };
}

export function deleteProject(p: Project): void {
	for (const s of projectSessions(p)) rmSync(s.file, { force: true });
	rmSync(p.path, { recursive: true, force: true });
}

// ---------- workspace ----------

export interface Workspace {
	repos: string[];
	worktrees: string[]; // "<repo>/<branch>"
}

function dirs(path: string): string[] {
	return existsSync(path) ? readdirSync(path).filter((d) => statSync(join(path, d)).isDirectory()).sort() : [];
}

export function scanWorkspace(p: Project): Workspace {
	const worktrees: string[] = [];
	const walk = (dir: string, rel: string) => {
		for (const d of dirs(dir)) {
			const full = join(dir, d);
			if (existsSync(join(full, ".git"))) worktrees.push(`${rel}/${d}`);
			else walk(full, `${rel}/${d}`);
		}
	};
	for (const repo of dirs(join(p.path, "worktrees"))) walk(join(p.path, "worktrees", repo), repo);
	return { repos: dirs(join(p.path, "repos")), worktrees };
}

/** Host git never runs repo-controlled code: agents can write .git (hooks, fsmonitor). */
export const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

function git(args: string[], cwd?: string): string {
	return execFileSync("git", [...SAFE_GIT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function repoNameFromUrl(url: string): string {
	return basename(url.replace(/[/]+$/, "")).replace(/\.git$/, "");
}

export function cloneRepo(p: Project, url: string, name?: string): string {
	assertActive(p);
	const n = name ?? repoNameFromUrl(url);
	if (!n || n.includes("/") || n.startsWith(".")) throw new Error(`Invalid repo name "${n}".`);
	const dest = join(p.path, "repos", n);
	if (existsSync(dest)) throw new Error(`repos/${n} already exists.`);
	git(["clone", url, dest]);
	addRepoRef(p, { name: n, url, branch: remoteBranch(dest) });
	return dest;
}

/** The origin branch a checkout follows: the only branch name another machine can clone. A local name may differ. */
function remoteBranch(dir: string): string | undefined {
	try {
		const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], dir);
		return upstream.startsWith("origin/") ? upstream.slice("origin/".length) : undefined;
	} catch {
		return undefined; // detached, empty, or a local-only branch: clone the default branch elsewhere
	}
}

function addRepoRef(p: Project, ref: RepoRef): void {
	const fresh = loadProject(p.path);
	fresh.repos = [...(fresh.repos ?? []).filter((r) => r.name !== ref.name), ref];
	saveProject(fresh);
	p.repos = fresh.repos;
}

/** Record repos cloned before project.json tracked them (or by hand). Returns how many were added. */
export function recordExistingRepos(p: Project): number {
	const known = new Set((p.repos ?? []).map((r) => r.name));
	let added = 0;
	for (const name of dirs(join(p.path, "repos"))) {
		if (known.has(name) || !existsSync(join(p.path, "repos", name, ".git"))) continue;
		let url: string;
		try {
			url = git(["remote", "get-url", "origin"], join(p.path, "repos", name));
		} catch {
			continue; // no remote: cannot be re-cloned elsewhere
		}
		addRepoRef(p, { name, url, branch: remoteBranch(join(p.path, "repos", name)) });
		added++;
	}
	return added;
}

/** Repos listed in project.json but not cloned here. */
export function missingRepos(p: Project): RepoRef[] {
	return (p.repos ?? []).filter((r) => !existsSync(join(p.path, "repos", r.name)));
}

/** Clone one listed repo without blocking the caller. */
export function cloneMissing(p: Project, ref: RepoRef): Promise<string> {
	const dest = join(p.path, "repos", ref.name);
	const args = ["clone", ...(ref.branch ? ["--branch", ref.branch] : []), ref.url, dest];
	return run("git", args).then(() => dest);
}

/** Forget a repo and delete its clone. Worktrees of it must be removed first. */
export function removeRepo(p: Project, name: string): void {
	assertActive(p);
	if (dirs(join(p.path, "worktrees", name)).length) throw new Error(`repos/${name} still has worktrees under worktrees/${name}.`);
	rmSync(join(p.path, "repos", name), { recursive: true, force: true });
	const fresh = loadProject(p.path);
	fresh.repos = (fresh.repos ?? []).filter((r) => r.name !== name);
	saveProject(fresh);
	p.repos = fresh.repos;
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
	return new Promise((res, rej) =>
		// Never prompt for credentials and never hang a pi start on a dead network.
		execFile(cmd, cmd === "git" ? [...SAFE_GIT, ...args] : args, { cwd, encoding: "utf8", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) =>
			err ? rej(new Error(stderr.trim().split("\n").at(-1) || err.message)) : res(stdout.trim()),
		),
	);
}

// ---------- state repo: PI_PROJECTS_DIR as one git repo of project.json + memory.md ----------

export const STATE_IGNORE = "*/repos/\n*/worktrees/\n*/artifacts/\n*.tmp\n";
export const STATE_ATTRIBUTES = "*/memory.md merge=union\n";

export function isStateRepo(): boolean {
	return existsSync(join(projectsDir(), ".git"));
}

/**
 * Make PI_PROJECTS_DIR a git repo synced with `remote`. Local projects are
 * committed first; an existing remote history is merged in (memory.md merges by union).
 */
export async function shareState(remote: string): Promise<string> {
	const root = projectsDir();
	mkdirSync(root, { recursive: true });
	const g = (...a: string[]) => run("git", a, root);
	if (!isStateRepo()) await g("init", "-q", "-b", "main");
	writeFileSync(join(root, ".gitignore"), STATE_IGNORE);
	writeFileSync(join(root, ".gitattributes"), STATE_ATTRIBUTES);
	const remotes = (await g("remote")).split("\n");
	await (remotes.includes("origin") ? g("remote", "set-url", "origin", remote) : g("remote", "add", "origin", remote));
	await commitAll("pi-projects: share");
	await g("fetch", "-q", "origin");
	const hasRemote = await g("ls-remote", "--heads", "origin", "main").then((o) => o !== "");
	if (hasRemote) await g("pull", "-q", "--no-rebase", "--no-edit", "--allow-unrelated-histories", "origin", "main");
	await g("push", "-q", "-u", "origin", "main");
	return root;
}

async function commitAll(message: string): Promise<boolean> {
	const root = projectsDir();
	await run("git", ["add", "-A"], root);
	const staged = await run("git", ["diff", "--cached", "--name-only"], root);
	if (!staged) return false;
	await run("git", ["-c", "user.name=pi-projects", "-c", "user.email=pi-projects@localhost", "commit", "-q", "-m", message], root);
	return true;
}

let chain: Promise<unknown> = Promise.resolve();
/** Serialize state-repo git work inside this process. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn, fn);
	chain = next.catch(() => {});
	return next;
}

/** Commit project changes and push; on rejection pull (rebase) and retry once. No-op without a state repo. */
export function pushState(message: string): Promise<void> {
	if (!isStateRepo()) return Promise.resolve();
	const root = projectsDir();
	return serial(async () => {
		await commitAll(message);
		const ahead = await run("git", ["rev-list", "--count", "@{upstream}..HEAD"], root).catch(() => "1");
		if (ahead === "0") return;
		try {
			await run("git", ["push", "-q"], root);
		} catch {
			await run("git", ["fetch", "-q", "origin", "main"], root);
			await run("git", ["rebase", "-q", "origin/main"], root);
			await run("git", ["push", "-q"], root);
		}
	});
}

/** Fetch other machines' project changes. No-op without a state repo. */
export function pullState(): Promise<void> {
	if (!isStateRepo()) return Promise.resolve();
	const root = projectsDir();
	return serial(async () => {
		await commitAll("pi-projects: local changes");
		// Not `git pull`: FETCH_HEAD is shared, so concurrent pi starts could leave several branches in it.
		await run("git", ["fetch", "-q", "origin", "main"], root);
		await run("git", ["rebase", "-q", "origin/main"], root);
	});
}

export function addWorktree(p: Project, repo: string, branch: string): string {
	assertActive(p);
	const repoPath = join(p.path, "repos", repo);
	if (!existsSync(join(repoPath, ".git"))) throw new Error(`No repo at repos/${repo}. Clone it with project_clone first.`);
	const dest = join(p.path, "worktrees", repo, branch);
	if (existsSync(dest)) return dest;
	let exists = true;
	try {
		git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
	} catch {
		exists = false;
	}
	if (!exists) {
		try {
			git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoPath);
			git(["worktree", "add", "--track", "-b", branch, dest, `origin/${branch}`], repoPath);
			return dest;
		} catch {
			git(["worktree", "add", "-b", branch, dest], repoPath);
			return dest;
		}
	}
	git(["worktree", "add", dest, branch], repoPath);
	return dest;
}

// ---------- memory ----------

export function readMemory(p: Project): string {
	const f = join(p.path, "memory.md");
	return existsSync(f) ? readFileSync(f, "utf8") : "";
}

export function remember(p: Project, text: string): void {
	assertActive(p);
	if (!p.memory.enabled) throw new Error(`Memory is disabled for project "${p.name}".`);
	const t = text.trim();
	if (!t) throw new Error("Nothing to remember.");
	const f = join(p.path, "memory.md");
	const prev = readMemory(p);
	const sep = prev === "" || prev.endsWith("\n") ? "" : "\n";
	writeFileSync(f, `${prev}${sep}- ${t.replace(/\n+/g, " ")}\n`);
}

// ---------- doctor ----------

export function doctor(): string[] {
	const issues: string[] = [];
	const root = projectsDir();
	if (!existsSync(root)) return issues;
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (!statSync(path).isDirectory()) {
			issues.push(`stray file at projects root: ${name}`);
			continue;
		}
		let p: Project;
		try {
			p = loadProject(path);
		} catch {
			issues.push(`${name}: missing or malformed project.json`);
			continue;
		}
		if (p.name !== name) issues.push(`${name}: project.json name "${p.name}" does not match folder`);
		for (const f of readdirSync(path)) if (!ROOT_FILES.has(f)) issues.push(`${name}: stray item at project root: ${f}`);
		for (const wt of scanWorkspace(p).worktrees) {
			const gitFile = join(path, "worktrees", wt, ".git");
			if (statSync(gitFile).isFile()) {
				const target = readFileSync(gitFile, "utf8").replace(/^gitdir:\s*/, "").trim();
				if (!existsSync(target)) issues.push(`${name}: broken worktree worktrees/${wt}`);
			}
		}
	}
	for (const s of allSessionFiles()) {
		const cwd = s.header.cwd;
		if (cwd && isInside(cwd, root) && !existsSync(cwd)) issues.push(`session ${basename(s.file)}: cwd no longer exists (${cwd})`);
	}
	return issues;
}
