import { existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	addWorktree,
	assertActive,
	cloneMissing,
	cloneRepo,
	createProject,
	deleteProject,
	doctor,
	getProject,
	isInside,
	isStateRepo,
	listProjects,
	missingRepos,
	type Project,
	projectForCwd,
	projectSessions,
	pullState,
	pushState,
	readMemory,
	recordExistingRepos,
	remember,
	removeRepo,
	renameProject,
	scanWorkspace,
	sessionTitle,
	setState,
	shareState,
} from "./store.ts";
import {
	agentKeys,
	allowedSignersFile,
	type GrantsFile,
	loadRole,
	readGrants,
	type SessionRole,
	saveSignedGrants,
	sessionRole,
	trustedGrants,
	validateRoleId,
	writeTrustAnchor,
} from "./roles.ts";
import * as roles from "./roles.ts";
import { registerRoleAgent } from "./role-agent.ts";
import * as store from "./store.ts";

/** For pi-mounts and pi-secret-broker, which run in the same pi process. */
const API = Symbol.for("pi-projects.v1");
(globalThis as any)[API] = { ...store, ...roles };

const ENTRY = "pi-project";
const STATUS = "pi-project";

function roleLines(r: SessionRole | undefined): string[] {
	if (!r) return [];
	const out: string[] = [];
	if (r.sandbox) {
		out.push(
			"",
			"Sandbox: your tools run in a VM. repos/<repo> main checkouts are read-only; make changes in a worktree",
			"(project_worktree). Network access is limited to an allowlist; a 403 'blocked by policy' means the host is not allowed.",
		);
	}
	if (r.roleId) out.push(`Role: ${r.roleId}${r.role?.description ? ` (${r.role.description})` : ""}.`);
	const others = (r.grant?.roles ?? []).filter((x) => x !== r.roleId);
	if (others.length) out.push(`Granted roles you can delegate to with role_agent: ${others.join(", ")}.`);
	if (r.role?.broker && Object.keys(r.role.broker).length) {
		out.push(`Host actions (broker_run): ${Object.entries(r.role.broker).map(([k, a]) => `${k}${a.description ? ` (${a.description})` : ""}`).join(", ")}.`);
	}
	if (r.problem) out.push(`Roles: ${r.problem}.`);
	return out;
}

function buildSection(p: Project, r?: SessionRole): string {
	const ws = scanWorkspace(p);
	const lines = [
		`You are working in pi project "${p.name}"${p.state === "archived" ? " (archived, read-only)" : ""} at ${p.path}.`,
		"Layout rules:",
		"- Clone repositories with the project_clone tool (into repos/<name>); never clone elsewhere in the project.",
		"- Create branch checkouts with the project_worktree tool (worktrees/<repo>/<branch>); do not run `git worktree add` yourself.",
		"- Put notes, generated files and scratch output in artifacts/. Keep the project root clean.",
		"- A repo's own AGENTS.md is not loaded automatically from the project root; read it before working in that repo.",
		`Repos: ${ws.repos.length ? ws.repos.map((r) => `repos/${r}`).join(", ") : "(none)"}`,
		`Worktrees: ${ws.worktrees.length ? ws.worktrees.map((w) => `worktrees/${w}`).join(", ") : "(none)"}`,
		...roleLines(r),
	];
	if (p.memory.enabled) {
		lines.push(
			"",
			p.memory.prompt ??
				"Project memory is shared by every session in this project. Save durable facts with project_remember; see the project-memory skill.",
			"<memory>",
			readMemory(p).trim() || "(empty)",
			"</memory>",
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	registerRoleAgent(pi);
	let current: Project | undefined;
	let section: string | undefined;
	let ui: ExtensionContext["ui"] | undefined;

	/** Sync the state repo in the background; never blocks or fails pi. */
	const sync = (message: string) => {
		pushState(message).catch((err) => ui?.notify(`pi-projects: could not sync projects (${err.message})`, "warning"));
	};

	const cloning = new Set<string>();
	/** Clone repos listed in project.json that are missing on this machine. */
	const ensureRepos = (p: Project, ctx: ExtensionContext) => {
		for (const ref of missingRepos(p)) {
			const key = `${p.path}/${ref.name}`;
			if (cloning.has(key)) continue;
			cloning.add(key);
			ui?.notify(`pi-projects: cloning ${ref.name} into ${p.name}/repos…`, "info");
			cloneMissing(p, ref)
				.then(() => {
					ui?.notify(`pi-projects: cloned ${ref.name}`, "info");
					if (current?.id === p.id) refresh(ctx);
				})
				.catch((err) => ui?.notify(`pi-projects: could not clone ${ref.name} (${err.message})`, "warning"))
				.finally(() => cloning.delete(key));
		}
	};

	let role: SessionRole | undefined;
	const refresh = (ctx: ExtensionContext, { roleFetch = false } = {}) => {
		current = projectForCwd(ctx.cwd);
		role = current ? sessionRole(current, process.env, { fetch: roleFetch }) : undefined;
		section = current ? buildSection(current, role) : undefined;
		ctx.ui.setStatus(STATUS, current ? `project: ${current.name}${current.state === "archived" ? " (archived)" : ""}` : undefined);
	};

	const requireProject = (): Project => {
		if (!current) throw new Error("This session is not in a pi project. Open one with /project.");
		assertActive(current);
		return current;
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx.ui;
		refresh(ctx, { roleFetch: true });
		if (!current) return;
		if (isStateRepo()) {
			// Pull other machines' memory and repo list without delaying the start; reload when it lands.
			pullState()
				.then(() => {
					if (ui !== ctx.ui) return; // session replaced meanwhile
					refresh(ctx);
					if (current) ensureRepos(current, ctx);
				})
				.catch((err) => ui?.notify(`pi-projects: could not pull projects (${err.message})`, "warning"));
		}
		if (current.state === "active" && recordExistingRepos(current) > 0) sync(`${current.name}: record repos`);
		ensureRepos(current, ctx);
		// Link the session to its project; pi-sync reads this to reopen it in the same folder elsewhere.
		const link = { projectId: current.id, name: current.name, rel: relative(current.path, ctx.cwd) };
		const last = ctx.sessionManager
			.getEntries()
			.filter((e: any) => e.type === "custom" && e.customType === ENTRY)
			.at(-1) as any;
		if (last?.data?.name !== link.name || last?.data?.rel !== link.rel) pi.appendEntry(ENTRY, link);
	});

	pi.on("session_shutdown", () => {
		ui = undefined;
	});

	pi.on("before_agent_start", (event) => {
		if (section) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, [ENTRY]: section };
	});

	// ---------- tools ----------

	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

	pi.registerTool({
		name: "project_clone",
		label: "Project clone",
		description: "Clone a git repository into the current pi project's repos/ folder.",
		parameters: Type.Object({
			url: Type.String({ description: "Git URL or local path to clone" }),
			name: Type.Optional(Type.String({ description: "Folder name under repos/ (default: derived from URL)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = requireProject();
			const dest = cloneRepo(p, params.url, params.name);
			sync(`${p.name}: clone ${params.name ?? params.url}`);
			refresh(ctx);
			return text(`Cloned into ${dest}`);
		},
	});

	pi.registerTool({
		name: "project_worktree",
		label: "Project worktree",
		description:
			"Create (or reuse) a git worktree for a branch at worktrees/<repo>/<branch> in the current pi project. Creates the branch if needed.",
		parameters: Type.Object({
			repo: Type.String({ description: "Repo folder name under repos/" }),
			branch: Type.String({ description: "Branch name" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dest = addWorktree(requireProject(), params.repo, params.branch);
			refresh(ctx);
			return text(`Worktree ready at ${dest}`);
		},
	});

	pi.registerTool({
		name: "project_remember",
		label: "Project remember",
		description: "Append one durable fact or decision to the current pi project's shared memory.md.",
		parameters: Type.Object({ text: Type.String({ description: "One concise, self-contained fact" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = requireProject();
			remember(p, params.text);
			sync(`${p.name}: remember`);
			refresh(ctx);
			return text("Saved to project memory.");
		},
	});

	// ---------- commands ----------

	const openProject = async (p: Project, ctx: ExtensionCommandContext) => {
		assertActive(p);
		const sessions = projectSessions(p).sort((a, b) => b.file.localeCompare(a.file));
		const NEW = "+ New session";
		const labels = sessions.map((s, i) => {
			const info = s.header as { timestamp?: string };
			// Index suffix keeps labels unique when two sessions share a title and minute.
			return `${info.timestamp?.slice(0, 16).replace("T", " ") ?? "?"}  ${sessionTitle(s.file)}  #${i + 1}`;
		});
		const choice = sessions.length ? await ctx.ui.select(`${p.name}: sessions`, [NEW, ...labels]) : NEW;
		if (!choice) return;
		let file: string;
		if (choice === NEW) {
			const sm = SessionManager.create(p.path);
			file = sm.getSessionFile()!;
			writeFileSync(file, `${JSON.stringify(sm.getHeader())}\n`);
		} else {
			file = sessions[labels.indexOf(choice)].file;
		}
		await ctx.switchSession(file);
	};

	const pick = async (ctx: ExtensionCommandContext, state: Project["state"], title: string) => {
		const names = listProjects()
			.filter((p) => p.state === state)
			.map((p) => p.name);
		if (!names.length) throw new Error(`No ${state} projects.`);
		const n = await ctx.ui.select(title, names);
		return n ? getProject(n) : undefined;
	};

	const target = async (arg: string, ctx: ExtensionCommandContext, state: Project["state"] = "active") =>
		arg ? getProject(arg) : (current ?? (await pick(ctx, state, "Project")));

	const sub: Record<string, (arg: string, ctx: ExtensionCommandContext) => Promise<void>> = {
		async new(arg, ctx) {
			const name = arg || (await ctx.ui.input("Project name", "my-project"));
			if (!name) return;
			const p = createProject(name);
			sync(`${p.name}: new`);
			ctx.ui.notify(`Created project ${p.name} at ${p.path}`, "info");
			await openProject(p, ctx);
		},
		async name(arg, ctx) {
			const [a, b] = arg.split(/\s+/).filter(Boolean);
			const p = b ? getProject(a) : current;
			const newName = b ?? a ?? (await ctx.ui.input("New project name", p?.name ?? ""));
			if (!p) throw new Error("Usage: /project name [project] <new-name>");
			if (!newName) return;
			const own = isInside(ctx.cwd, p.path) ? ctx.sessionManager.getSessionFile() : undefined;
			// pi writes a session file only after the first message; write the header so it moves too.
			if (own && !existsSync(own)) writeFileSync(own, `${JSON.stringify(ctx.sessionManager.getHeader())}\n`);
			const { project: next, moved } = renameProject(p, newName);
			const target = own && moved.get(own);
			const msg = `Renamed ${p.name} → ${next.name}`;
			sync(msg);
			// The command ctx is stale after a switch; use the one pi hands to withSession.
			if (target) await ctx.switchSession(target, { withSession: async (c) => c.ui.notify(msg, "info") });
			else ctx.ui.notify(msg, "info");
		},
		async memory(arg, ctx) {
			const p = await target(arg, ctx);
			if (!p) return;
			// pi's editor dialog owns the terminal; spawning $EDITOR under the TUI would fight it.
			const next = await ctx.ui.editor(`${p.name} memory`, readMemory(p));
			if (next !== undefined) {
				writeFileSync(join(p.path, "memory.md"), next);
				sync(`${p.name}: edit memory`);
			}
			if (current?.id === p.id) refresh(ctx);
		},
		async archive(arg, ctx) {
			const p = await target(arg, ctx);
			if (!p || !(await ctx.ui.confirm("Archive project", `Archive ${p.name}? It will be hidden and read-only.`))) return;
			setState(p, "archived");
			sync(`${p.name}: archive`);
			refresh(ctx);
			ctx.ui.notify(`Archived ${p.name}`, "info");
		},
		async restore(arg, ctx) {
			const p = arg ? getProject(arg) : await pick(ctx, "archived", "Restore project");
			if (!p) return;
			setState(p, "active");
			sync(`${p.name}: restore`);
			refresh(ctx);
			ctx.ui.notify(`Restored ${p.name}`, "info");
		},
		async delete(arg, ctx) {
			const p = arg ? getProject(arg) : await pick(ctx, "active", "Delete project");
			if (!p) return;
			if (isInside(ctx.cwd, p.path)) throw new Error(`This session runs inside ${p.name}. Delete it from outside the project.`);
			const n = projectSessions(p).length;
			if (!(await ctx.ui.confirm("Delete project", `Delete ${p.name}, its folder and its ${n} session(s)? Use /project archive to keep them.`))) return;
			deleteProject(p);
			sync(`${p.name}: delete`);
			ctx.ui.notify(`Deleted ${p.name}`, "info");
		},
		async repos(arg, ctx) {
			const [action, name] = arg.split(/\s+/).filter(Boolean);
			const p = requireProject();
			if (action === "remove" && name) {
				if (!(await ctx.ui.confirm("Remove repo", `Delete repos/${name} from ${p.name} and forget it?`))) return;
				removeRepo(p, name);
				sync(`${p.name}: remove ${name}`);
				refresh(ctx);
				ctx.ui.notify(`Removed ${name}`, "info");
				return;
			}
			if (action) throw new Error("Usage: /project repos [remove <name>]");
			const ws = scanWorkspace(p);
			const lines = (p.repos ?? []).map((r) => {
				const wts = ws.worktrees.filter((w) => w.startsWith(`${r.name}/`)).map((w) => w.slice(r.name.length + 1));
				const here = ws.repos.includes(r.name) ? "" : " (not cloned here)";
				return `${r.name}  ${r.url}${r.branch ? ` (${r.branch})` : ""}${here}${wts.length ? `\n  worktrees: ${wts.join(", ")}` : ""}`;
			});
			ctx.ui.notify(lines.length ? lines.join("\n") : "No repos.", "info");
		},
		async share(arg, ctx) {
			const remote = arg || (await ctx.ui.input("Git remote for your projects (one repo for all)", "git@github.com:you/pi-projects-state.git"));
			if (!remote) return;
			const root = await shareState(remote);
			ctx.ui.notify(`Projects in ${root} now sync through ${remote}`, "info");
		},
		async list(_arg, ctx) {
			const ps = listProjects();
			ctx.ui.notify(ps.length ? ps.map((p) => `${p.name}${p.state === "archived" ? " (archived)" : ""}`).join("\n") : "No projects.", "info");
		},
		async roles(_arg, ctx) {
			const p = requireProject();
			const { grants, problem } = trustedGrants();
			const g = grants.projects[p.id];
			const lines = [`Trust anchor: ${allowedSignersFile()}`, `Grants: ${problem ?? "signed"}`];
			lines.push(`Sandbox: ${g?.sandbox ? "on" : "off"}${role?.sandbox && !g?.sandbox ? " (on for this session)" : ""}`);
			for (const id of g?.roles ?? []) {
				let state = "ok";
				try {
					const r = loadRole(p, id, { fetch: false });
					const missing = Object.keys({ ...r.secrets }).concat(...Object.values(r.broker ?? {}).map((a) => a.env ?? [])).filter((n) => !grants.sources[id]?.[n]);
					if (missing.length) state = `no source for ${[...new Set(missing)].join(", ")}`;
				} catch (e) {
					state = (e as Error).message;
				}
				lines.push(`${id}${g?.default === id ? " (default)" : ""}: ${state}`);
			}
			if (!g?.roles.length) lines.push("No roles granted. /project grant <repo>/<role>");
			ctx.ui.notify(lines.join("\n"), problem ? "warning" : "info");
		},
		async grant(arg, ctx) {
			const p = requireProject();
			const [id, ...flags] = arg.split(/\s+/).filter(Boolean);
			if (!id) throw new Error("Usage: /project grant <repo>/<role> [--default]");
			validateRoleId(id);
			loadRole(p, id); // must exist on origin
			const g = await editableGrants(ctx);
			if (!g) return;
			const cur = g.projects[p.id] ?? { name: p.name, roles: [] };
			cur.name = p.name;
			if (!cur.roles.includes(id)) cur.roles.push(id);
			// The first role is the default: a sandboxed project with no default role runs with no grants at all.
			if (flags.includes("--default") || !cur.default) cur.default = id;
			g.projects[p.id] = cur;
			saveSignedGrants(g);
			refresh(ctx);
			ctx.ui.notify(`Granted ${id} to ${p.name}${cur.default === id ? " (default)" : ""}`, "info");
		},
		async ungrant(arg, ctx) {
			const p = requireProject();
			const g = await editableGrants(ctx);
			const cur = g?.projects[p.id];
			if (!g || !cur) return;
			cur.roles = cur.roles.filter((r) => r !== arg.trim());
			if (cur.default === arg.trim()) delete cur.default;
			saveSignedGrants(g);
			refresh(ctx);
			ctx.ui.notify(`Removed ${arg.trim()} from ${p.name}`, "info");
		},
		async source(arg, ctx) {
			const [id, name, source] = arg.split(/\s+/).filter(Boolean);
			if (!id || !name) throw new Error("Usage: /project source <repo>/<role> <NAME> [keychain:<svc>|op://...|env:X|file:path|value:text] (no source removes it)");
			validateRoleId(id);
			if (source && !/^(keychain|op|env|file|value):/.test(source)) throw new Error(`Unknown source "${source}"`);
			const g = await editableGrants(ctx);
			if (!g) return;
			g.sources[id] = { ...g.sources[id] };
			if (source) g.sources[id][name] = source;
			else delete g.sources[id][name];
			saveSignedGrants(g);
			refresh(ctx);
			ctx.ui.notify(source ? `${id}: ${name} from ${source.split(":")[0]}` : `${id}: removed ${name}`, "info");
		},
		async sign(_arg, ctx) {
			const g = await editableGrants(ctx, { reviewed: true });
			if (!g) return;
			const lines = Object.values(g.projects).map((x) => `${x.name}: ${x.roles.join(", ") || "no roles"}${x.default ? ` (default ${x.default})` : ""}${x.sandbox ? ", sandbox on" : ""}`);
			for (const [id, src] of Object.entries(g.sources)) lines.push(`${id} sources: ${Object.entries(src).map(([k, v]) => `${k}=${v.startsWith("value:") ? v : v.split(":")[0]}`).join(", ")}`);
			if (!(await ctx.ui.confirm("Sign role grants", `${lines.join("\n")}\n\nSign this file?`))) return;
			saveSignedGrants(g);
			refresh(ctx);
			ctx.ui.notify("Grants signed.", "info");
		},
		async sandbox(arg, ctx) {
			const p = requireProject();
			if (arg !== "on" && arg !== "off") throw new Error("Usage: /project sandbox on|off");
			const g = await editableGrants(ctx);
			if (!g) return;
			g.projects[p.id] = { ...(g.projects[p.id] ?? { name: p.name, roles: [] }), sandbox: arg === "on" };
			saveSignedGrants(g);
			const noRole = arg === "on" && !g.projects[p.id].default;
			ctx.ui.notify(
				`Sandbox ${arg} for ${p.name}.${noRole ? " No default role: sessions get no secrets and only the default hosts (/project grant <repo>/<role>)." : ""}`,
				noRole ? "warning" : "info",
			);
			await ctx.reload(); // pi-mounts decides at session start
			return;
		},
		async doctor(_arg, ctx) {
			const issues = doctor();
			ctx.ui.notify(issues.length ? issues.join("\n") : "No issues found.", issues.length ? "warning" : "info");
		},
	};

	/** The grants file to edit, after setting up the trust anchor and refusing to build on a tampered file. */
	async function editableGrants(ctx: ExtensionCommandContext, { reviewed = false } = {}): Promise<GrantsFile | undefined> {
		if (process.env.PI_ROLE) throw new Error("Role runs can't change grants.");
		if (!existsSync(allowedSignersFile())) {
			const [key] = agentKeys();
			if (!key) throw new Error("No SSH key in the agent to sign grants with (1Password SSH agent).");
			const ok = await ctx.ui.confirm(
				"Set up grant signing",
				`Trust ${key.split(" ").slice(0, 2).join(" ").slice(0, 60)}… (${key.split(" ")[2] ?? ""}) to sign role grants? Stored in ${allowedSignersFile()}.`,
			);
			if (!ok) return undefined;
			writeTrustAnchor(key);
		}
		const g = readGrants();
		const { problem } = trustedGrants();
		if (g.signature && problem && !reviewed) {
			const ok = await ctx.ui.confirm("Grants changed outside /project", `${problem}. Re-sign the file as it is now?`);
			if (!ok) return undefined;
		}
		return g;
	}

	pi.registerCommand("project", {
		description: `Pi projects: /project [${Object.keys(sub).join("|")}] [args]`,
		getArgumentCompletions: (prefix: string) =>
			Object.keys(sub)
				.filter((k) => k.startsWith(prefix))
				.map((k) => ({ value: k, label: k })),
		handler: async (args, ctx) => {
			const [cmd = "", ...rest] = args.trim().split(/\s+/);
			try {
				if (!cmd) {
					const NEW = "+ New project";
					const names = listProjects()
						.filter((p) => p.state === "active")
						.map((p) => p.name);
					const choice = await ctx.ui.select("Projects", [NEW, ...names]);
					if (choice === NEW) await sub.new("", ctx);
					else if (choice) await openProject(getProject(choice), ctx);
					return;
				}
				const fn = sub[cmd];
				if (!fn) throw new Error(`Unknown subcommand "${cmd}". Try: ${Object.keys(sub).join(", ")}`);
				await fn(rest.join(" "), ctx);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});
}
