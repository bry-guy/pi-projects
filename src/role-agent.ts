// role_agent: start a fresh session as a granted role, in the background (pi-background), sandboxed (pi-mounts).
// The result comes back to the calling session as a message when the run ends.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRole, runName, trustedGrants, validateRoleId } from "./roles.ts";
import { assertActive, isInside, projectForCwd } from "./store.ts";

const RESULT = "role-result";
const FINAL = new Set(["done", "error", "stopped", "stalled", "died"]);

// pi re-runs extension factories per session, so delivery state lives at module level.
interface Pending {
	parentFile: string;
	pid: number;
	role: string;
	file: string;
}
const pending: Pending[] = [];
let live: { pi: ExtensionAPI; file?: string } | undefined;
let poller: NodeJS.Timeout | undefined;

const bg = () => (globalThis as any)[Symbol.for("pi-background.v1")];

/** Last assistant text in a session file. */
function lastReply(file: string): string {
	let text = "";
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const e = JSON.parse(line);
			if (e.type === "message" && e.message?.role === "assistant") {
				const t = [e.message.content].flat().filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
				if (t.trim()) text = t;
			}
		} catch {}
	}
	return text.length > 6000 ? `…${text.slice(-6000)}` : text;
}

function deliver() {
	if (!live?.file || !pending.length) return;
	const runs: any[] = bg()?.runs() ?? [];
	for (const p of [...pending]) {
		if (p.parentFile !== live.file) continue;
		const r = runs.find((x) => x.pid === p.pid);
		if (r && !FINAL.has(r.status)) continue;
		pending.splice(pending.indexOf(p), 1);
		const status = r?.status ?? "died";
		let reply = "";
		try {
			reply = lastReply(p.file);
		} catch {}
		live.pi.sendMessage(
			{
				customType: RESULT,
				display: true,
				content: `Role run ${p.role} ended: ${status}${r?.error ? ` (${r.error})` : ""}.\nSession: ${p.file}\n\n${reply || "(no reply)"}`,
				details: { role: p.role, status, file: p.file },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}
	if (!pending.length && poller) {
		clearInterval(poller);
		poller = undefined;
	}
}

export function registerRoleAgent(pi: ExtensionAPI) {
	pi.on("session_start", (_e, ctx) => {
		live = { pi, file: ctx.sessionManager.getSessionFile() };
		deliver();
	});
	pi.on("session_shutdown", () => {
		live = undefined;
	});

	pi.registerTool({
		name: "role_agent",
		label: "Role agent",
		description:
			"Start a fresh background session as one of this project's granted roles (listed in the system prompt), sandboxed with " +
			"that role's network and secrets. Give it a self-contained task. Returns immediately; the role's final reply arrives " +
			"in this session as a message when it ends.",
		parameters: Type.Object({
			role: Type.String({ description: "<repo>/<role>, e.g. pi-web/pi-web-developer" }),
			task: Type.String({ description: "Complete instructions; the role session has none of this conversation" }),
			cwd: Type.Optional(Type.String({ description: "Folder relative to the project to start in (default: project root)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
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
			const parentFile = ctx.sessionManager.getSessionFile();
			const msg = `You are running as role ${role} for project ${project.name}, started by another session to do one task. Nobody is watching this session; when you're done, end with a short summary of what you did, what you pushed, and anything left undone.\n\nTask:\n${params.task}`;
			// An older pi-background ignores `name`; the run then keeps its first-message title.
			const { file, pid } = start({ cwd, msg, env: { PI_ROLE: role }, name: runName(role, params.task) });
			if (parentFile && pid) {
				pending.push({ parentFile, pid, role, file });
				poller ??= setInterval(deliver, 10_000);
				poller.unref?.();
			}
			return {
				content: [{ type: "text", text: `Started ${role} (pid ${pid}) in ${relative(project.path, cwd) || "."}. Its result will arrive here as a message. Session: ${file}` }],
				details: { role, pid, file },
			};
		},
	});
}
