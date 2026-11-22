// role_agent: start a fresh session as a granted role (pi-background), sandboxed (pi-mounts). By default the call
// waits and returns the run's final reply; with background: true, or once the run needs the user or takes long,
// the result comes back to the calling session as a message when the run ends (src/role-runs.ts).
import { relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bg, deliver, sessions, track, waitForRun } from "./role-runs.ts";
import { loadRole, roleRunStart, runName, trustedGrants, validateRoleId } from "./roles.ts";
import { assertActive, isInside, projectForCwd } from "./store.ts";

export function registerRoleAgent(pi: ExtensionAPI) {
	let mine: string | undefined;
	const forget = () => {
		if (mine && sessions.get(mine) === pi) sessions.delete(mine);
		mine = undefined;
	};
	pi.on("session_start", (_e, ctx) => {
		forget();
		mine = ctx.sessionManager.getSessionFile();
		if (mine) sessions.set(mine, pi);
		deliver();
	});
	pi.on("session_shutdown", forget);

	pi.registerTool({
		name: "role_agent",
		label: "Role agent",
		description:
			"Hand a task to one of this project's granted roles (listed in the system prompt). Starts a fresh session as that role, " +
			"sandboxed with the role's network and credentials, not yours. Give it a self-contained task. The call waits for the run " +
			"and returns its final reply. Use background: true for long work; then the call returns at once and the reply arrives " +
			"in this session as a message when the run ends (also if the run stops to ask the user something, or runs over 15 minutes).",
		parameters: Type.Object({
			role: Type.String({ description: "<repo>/<role>, e.g. pi-web/pi-web-developer" }),
			task: Type.String({ description: "Complete instructions; the role session has none of this conversation" }),
			cwd: Type.Optional(Type.String({ description: "Folder relative to the project to start in (default: project root)" })),
			background: Type.Optional(Type.Boolean({ description: "Return at once; the reply arrives later as a message (default false)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx: ExtensionContext) {
			const project = projectForCwd(ctx.cwd);
			if (!project) throw new Error("role_agent needs a pi project session");
			assertActive(project);
			const role = validateRoleId(params.role);
			const { grants, problem } = trustedGrants();
			if (problem) throw new Error(`Can't start ${role}: ${problem}`);
			if (!grants.projects[project.id]?.roles.includes(role)) throw new Error(`${role} is not granted to ${project.name}. Bryan grants roles with /project grant.`);
			loadRole(project, role); // must exist on origin's default branch
			const start = bg()?.start;
			if (!start) throw new Error("role_agent needs pi-background installed");
			const cwd = resolve(project.path, params.cwd ?? ".");
			if (!isInside(cwd, project.path)) throw new Error("cwd must be inside the project");
			const parentFile = ctx.sessionManager.getSessionFile() ?? "";
			const { msg, env } = roleRunStart(role, project.name, params.task);
			// An older pi-background ignores `name`; the run then keeps its first-message title.
			const { file, pid } = start({ cwd, msg, env, name: runName(role, params.task) });
			const run = { parentFile, pid, role, file, started: Date.now() };
			if (params.background || !pid) {
				if (pid) track(run);
				return {
					content: [{ type: "text", text: `Started ${role} (pid ${pid}) in ${relative(project.path, cwd) || "."}. Its result will arrive here as a message. Session: ${file}` }],
					details: { role, pid, file },
				};
			}
			const r = await waitForRun(run, {
				signal,
				onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { role, pid, file } }),
			});
			return { content: [{ type: "text", text: r.text }], details: { role, pid, file, status: r.status, background: r.background }, isError: r.isError };
		},
	});
}
