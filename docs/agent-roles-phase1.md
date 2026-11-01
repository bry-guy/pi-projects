# Phase 1 (agent roles and sandboxing): implementation and verification plan

Source design: [agent-roles.md](agent-roles.md) (Phase 1). Phase 2 is [cluster-caches.md](cluster-caches.md), to be defined later.
Status: draft, reviewed by the advisor 2026-11-01, **waiting on Bryan's answers to the questions below**. Nothing is built.
`agent-roles.md` is unchanged until the questions are answered.

**Where it can run:** M1, M3 and M4 need the laptop (Gondolin needs QEMU with HVF or KVM). Web workers have no `/dev/kvm`,
qemu, tmux or pi binary, so a worker session can only build M2 and the unit tests.

## What exists today (checked)

- **pi-web gateway grants are built** (pi-web `workspaced/grants.js`): `{anyProject|repos, serviceAccount, env: [Secret], namespace, egress: label}` from `WORKSPACED_GRANTS`, assigned per worker (`PUT /v1/workspaces/:name/grant`). `ws-infra` uses the operator grant (`infra-operator` SA, `operator-env` Secret, `egress: open`).
- **Worker egress is already restricted** (infra `selfhost/platform/pi-workspaced/network-policy.yaml`). Workers get internet, but not cluster or LAN CIDRs, unless they're labelled `egress: open`. There is no hostname allowlist or proxy.
- **Workers have no /dev/kvm**, so Gondolin can't run in pods (consistent with the doc: "pods don't run agents in a VM yet").
- **Gondolin 0.14** (macOS and Linux, QEMU) has `RealFSProvider`, `ReadonlyProvider`, symlink-escape hardening, and a `ShadowProvider` that hides paths (deny, or tmpfs writes). It does hostname egress allowlists via HTTP/TLS MITM, and per-host secret placeholders: the guest never sees the value, and Basic auth works too.
- **pi can run built-in tools in a VM** through public API: `createBashTool`/`createReadTool`/... accept `Operations`, as in gondolin `host/examples/pi-gondolin.ts` (292 lines) and pi-chat `gondolin.ts`.
- pi-ez-chat-mount (613 lines) and pi-ez-chat-workspace (plugin-section registry via a `Symbol.for` registry) exist as references. pi-ez-secret-broker v0.2 brokers only bearer HTTP and Proxmox.
- infra `AGENTS.md` has Roles (infra-operator, infra-developer, infra-admin) backed by fnox and 1Password vaults, plus an SSH deploy key for infra-developer. No repo has `.pi/roles/` yet.
- pi CLI has `--tools`/`--exclude-tools`. pi has built-in retry, so `@narumitw/pi-retry` is deprecated and the doc should drop it.
- pi-background now drives `pi --mode rpc` as a detached runner, with lock, run record, socket, watch, stop, and forwarded dialogs.

## Gaps found in the design

Gaps 1-3 are security findings. Gaps 4-5 are **proposed changes to decisions in agent-roles.md**; Bryan decides them.

1. **Host-side tools and code escape the VM.** Only the tools we replace (read, write, edit, bash, ls, find, grep) run in the VM. Every other extension tool runs on the host as Bryan: mcp, pi-lsp, pi-lens (which runs linters whose configs are code), web-access, subagents, worktree_include. *Proposal:* a sandboxed session keeps a **host-tool allowlist** (project_*, advisor, todo, ask_user_question, web search/fetch) and disables the rest via pi's tool selection. pi-lens and pi-lsp stay off in sandboxed sessions until they can run in the VM.
   Two more vectors to check: (a) `@gotgenes/pi-subagents` children: do they use the parent's overridden tools, or build
   their own host `createBashTool`? If they build their own, disable subagents in sandboxed sessions. (b) project-local
   `.pi/extensions` load into the host pi. The session cwd is the project folder (not agent-writable in the VM), but confirm
   pi never loads extensions from an agent-writable worktree, and check what pi's project trust does there.
2. **Writable `.git` runs code on the host.** An agent can set `core.fsmonitor` or `core.hooksPath` or write hooks, and host-side git (pi-sync checkout sync runs `git status` every turn, plus pi-web's git panel) would execute it automatically as Bryan. The doc accepts hooks run *by Bryan*, but this one fires automatically. *Proposal:* shadow `.git/config`, `.git/hooks` and `.git/worktrees/*/config.worktree` read-only in the mount (watch `include.path`), and have pi-sync's and pi-web's git calls pass `-c core.fsmonitor=false -c core.hooksPath=/dev/null`. If `git worktree add` breaks with a read-only config, fall back to that host-side hardening alone.
3. **Grants can be rewritten through sync.** project.json lives in the state repo. Web project workers are not sandboxed and push with Bryan's GitHub OAuth, so a web agent can edit `roles.grant` and the change syncs to the Mac. *Proposal:* the Mac applies synced grant changes only after a one-time local confirmation ("pi-web-ecosystem now grants infra/infra-developer, allow?"), stored per machine, outside the state repo. The doc's claims "agents never push to the share repo" and "agent GitHub access is per repo" hold only for sandboxed (Mac) sessions; on web they cannot hold in Phase 1.
4. **(Proposed change: Deployments instead of Jobs, or defer web.) On web, Phase 1 cannot sandbox the project agent** (no KVM, Bryan's GitHub credential in the worker). Web Phase 1 = **role workers through existing gateway grants** (two keys: project.json grants the role *and* infra's `WORKSPACED_GRANTS` must contain a matching grant). Use existing Deployment workers (`ws-<project>--<role>`, sleep and wake) rather than new Job machinery. Jobs, the egress proxy, and sandboxing the web project agent move to a later phase. Caution: letting a worker call the gateway gives a new credential to the unsandboxed web agent, which already holds Bryan's GitHub OAuth and can rewrite `roles.grant`. On web the only real gate is infra's `WORKSPACED_GRANTS` repo list. That is why web is split out as Phase 1b.
5. **(Proposed change, an option, not the recommendation.) Role-run runner: reuse pi-background, not a new pi-role CLI plus monit/systemd.** On the Mac, pi-background's runner already gives a detached `pi --mode rpc`, lock, run record, /bg list, stop, watch and forwarded dialogs. Add `PI_ROLE=<repo>/<role>` so pi-mounts in the child builds that role's VM. A role run that needs Bryan **waits on him** (forwarded dialog) instead of ending "blocked". This contradicts the doc's "disable ask_user_question; a blocked run ends 'blocked: needs X'" and "the harness owns the lifecycle". Tradeoff: waiting keeps the turn alive and lets Bryan unblock it in place, while ending makes runs predictable and unattended-safe. Either way the runner can be pi-background's. Stalls: install pi-hang-guard for tool calls (check that it composes with the overridden bash tool). pi-heartbeat with monit/systemd is deferred, since pi-background already reports a dead runner. *Dependency:* pi-projects' `role_agent` calls pi-background's runner (exported spawn helper). If pi-background is absent, role_agent fails with "install pi-background".
6. **Non-HTTP credentials:** git over SSH deploy keys and the k3s API (6443, custom CA, bearer token) don't fit header injection cleanly. *Proposal:* Phase 1 roles use HTTPS git with an injected `GH_TOKEN`. k3s via Gondolin TLS MITM is a spike, and if it fails, infra roles stay on the host (as today) until the broker exists.
7. **Default sandboxed agent egress:** "no role egress" needs a base set, or the agent can't fetch packages. *Proposal:* the default allows the global `tooling` group (npm, pypi, github.com read, mise downloads) with no secrets.

## Milestones

**Phase 1a (Mac): M0-M4, M6. Phase 1b (web role workers): M5, a separate later decision.**

Every VM step **must run on the laptop** (macOS, QEMU/HVF). This session's worker can't run Gondolin.

### M0: Decide and scope (no code)
- Bryan answers gaps 1-7 (or the advisor's revisions).
- Pick the **first role**, following the doc's "First step": list what project agents keep failing at. Candidate: `pi-web/pi-web-developer` (GH_TOKEN for api.github.com and github.com, for PR and CI checks), which is simpler than infra.
- Update `docs/agent-roles.md` with the decisions.

### M1: Spikes on the Mac (throwaway scripts in `artifacts/`, outcome-only output)
Gondolin host script, scratch repo:
- (a) repos/ files read-only: an edit fails with `EROFS`, and `git checkout` in `repos/<r>` fails.
- (b) `git worktree add` from `repos/<r>` works, and commit in the worktree works.
- (c) `.pi`, `.envrc`, `.env*`, `fnox.local.toml` are invisible (ls, stat, open, create) via ShadowProvider. Also check that `node_modules` hiding is configurable.
- (d) `.git/config` and `.git/hooks` are read-only, and `git config core.fsmonitor x` fails. Check what breaks (`push -u`).
- (e) Symlink created in a worktree pointing to `/Users/...` can't be read from the guest.
- (f) Egress: an allowlisted host works, any other host fails, and the error text can carry the role hint.
- (g) Secret: `git push` over HTTPS to a scratch GitHub repo works with an injected token, and the token is absent from guest env, files and `/proc`.
- (h) A built-in-tools-in-VM pi session (pi-gondolin example) runs `mise`/`node` from a Debian/Fedora image, and VM start is under 2 s.
- (i) k3s through MITM (optional, gap 6).
- (j) pi-subagents children run their bash in the VM, not on the host (gap 1a).
- (k) pi-hang-guard aborts a silent `sleep 600` run through the VM bash tool.
Delivered as one script, `pi-projects/scripts/spike-sandbox.mjs`, that prints PASS or FAIL per check. Bryan or a laptop session runs it.
Exit: each check passes or the design changes.

### M2: Roles and grants in pi-projects (pure code, unit-tested; can be built from any machine)
- `project.json` sections: pi-projects owns `repos` and `roles`, and pi-mounts reads `mounts` itself. No plugin registry (shortcut: add one when a third extension needs a section). Requirement: every write keeps unknown top-level keys. `loadProject`/`saveProject` already spread them, but `store.ts:142, 148, 267` save an in-memory copy without re-reading, which can drop keys pulled in by the state repo. Make them re-read first, and test that.
- Role loader: `<repo>/.pi/roles/<role>.yaml` read via `git show <default-branch>:.pi/roles/<role>.yaml`, so it reads main, not whatever is checked out. Schema: `egress[]`, `secrets{NAME:{hosts[]}}`, `broker{}` (parsed, unused).
- Global config: `~/.pi/agent/pi-roles.json`, with secret sources keyed `<repo>/<role>` (`op://`, `fnox:`, `env:`, and later `k8s:`), plus host groups (`tooling`).
- Local grant approval (gap 3): `~/.pi/agent/pi-roles-approved.json` holds the project id, a hash of the grant list, and a timestamp.
- Session start: inject the granted roles into the prompt. `/project roles` shows grants, approval state, and missing secret sources.
- Tests: schema, grant resolution, approval required after a synced change, and role read from main rather than from a dirty checkout.

### M3: pi-mounts, the sandboxed session on the Mac (new repo `pi-mounts`)
- Owns the `mounts` section. Starts one Gondolin VM per session with the project layout (gap answers 1, 2, 7). Overrides built-in tools via `Operations`, applies the host-tool allowlist, and builds egress plus secrets from the session's role (`PI_ROLE` or `roles.default`) and resolves secret sources on the host.
- Opt-in per project at first (`mounts` present means sandboxed). It becomes the default only after it's been used for real.
- Errors name the role that has a blocked host or missing secret.
- Verify: the M1 checks rerun as automated tests through the extension, plus one real session doing a small change in a worktree end to end. Also check that pi-sync, pi-projects and pi-background still work (lock, sync, checkout sync from the host).

### M4: role_agent (Mac)
- pi-projects tool `role_agent(role, task, cwd?)`: checks the grant and approval, then calls pi-background to start a new session in the project with `PI_ROLE`, and returns at once with the run id.
- On finish, the result (the last assistant text, plus status done, stopped, error or waiting) goes back to the calling session as a message, or as a notice if that session is closed. The run shows in `/bg list` and `/project`.
- Install and configure pi-hang-guard (`mode: guard`).
- This is the doc's open check 4 ("a host-started pi takes a role").
- Verify, end to end on the laptop: (a) a sandboxed default agent can't reach api.github.com with a token, (b) it dispatches `pi-web/pi-web-developer`, (c) the child pushes a branch in a worktree, (d) the result returns and the session is listed, (e) an ungranted role is refused with a clear error, (f) a dialog in the child surfaces as "waiting on you", (g) stop and continue work.

### M5: Web role workers (pi-web plus an infra PR)
- Gateway: workspace create accepts `{project, role}`, maps the role to a grant name, and refuses unless the grant exists and allows the project's repo. Worker naming is `ws-<project>--<role>`.
- pi-web worker route to start a session with a task in the project folder (reuse POST /api/pi-projects sessions plus message). `role_agent` on a web worker calls it through the gateway (needs a worker-to-gateway credential scoped to "start role sessions for my project" and a new auth path; design it here).
- infra PR: grant `pi-web-developer` (Secret with GH_TOKEN, egress label).
- Verify: from a web project session, dispatch the role. The role worker wakes, runs, and pushes a branch. The session appears in the project (pi-sync). An ungranted role or a missing gateway grant is refused.

### M6: Docs and memory
- Update `agent-roles.md` (decisions, removed pi-retry, runner = pi-background, web limits), memory.md, and the repo READMEs.

## Out of Phase 1
Egress proxy, the Job backend, the broker, sandboxing the web project agent (needs KVM or another isolation), pi-heartbeat with monit/systemd, a separate agent GitHub identity, and the cluster caches (Phase 2).

## Phase 2 hooks to keep open
Tool cache path configurable per role (`MISE_SHARED_INSTALL_DIRS`), the image chosen per role, and a git `--reference` option in clone code.
