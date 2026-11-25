// role_agent: start a fresh session as a granted role (pi-background), sandboxed (pi-mounts). By default the call
// waits and returns the run's final reply; with background: true, or once the run needs the user or takes long,
// the result comes back to the calling session as a message when the run ends (src/role-runs.ts).
// A host that offers its own runner (pi-web's workers) runs the role instead, in its own sandbox.
// With `session`, the task goes to an earlier run's session as its next message, under the same role.
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bg, deliver, runner, sessions, stillRunning, track, waitForRun } from "./role-runs.ts";
import { loadRole, roleRunStart, runName, trustedGrants, validateRoleId } from "./roles.ts";
import { assertActive, isInside, projectForCwd } from "./store.ts";

/**
 * Custom entry in the calling session for each run it starts: { file, pid, role, project (id), started }. A follow-up
 * is allowed only on a run recorded here, so which role and project a session ran as never comes from that session.
 */
const RUN = "role-run";

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
			"in this session as a message when the run ends (also if the run stops to ask the user something, or runs over 15 minutes). " +
			"To add to a run you started from this session (more work, or the answer to a question it ended on), call again with the same " +
			"role and `session` set to the session (or run id) its result named: `task` is then sent as the next message in that run's " +
			"session, which still has its earlier work, and the reply comes back the same way. Only once that run has ended.",
		parameters: Type.Object({
			role: Type.String({ description: "<repo>/<role>, e.g. pi-web/pi-web-developer" }),
			task: Type.String({ description: "Complete instructions; the role session has none of this conversation" }),
			cwd: Type.Optional(Type.String({ description: "Folder relative to the project to start in (default: project root)" })),
			background: Type.Optional(Type.Boolean({ description: "Return at once; the reply arrives later as a message (default false)" })),
			session: Type.Optional(
				Type.String({ description: "Follow up on an earlier run of this role instead of starting one: the session (or run id) its result named. cwd is ignored" }),
			),
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
			const via = runner();
			if (!via) throw new Error("role_agent needs pi-background installed");
			const cwd = resolve(project.path, params.cwd ?? ".");
			if (!isInside(cwd, project.path)) throw new Error("cwd must be inside the project");
			const parentFile = ctx.sessionManager.getSessionFile() ?? "";
			const { msg, env } = roleRunStart(role, project.name, params.task);
			const again = params.session?.trim();
			if (via.host) {
				// A host from before follow-ups would start a new run with the bare task.
				if (again && !via.host.followUps) throw new Error(`Can't follow up on ${again}: this host can't send a role run another message yet. Start a new run.`);
				// The host's failure is the tool's error: there is no other way to run the role here.
				const r = await via.host.run({
					project: project.name,
					role,
					msg: again ? params.task : msg,
					name: runName(role, params.task),
					cwd: relative(project.path, cwd) || ".",
					session: ctx.sessionManager.getSessionId(),
					background: !!params.background,
					...(again ? { followUp: again } : {}),
					signal,
					onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }], details: { role } }),
				});
				return { content: [{ type: "text", text: r.text }], details: { role, status: r.status, background: r.background }, isError: r.isError };
			}
			let started: { file: string; pid: number };
			if (again) {
				// Same role and same project come from this session's own record of the runs it started.
				const last = ctx.sessionManager.getEntries().findLast((e: any) => e.type === "custom" && e.customType === RUN && e.data?.file === again && e.data.role === role && e.data.project === project.id) as any;
				if (!last) throw new Error(`Can't follow up on ${again}: it is not a ${role} run that this session started in ${project.name}.`);
				if (!existsSync(again)) throw new Error(`Can't follow up on ${again}: that session can't be found.`);
				if (stillRunning(again, last.data)) throw new Error(`Can't follow up on ${again}: ${role} is still running there. Wait for its result.`);
				const send = bg()?.send;
				if (!send) throw new Error(`Can't follow up on ${again}: this pi-background can't send a run another message. Update it (pi update).`);
				// The same env as the first turn (PI_ROLE): the same role, sandbox and credentials, never this session's.
				started = send({ file: again, msg: params.task, env });
			}
			// An older pi-background ignores `name`; the run then keeps its first-message title.
			else started = via.start({ cwd, msg, env, name: runName(role, params.task) });
			const { file, pid } = started;
			const run = { parentFile, pid, role, file, started: Date.now() };
			if (pid) pi.appendEntry(RUN, { file, pid, role, project: project.id, started: run.started });
			if (params.background || !pid) {
				if (pid) track(run);
				const what = again ? `Sent ${role} the follow-up (pid ${pid})` : `Started ${role} (pid ${pid}) in ${relative(project.path, cwd) || "."}`;
				return {
					content: [{ type: "text", text: `${what}. Its result will arrive here as a message. Session: ${file}` }],
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
