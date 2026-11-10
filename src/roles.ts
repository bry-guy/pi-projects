// Roles and signed grants (docs/agent-roles.md, docs/agent-roles-plan.md M2).
//
// - A role is `<repo>/.pi/roles/<role>.json`, read from origin's default branch, so it changes only by a merge.
// - Grants live in `~/.pi/agent/pi-roles.json`, signed with Bryan's SSH key (1Password agent, Touch ID). The trust
//   anchor (allowed_signers) lives outside dotfiles and outside every sandbox mount.
// - Unsigned or badly signed grants count as no grants.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentDir, type Project, SAFE_GIT } from "./store.ts";

const NAMESPACE = "pi-roles";
const PRINCIPAL = "pi-roles";
const ROLE_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export interface Role {
	description?: string;
	/** Hostnames the sandbox may reach, on top of the default tooling hosts */
	egress?: string[];
	/** Secrets injected as placeholders, only for the listed hosts */
	secrets?: Record<string, { hosts: string[] }>;
	/** Host-side actions run by pi-secret-broker */
	broker?: Record<string, BrokerAction>;
	/** Extra host tools allowed in the sandboxed session */
	tools?: string[];
}

export interface BrokerAction {
	description?: string;
	/** argv; `{arg}` placeholders are filled from validated args */
	run: string[];
	/** Directory relative to the repo checkout the action runs in */
	cwd?: string;
	/** Secret names (resolved from the role's sources) passed as env */
	env?: string[];
	/** auto runs without asking; ask confirms with Bryan first */
	approve?: "auto" | "ask";
	/** Allowed args: name -> regex the value must fully match */
	args?: Record<string, string>;
}

export interface ProjectGrant {
	name: string;
	/** Run this project's interactive sessions in the sandbox */
	sandbox?: boolean;
	/** Role for sessions that don't name one */
	default?: string;
	roles: string[];
}

export interface GrantsFile {
	projects: Record<string, ProjectGrant>;
	/** Per role: secret name -> source (`keychain:<service>`, `op://...`, `env:NAME`, `file:path`) */
	sources: Record<string, Record<string, string>>;
	signature?: string;
}

export function rolesFile(): string {
	return process.env.PI_ROLES_FILE || join(agentDir(), "pi-roles.json");
}

export function allowedSignersFile(): string {
	return process.env.PI_ROLES_ALLOWED_SIGNERS || join(homedir(), ".local", "state", "pi-roles", "allowed_signers");
}

export function validateRoleId(id: string): string {
	if (!ROLE_ID.test(id)) throw new Error(`Invalid role "${id}": use <repo>/<role>.`);
	return id;
}

/** Stable JSON (sorted keys) of everything but the signature. */
export function canonical(g: GrantsFile): string {
	const { signature: _, ...rest } = g;
	const sort = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(sort)
			: v && typeof v === "object"
				? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as any)[k])]))
				: v;
	return JSON.stringify(sort(rest));
}

export function readGrants(): GrantsFile {
	try {
		const g = JSON.parse(readFileSync(rolesFile(), "utf8"));
		return { projects: g.projects ?? {}, sources: g.sources ?? {}, signature: g.signature };
	} catch {
		return { projects: {}, sources: {} };
	}
}

function withTemp<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-roles-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Why the grants file can't be trusted, or undefined when it can. */
export function verifyGrants(g: GrantsFile): string | undefined {
	if (!g.signature) return "grants are not signed; run /project grant on the Mac";
	if (!existsSync(allowedSignersFile())) return `no trust anchor at ${allowedSignersFile()}`;
	return withTemp((dir) => {
		const sig = join(dir, "sig");
		writeFileSync(sig, g.signature!);
		try {
			execFileSync("ssh-keygen", ["-Y", "verify", "-f", allowedSignersFile(), "-I", PRINCIPAL, "-n", NAMESPACE, "-s", sig], {
				input: canonical(g),
				stdio: ["pipe", "ignore", "ignore"],
			});
			return undefined;
		} catch {
			return "grant signature is invalid; re-sign with /project grant on the Mac";
		}
	});
}

/** Trusted grants: the signed file, or empty when unsigned/invalid. */
export function trustedGrants(): { grants: GrantsFile; problem?: string } {
	const g = readGrants();
	const problem = verifyGrants(g);
	return problem ? { grants: { projects: {}, sources: {} }, problem } : { grants: g };
}

function signerKey(): string {
	const line = readFileSync(allowedSignersFile(), "utf8")
		.split("\n")
		.find((l) => l.startsWith(`${PRINCIPAL} `));
	if (!line) throw new Error(`No "${PRINCIPAL}" key in ${allowedSignersFile()}`);
	return line.slice(PRINCIPAL.length + 1).trim();
}

/** First key in the SSH agent (1Password), for setting up the trust anchor. */
export function agentKeys(): string[] {
	try {
		return execFileSync("ssh-add", ["-L"], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("ssh-"));
	} catch {
		return [];
	}
}

export function writeTrustAnchor(key: string): void {
	const file = allowedSignersFile();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${PRINCIPAL} ${key.trim()}\n`, { mode: 0o600 });
}

/** Signs and writes the grants file. Signing uses the SSH agent (Touch ID with 1Password). */
export function saveSignedGrants(g: GrantsFile): void {
	const signature = withTemp((dir) => {
		// PI_ROLES_SIGNING_KEY: a private key file; default is the agent key matching the trust anchor.
		let key = process.env.PI_ROLES_SIGNING_KEY;
		if (!key) {
			key = join(dir, "key.pub");
			writeFileSync(key, `${signerKey()}\n`);
		}
		return execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-f", key, "-n", NAMESPACE], { input: canonical(g), encoding: "utf8" });
	});
	const next = { ...g, signature };
	const problem = verifyGrants(next);
	if (problem) throw new Error(`Signed, but the signature does not verify: ${problem}`);
	mkdirSync(dirname(rolesFile()), { recursive: true });
	writeFileSync(rolesFile(), `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
}

function git(cwd: string, args: string[], timeout = 20_000): string {
	return execFileSync("git", [...SAFE_GIT, "-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** origin's default branch, e.g. origin/main. */
function originDefault(repo: string): string {
	try {
		return git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	} catch {
		for (const b of ["origin/main", "origin/master"]) {
			try {
				git(repo, ["rev-parse", "--verify", "-q", b]);
				return b;
			} catch {}
		}
		throw new Error(`${repo} has no origin default branch`);
	}
}

/** The role file as merged on origin's default branch (fetches first unless fetch is false). */
export function loadRole(project: Project, roleId: string, { fetch = true } = {}): Role {
	const [repo, role] = validateRoleId(roleId).split("/");
	const dir = join(project.path, "repos", repo);
	if (!existsSync(join(dir, ".git"))) throw new Error(`Role ${roleId}: repos/${repo} is not cloned in ${project.name}`);
	if (fetch) {
		try {
			git(dir, ["fetch", "-q", "origin"], 60_000);
		} catch {
			// offline: use the last fetched origin
		}
	}
	const ref = originDefault(dir);
	let text: string;
	try {
		text = git(dir, ["show", `${ref}:.pi/roles/${role}.json`]);
	} catch {
		throw new Error(`Role ${roleId}: no .pi/roles/${role}.json on ${ref}`);
	}
	return JSON.parse(text) as Role;
}

export interface SessionRole {
	/** The project's signed grant, if any */
	grant?: ProjectGrant;
	/** Role this session runs as (PI_ROLE or the grant's default) */
	roleId?: string;
	role?: Role;
	/** Run tools in the sandbox */
	sandbox: boolean;
	/** Why the role or grants aren't usable */
	problem?: string;
}

/** What a session in this project runs as. PI_ROLE (role runs) must be granted; otherwise the default role. */
export function sessionRole(project: Project, env: NodeJS.ProcessEnv = process.env, opts = { fetch: true }): SessionRole {
	const { grants, problem } = trustedGrants();
	const grant = grants.projects[project.id];
	const requested = env.PI_ROLE;
	// A signed file that no longer verifies was tampered with: fail closed into the sandbox.
	const tampered = !!problem && !!readGrants().signature;
	const out: SessionRole = { grant, sandbox: !!requested || !!grant?.sandbox || tampered, problem };
	const roleId = requested || grant?.default;
	if (!roleId) return out;
	if (!grant?.roles.includes(roleId)) return { ...out, problem: problem ?? `role ${roleId} is not granted to ${project.name}` };
	try {
		return { ...out, roleId, role: loadRole(project, roleId, opts) };
	} catch (e) {
		return { ...out, problem: (e as Error).message };
	}
}

/** Session name for a role run: "<role>: <first line of the task, cut to ~60 chars on a word boundary>". */
export function runName(role: string, task: string, max = 60): string {
	const short = role.split("/").pop() ?? role;
	let line = task.trim().split("\n")[0].trim();
	if (line.length > max) {
		const cut = line.slice(0, max + 1).lastIndexOf(" ");
		line = `${line.slice(0, cut > max / 2 ? cut : max).trimEnd()}…`;
	}
	return line ? `${short}: ${line}` : short;
}
