# Phase 1 (agent roles and sandboxing): implementation and verification plan

Source design: [agent-roles.md](agent-roles.md). Phase 2 is [cluster-caches.md](cluster-caches.md), to be defined later.
Status: plan, revised 2026-11-01 after Bryan's feedback and advisor review; decisions at the end. Nothing is built yet. `agent-roles.md` gets updated to match in M6.

## Goal and threat model

Phase 1 is about **mistakes**: an agent with good intentions misusing access it holds. What limits that:

1. Agent processes don't hold Bryan's credentials.
2. Role credentials exist only in role runs.
3. Agents can't widen their own grants.
4. Agent GitHub write is scoped to the project's repos.

Hostname egress allowlists and secret placeholders mainly defend against **injection**: exfiltration, or content that steers
the agent. They're the Phase 1.5 "parity with Gondolin" ideal, not Phase 1 requirements.

Agent-written code running (tests, hooks) is accepted, since agents run code anyway. Read-only repos and hidden `.pi`
become workflow conveniences once grants are signed and roles are read from `origin`.

## Facts this plan relies on (checked 2026-11-01)

- **Gateway grants exist** (pi-web `workspaced/grants.js`): `{anyProject|repos, serviceAccount, env: [Secret], namespace, egress: label}` from `WORKSPACED_GRANTS`.
  infra's network policy already blocks cluster and LAN CIDRs for workers unless they're labelled `egress: open`.
  Workers are one project per pod, with their own disk.
- **Workers have no `/dev/kvm`**, so Gondolin can't run in pods.
- **Gondolin 0.14** (Mac, QEMU/HVF): read-only and real-FS providers, a shadow provider for hiding paths, symlink-escape
  hardening, hostname allowlists, per-host secret placeholders.
- **pi runs built-in tools anywhere** through public API (`createBashTool`/... with `Operations`; gondolin `host/examples/pi-gondolin.ts`). Other extensions' tools still run in the host pi.
- **pi-subagents children are sandboxed with it** (code-read, `@gotgenes/pi-subagents` 25.0.5, `create-subagent-session.ts:258-299`).
  Children reload every non-excluded extension and request tools by name, so an overriding sandbox `bash`/`read` applies.
  Conditions:
  - the sandbox extension keeps its VM at module level, keyed by project and role;
  - it can't be listed in `excludedExtensionPackages`;
  - project `.pi/agents` and settings aren't writable from the VM.
  Runtime check: M1(j).
- **NVIDIA OpenShell** (Apache-2.0, 0.1.x, weekly stable releases) is the off-the-shelf version of "executor pods plus a
  placeholder proxy", with the agent inside the sandbox.
  - Credential providers with placeholders, including OAuth2 refresh in the gateway.
  - L7 rules by host, path and binary, including per-repo `git-receive-pack`.
  - Landlock filesystem allowlists.
  - Runs on Docker/Podman, a microVM driver, or Kubernetes (Agent Sandbox SIG CRDs and controller; no privileged pods).
  We won't build our own; see Phase 1.5.
- pi CLI has `--tools`/`--exclude-tools`. pi has built-in retry, so drop `@narumitw/pi-retry` from the design.

## Design changes from agent-roles.md

1. **On web, the worker pod is the sandbox.** No executor pods, no Jobs and no proxy of our own in Phase 1.
   - **Default web agent:** the project worker with no infra grant. Bryan's GitHub OAuth is removed from workers and
     replaced by a **token scoped to the project's repos plus the state repo**, minted by the trusted front end. Dotfiles
     and other repos become unpushable from web.
   - **Web role run:** a session in a **role worker** `ws-<project>--<role>` that carries the existing gateway grant.
     New: a worker-to-gateway "dispatch role" call. Holding it is fine, because dispatching granted roles without a prompt is the design intent.
   - **Enforcement on web is the gateway**, not pi-projects in the worker (the agent shares that pod). The gateway verifies
     the signed grant and requires a matching `WORKSPACED_GRANTS` entry. On web the infra grant decides egress and secrets.
     On the Mac the role yaml decides. Keeping the two aligned is a shortcut to fix later.
2. **Grants are signed and live in dotfiles** (`~/.pi/agent/pi-roles.json`, yadm).
   - `/project grant` signs with an SSH key held in 1Password (`ssh-keygen -Y sign`, Touch ID).
   - The trust anchor (allowed-signers) is **not** in dotfiles. On the Mac it's outside every sandbox mount. On web infra
     delivers it as a Secret or ConfigMap to the gateway.
   - Unsigned or invalid grants are ignored, with "grant not signed; run /project grant on the Mac".
3. **Role files are read from `origin/<default>`** after a fetch, so a role changes only through a merge on GitHub.
   Checkout sync can move a local `main`, so local branches can't be trusted.
4. **Mac interactive sessions: Gondolin, tools only** (the host is Bryan's whole home).
   - Gap 1 is handled by a per-role tool policy: MCP servers only from the role's config, and pi-lens and pi-lsp off in sandboxed sessions.
   - Mac role runs get Gondolin placeholders and egress for free.
5. **Cheap hardening:** host-side git in pi-sync and pi-web passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
   pi-syncd gets per-device tokens (every sandbox depends on it, since session writes become prompts elsewhere).

## Milestones

Phase 1a is the Mac plus the shared pieces (M0-M4, M6). Phase 1b is web (M5). M1, M3 and M4 need a laptop session.

### M0: Decisions
- Decisions recorded (below). Update `agent-roles.md` to match (with M6).

### M1: Mac spikes (`scripts/spike-sandbox.mjs`, prints PASS or FAIL per check, run on the laptop)
- (a) repos/ read-only, so an edit fails.
- (b) `git worktree add` and a commit in the worktree both work.
- (c) `.pi`, `.envrc`, `.env*`, `fnox.local.toml` are hidden.
- (d) git with a read-only `.git/config` and `.git/hooks`: what breaks (`push -u`).
- (e) A symlink escape fails.
- (f) Egress allowlist, with the role named in the error.
- (g) HTTPS push with an injected token; the token is not visible in the guest.
- (h) A built-in-tools-in-VM pi session starts in under 2 s with mise and node.
- (i) Optional: k3s through MITM.
- (j) pi-subagents children run their bash in the VM.
- (k) pi-hang-guard composes with the VM bash tool.

### M2: Roles and grants in pi-projects (any machine; unit-tested) — can start now
- Grant file schema and signature verification (`ssh-keygen -Y verify`, with the allowed-signers path supplied by the environment).
- `/project grant`, which signs on the Mac.
- Role loader from `origin/<default>:.pi/roles/<role>.yaml`.
- Secret sources and host groups in global config.
- Granted roles injected into the session prompt. `/project roles` shows grants, signature state and missing secret sources.
- `project.json` writes keep unknown keys, re-reading the file at `store.ts:142,148,267`.

### M3: pi-mounts, the sandboxed interactive session on the Mac
- Gondolin VM per session at module level, keyed by project and role.
- Built-in tools run in the VM, plus the per-role tool policy.
- Egress and secrets come from the role.
- Opt-in per project at first.
- Verify: the M1 checks as tests, plus one real worktree change end to end. pi-sync, pi-projects and pi-background still work from the host.

### M4: role_agent on the Mac
- Check the signed grant, then start a run with `PI_ROLE` through pi-background's runner (decision 3), and return the run id.
- pi-heartbeat extension and the monit check per run (decision 3). A blocked run waits (decision 4).
- Report the result back to the caller.
- Verify:
  - an ungranted or unsigned role is refused;
  - a granted role pushes a branch;
  - the session is listed and the result returned;
  - stop and continue work.

### M5: Web (Phase 1b)
- GitHub App installation tokens for workers, limited to the project's repos plus the state repo (decision 1).
- Gateway: dispatch-role endpoint with signature plus `WORKSPACED_GRANTS` checks, and role workers.
- infra PR: an allowed-signers Secret and the first role's grant.
- Verify:
  - a web agent can't push to dotfiles or another repo;
  - dispatching a granted role works;
  - an unsigned grant is refused by the gateway.

### M6: Docs and memory.

## Phase 1.5: OpenShell spike (injection-level parity on web)
Agent Sandbox CRDs on k3s, a GitHub provider with per-repo `git-receive-pack`, and an Anthropic OAuth provider with refresh.
If it works, worker pods become OpenShell sandboxes, which overlaps with and could replace parts of pi-workspaced.
Risks: 0.1.x, a CRD and controller to run. Not on the Mac (agent-inside means the TUI attaches to a container).

## Decisions (Bryan, 2026-11-01)
1. **Web GitHub scoping: a GitHub App.** The front end mints short-lived installation tokens limited to the project's repos
   plus the state repo, per worker. Bryan creates the App.
2. **State repo stays shared.** With grants signed in dotfiles it holds only `project.json` (id, name, repos) and `memory.md`,
   so cross-project edits are recoverable from git history. Background: the state repo (decided 2026-10-30, Portable
   Projects) exists because pi-sync syncs only sessions, and a session needs its project (memory, repo list) on every machine.
3. **Mac role runs: the pi-background runner, supervised by monit, with a pi-heartbeat extension.** No separate role CLI.
   - pi-heartbeat writes a heartbeat file from pi's event loop.
   - The runner registers a monit check per run (`check file ... if timestamp > 10 minutes then exec <stop>`) and removes it at the end.
   - A stopped stale run is recorded as `stalled`.
   - pi-hang-guard handles stuck tool calls inside pi.
4. **Blocked role runs wait indefinitely** for Bryan (forwarded dialog, "waiting on you", `/bg` to answer). Keep-awake is
   released while waiting, and the heartbeat keeps running so a waiting run isn't counted as stalled. This replaces the doc's "ask
   tools disabled; ends blocked".
5. **Roles: both. `pi-web/pi-web-developer` first, then `infra/infra-developer`** (needs the k3s API spike, M1(i)).
6. Still open: branch protection on `main` for agent-pushed repos.
