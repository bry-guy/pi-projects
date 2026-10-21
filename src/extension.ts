import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	cloneRepo,
	createProject,
	deleteProject,
	doctor,
	getProject,
	isInside,
	listProjects,
	type Project,
	projectForCwd,
	projectSessions,
	readMemory,
	remember,
	renameProject,
	scanWorkspace,
	setState,
} from "./store.ts";

const ENTRY = "pi-project";
const STATUS = "pi-project";

function buildSection(p: Project): string {
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
	let current: Project | undefined;
	let section: string | undefined;

	const refresh = (ctx: ExtensionContext) => {
		current = projectForCwd(ctx.cwd);
		section = current ? buildSection(current) : undefined;
		ctx.ui.setStatus(STATUS, current ? `project: ${current.name}${current.state === "archived" ? " (archived)" : ""}` : undefined);
	};

	const requireProject = (): Project => {
		if (!current) throw new Error("This session is not in a pi project. Open one with /project.");
		assertActive(current);
		return current;
	};

	pi.on("session_start", (_event, ctx) => {
		refresh(ctx);
		if (current && !ctx.sessionManager.getEntries().some((e: any) => e.type === "custom" && e.customType === ENTRY)) {
			pi.appendEntry(ENTRY, { projectId: current.id });
		}
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
			const dest = cloneRepo(requireProject(), params.url, params.name);
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
			remember(requireProject(), params.text);
			refresh(ctx);
			return text("Saved to project memory.");
		},
	});

	// ---------- commands ----------

	const openProject = async (p: Project, ctx: ExtensionCommandContext) => {
		assertActive(p);
		const sessions = projectSessions(p).sort((a, b) => b.file.localeCompare(a.file));
		const NEW = "+ New session";
		const labels = sessions.map((s) => {
			const info = s.header as { timestamp?: string };
			return `${info.timestamp?.slice(0, 16).replace("T", " ") ?? "?"}  ${s.file.split("/").pop()}`;
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
			// The command ctx is stale after a switch; use the one pi hands to withSession.
			if (target) await ctx.switchSession(target, { withSession: async (c) => c.ui.notify(msg, "info") });
			else ctx.ui.notify(msg, "info");
		},
		async memory(arg, ctx) {
			const p = await target(arg, ctx);
			if (!p) return;
			// pi's editor dialog owns the terminal; spawning $EDITOR under the TUI would fight it.
			const next = await ctx.ui.editor(`${p.name} memory`, readMemory(p));
			if (next !== undefined) writeFileSync(join(p.path, "memory.md"), next);
			if (current?.id === p.id) refresh(ctx);
		},
		async archive(arg, ctx) {
			const p = await target(arg, ctx);
			if (!p || !(await ctx.ui.confirm("Archive project", `Archive ${p.name}? It will be hidden and read-only.`))) return;
			setState(p, "archived");
			refresh(ctx);
			ctx.ui.notify(`Archived ${p.name}`, "info");
		},
		async restore(arg, ctx) {
			const p = arg ? getProject(arg) : await pick(ctx, "archived", "Restore project");
			if (!p) return;
			setState(p, "active");
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
			ctx.ui.notify(`Deleted ${p.name}`, "info");
		},
		async list(_arg, ctx) {
			const ps = listProjects();
			ctx.ui.notify(ps.length ? ps.map((p) => `${p.name}${p.state === "archived" ? " (archived)" : ""}`).join("\n") : "No projects.", "info");
		},
		async doctor(_arg, ctx) {
			const issues = doctor();
			ctx.ui.notify(issues.length ? issues.join("\n") : "No issues found.", issues.length ? "warning" : "info");
		},
	};

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
