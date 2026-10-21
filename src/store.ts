import { execFileSync } from "node:child_process";
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
	/** Absolute project folder; not persisted. */
	path: string;
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

function saveProject(p: Project): void {
	const { path, ...data } = p;
	writeJsonAtomic(join(path, "project.json"), data);
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

function git(args: string[], cwd?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
	return dest;
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
