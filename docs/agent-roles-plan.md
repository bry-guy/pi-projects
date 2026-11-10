# Agent roles and sandboxing: implementation and verification plan

Source design: [agent-roles.md](agent-roles.md).

Phases (reordered 2026-11-02 by Bryan):
1. **Phase 1, local (Mac):** Gondolin sandbox, roles and grants, role runs, secret broker. Built and finished first.
2. **Phase 2, web:** the OpenShell spike (kit in `spikes/openshell`) for agent and role runs on web workers, then web
   roles and scoped GitHub tokens. Interactive web sessions keep the worker pod as their boundary.
3. **Phase 3, cluster caches:** [cluster-caches.md](cluster-caches.md), to be defined later.
Status: Phase 1 built and its done-criterion met (both roles ran on the Mac); the remaining Phase 1 work is listed
below. Decisions at the end. `agent-roles.md` describes the current design (updated 2026-11-10).

Decision (Bryan, 2026-11-10): **interactive sessions are admin on the host; unattended agents run as roles.** Turning
the sandbox on by default for interactive sessions is dropped as a goal and is not part of finishing Phase 1;
`/project sandbox on` stays a per-project option. Role runs are always sandboxed. What makes the split usable:
`role_agent` waits and returns the run's reply (pi-projects #7), and pi-secret-broker redacts secret values in every
session (pi-secret-broker #1, #2). A role as an in-process subagent type was rejected (see agent-roles.md, Admin
sessions and role runs). New role actions come from the `role-survey` skill, not up-front design.

## Images (decided 2026-11-07)

Three images, one per use, all on Fedora (glibc; Alpine's musl broke prebuilt tools such as mise's Node). Built
multi-arch (Mac arm64, k3s amd64). Each is built separately; the few shared tool lines are duplicated, not layered.

| Image | Base | Contents | Used by |
|---|---|---|---|
| `pi-local-sandbox` | `fedora-minimal` | bash, git, ripgrep, fd, curl, openssh-clients, ca-certificates | Gondolin VM on the Mac (via Gondolin's `oci` rootfs) |
| `pi-web-worker` | `fedora-minimal` | the same tools plus Node, pi and the pi-web worker server | web workers (pi runs inside) |
| `pi-web` | `fedora-minimal` | Node, the pi-web app and workspaced | front end and workspaced |

`pi-web-worker` is the thin default for self-hosters (they don't use Gondolin); anyone can build their own image
`FROM` it. It replaces pi-mounts' hand-built Alpine `pi-worker` image and the musl mise workaround. Today all
of pi-web runs one Debian image (`ghcr.io/bry-guy/pi-ez-web`), which `pi-web-worker` and `pi-web` replace in Phase 2.

## Phase 1 remaining (2026-11-07)

- **R1 k3s view token:** check the real expiry of the shared `infra-k3s-view` token (noted as 2026-11-23) and renew it
  before then.
- **R2 `pi-local-sandbox`:** spike Gondolin booting from a `fedora-minimal` OCI rootfs and pass the pi-mounts checks
  (`scripts/spike-sandbox.mjs`); then add the Dockerfile and multi-arch build, point pi-mounts at it, drop the Alpine
  image config and the musl workaround.
- **R3 checks:** the `gh auth status` token line in a role run is the placeholder, not the real token; ruleset bypasses (infra RepositoryRole, pi-web DeployKey plus admin) behave as
  intended or are removed; dialog forwarding in a real TUI.
- **R4 pi-syncd per-device tokens:** pi-syncd has no authentication, so anything that reaches it can read or plant
  session text that the Mac later resumes.
- **R5 docs:** `agent-roles.md` to the current design (runner, wait on block, role workers, no custom proxy, images);
  repository-sessions reconciled with the project-folder rule; pi-mounts README (Gondolin `fix/undici-7`, upstream PR);
  rule: environment variables are never a security gate (grants are signed).
- **R6 cleanup:** delete old Gondolin branches (`fix/forward-undecoded-content-encoding`, `fix/fetch-accept-encoding`).
  Bryan: dotfiles `settings.json`, `~/dev/castaway` changes.
- Homelab project, not here: infra hygiene (VM SSH key on all nodes, tailnet `tag:admin-mac` root SSH, developer vault
  can read the OpenTofu state passphrase, `yq`/`shasum` in `selfhost-media-upload.sh`) and an admin-role decision.
- Parked: infra deploy key retirement (Phase 1b), pi-observational-memory stale-ctx warning (upstream #108).

## Phase 1 status (2026-11-02)

Built on the Mac. Repos: pi-projects (roles, signed grants, `role_agent`), pi-mounts (new, Gondolin sandbox),
pi-secret-broker (renamed from pi-ez-secret-broker, rebuilt), pi-background (stall guard, `start()` API), pi-sync
(host git without hooks/fsmonitor). Role files: pi-web `pi-web-developer`, infra `infra-developer` (branch
`agent/role-file`, waiting on Bryan's merge).

M1 checks (`pi-mounts/scripts/spike-sandbox.mjs`), all PASS except where noted:
(a) repos read-only; (b) worktree add and commit; (c) hidden files; (d) `.git` writable, accepted; (e) symlink escape
fails; (f) egress allowlist (`403 blocked by policy`); (g) placeholder token, `gh` and an HTTPS push work and the guest
never sees the token; (h) boot ~0.9 s, node 22 via mise (musl, needs the upstream musl mise binary and the patched
Gondolin); (i) k3s API is unreachable from the VM (tailnet IP), so kubectl is a broker action; (j) pi-subagents
children run in the same VM when pi-mounts is installed as a package (not with `pi -e`); (k) pi-hang-guard isn't
installed, skipped.

Differences from the plan:
- Role files are JSON, not YAML.
- No separate pi-heartbeat extension: pi-background's runner writes the heartbeat on every pi RPC event (and while
  waiting on you); a per-run monit check stops runs stale for 10 minutes (`stalled`).
- Interactive sessions stay unsandboxed unless `/project sandbox on`; role runs are always sandboxed. Made permanent
  2026-11-10 (admin on the host, agents in roles).
- Subagents inherit their parent: admin in an admin session, sandboxed as the role in a role run (verified
  2026-11-10, 11 probes).
- infra-developer Developer tasks (apply, build) ask Bryan first (`approve: ask`); Operator tasks run without asking.
  Flip in `scripts/agent-role-file.py`.
- Gondolin runs from a local build until the Accept-Encoding fix is upstream (PR prepared, not sent).

Getting changes out (2026-11-07): each role has its own GitHub App (`bry-guy-pi-web-developer`,
`bry-guy-infra-developer`), installed only on its repo, whose 1-hour tokens the broker mints from 1Password
(`github-app:op://<role>/github-app`, limited to the item's `repos`). Agents push `feature/<name>` (pi-web: deploys
preview) or `agent/<name>`, open a PR and `gh pr merge --auto --squash`. Rulesets on `main` require a PR and passing CI
(`test` on pi-web, `check` on infra); CODEOWNERS makes PRs touching `.pi/`, `.github/` (and pi-web `deploy/`,
`scripts/deploy.sh`) wait for Bryan. Verified: an infra-developer role run merged its own docs PR; a bot PR touching
`.pi/` stayed blocked with CI green; the pi-web bot can't push `main`. pi-web workflows push `main` with a `ci-main`
deploy key, and the deploy job runs `deploy.sh` from `main`, never from the pushed branch.

## Goal and threat model

Phase 1 is about **mistakes**: an agent with good intentions misusing access it holds. What limits that:

1. Agent processes don't hold Bryan's credentials.
2. Role credentials exist only in role runs.
3. Agents can't widen their own grants.
4. Agent GitHub write is scoped to the project's repos.

Hostname egress allowlists and secret placeholders mainly defend against **injection**: exfiltration, or content that steers
the agent. On the Mac Gondolin gives them anyway. On web they're the Phase 2 "parity with Gondolin" goal.

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
  We won't build our own; see Phase 2.
- pi CLI has `--tools`/`--exclude-tools`. pi has built-in retry, so drop `@narumitw/pi-retry` from the design.

## Design changes from agent-roles.md

1. **On web (Phase 2), the worker pod is the sandbox for interactive sessions.** No executor pods, no Jobs and no proxy
   of our own. Agent and role runs move to OpenShell sandboxes if the spike holds (W1).
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
4. **Mac sandboxed sessions (role runs, and projects with `/project sandbox on`): Gondolin, tools only** (the host is
   Bryan's whole home). Interactive sessions are admin on the host by default (2026-11-10).
   - Gap 1 is handled by a per-role tool policy: MCP servers only from the role's config, and pi-lens and pi-lsp off in sandboxed sessions.
   - Mac role runs get Gondolin placeholders and egress for free.
5. **Cheap hardening:** host-side git in pi-sync and pi-web passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
   pi-syncd gets per-device tokens (every sandbox depends on it, since session writes become prompts elsewhere).

## Milestones

### Phase 1: local (Mac)

M0-M6. M1, M3, M4 and M5 need a laptop session. M2 can be built anywhere.

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

### M3: pi-mounts, the sandboxed session on the Mac
- Gondolin VM per session at module level, keyed by project and role.
- Built-in tools run in the VM, plus the per-role tool policy.
- Egress and secrets come from the role.
- Opt-in per project for interactive sessions, and it stays opt-in (2026-11-10); always on for role runs.
- Verify: the M1 checks as tests, plus one real worktree change end to end. pi-sync, pi-projects and pi-background still work from the host.

### M4: role_agent on the Mac
- Check the signed grant, then start a run with `PI_ROLE` through pi-background's runner (decision 3). Since
  2026-11-10 the call waits and returns the run's reply; `background: true` returns the run id at once.
- pi-heartbeat extension and the monit check per run (decision 3). A blocked run waits (decision 4).
- Report the result back to the caller (tool result, or a message for background runs).
- Verify:
  - an ungranted or unsigned role is refused;
  - a granted role pushes a branch;
  - the session is listed and the result returned;
  - stop and continue work.

### M5: Secret broker on the Mac (from pi-ez-secret-broker)
- HTTP secrets need no broker: Gondolin injects them per host as placeholders (M1(g)), which covers the first role's `GH_TOKEN`.
- The broker covers the role yaml's `broker:` actions for non-HTTP credentials. It runs on the host, holds the secret,
  and the VM only sends a request. First actions: what `infra-developer` needs (`tofu plan`, then k3s if M1(i) fails).
  Later: S3 signing, read-only Postgres.
- pi-ez-secret-broker v0.2.0 brokers only bearer-token HTTP and Proxmox; port it into pi-mounts or keep it a separate
  package (decide when starting M5).
- Verify:
  - a declared `auto` action runs, and the guest never sees the secret;
  - an undeclared action, or one for an ungranted role, is refused;
  - secrets resolve from global config (`op://`), and a missing source is reported by `/project roles`.

### M6: Docs and memory
Update `agent-roles.md` to match. Phase 1 is done when `pi-web-developer` and `infra-developer` role runs work on the Mac.

## Phase 2: web (paused until Phase 1 is done)

### W1: OpenShell spike (injection-level parity for agent runs on web)
Kit ready in `spikes/openshell` (tests only our setup: login rotation, the pi shim through the real proxy, the worker
image with our disk and SSE, pi-syncd). Runs from the laptop with admin approval.
If it works, workspaced gets an `openshell` provider next to `local` and `kubernetes` (same API, so web is unchanged)
for agent and role runs; interactive web sessions stay on today's provider. The costs are allow-only egress for those
workers, placeholder logins, and moving their disks.

### W2: Web roles (was M5)
- GitHub App installation tokens for workers, limited to the project's repos plus the state repo (decision 1).
- Gateway: dispatch-role endpoint with signature plus `WORKSPACED_GRANTS` checks, and role workers.
- infra PR: an allowed-signers Secret and the first role's grant.
- Verify:
  - a web agent can't push to dotfiles or another repo;
  - dispatching a granted role works;
  - an unsigned grant is refused by the gateway.

Shape depends on W1: role workers on today's provider, or OpenShell sandboxes with providers and policy.

Role workers are ordinary workspaced workers (`ws-<project>--<role>`), so they sleep when idle and wake in ~5-6 s. A run
waiting on Bryan counts as busy and holds one of the `WORKSPACED_MAX_AWAKE` slots until answered.

### W3: Model login hardening (done, pi-web 8c1f0ee)
Workers get access tokens only; web holds the refresh token. OpenShell's gateway login could replace this later.

### W4: Images
Build `pi-web-worker` and `pi-web` (see Images), multi-arch, and move workers, the front end and workspaced off
`pi-ez-web`. Settle with W1: OpenShell sandboxes would run `pi-web-worker`.

### W1 background: OpenShell notes
Agent Sandbox CRDs on k3s, a GitHub provider with per-repo `git-receive-pack`, and an Anthropic OAuth provider with refresh.
If it works, agent and role worker pods become OpenShell sandboxes, which overlaps with parts of pi-workspaced.
Risks: 0.1.x, a CRD and controller to run. Not on the Mac (agent-inside means the TUI attaches to a container).
The Mac stays on Gondolin (decided).

Model login through OpenShell (from code reading, 2026-11-01; unverified):
- "The gateway" here is OpenShell's own gateway (`openshell-server`, its own store), not pi-workspaced. The gateway holds
  the refresh token and mints access tokens. The sandbox supervisor's proxy injects them into matching requests. pi sees
  only a placeholder.
- Rotated refresh tokens are stored (`provider_refresh.rs:1175-1245`).
- The gateway needs **its own login**. A refresh token shared with the laptop or the worker breaks when one side rotates it.
- **Check 1, passed (2026-11-01):** a form-encoded refresh is accepted by `platform.claude.com/v1/oauth/token`.
  Form and JSON both reach the grant check (`400 invalid_grant` for a bogus token). The endpoint returns 429 for curl's
  user agent, but not for an empty one, `reqwest`, or `openshell` (OpenShell's reqwest client sends none by default).
- **Check 2, solved on the pi side (2026-11-01):** OpenShell rewrites a header only if it is exactly `<scheme> <placeholder>`
  (`secrets.rs:522-560`).
  - Shim: pi is given the key `sk-ant-oat01-openshell`, so it stays in OAuth mode with Claude Code headers. A ~20-line
    extension wraps `fetch` and changes `Authorization` to `Bearer openshell:resolve:env:ANTHROPIC_OAUTH_TOKEN`.
  - Tested with pi 1.4.0 plus anthropic-auth, through a local stand-in proxy applying the same rule (harness in
    `pi-web-ecosystem/artifacts/research/openshell-test`):
    - without the shim, the request is refused;
    - with it, the request is rewritten and upstream returns 200 (`OPENSHELL-OK`).
  - pi never refreshes an env-var key.
- **Still unverified (needs a real OpenShell):**
  - the gateway refresh with a real refresh token, and rotation stored across restarts;
  - the real proxy's TLS interception with Node (it sets `NODE_EXTRA_CA_CERTS`);
  - streaming through its L7 proxy;
  - Codex (ChatGPT OAuth plus account header);
  - the pi-web worker as a sandbox workload: disk, exposed port, wake/sleep, front end to worker auth;
  - k3s install (Agent Sandbox CRDs, NetworkPolicy enforcement).
- Fallback without OpenShell: the trusted front end holds the refresh token and hands workers short-lived access tokens.
  The agent can read the access token but never the refresh token.

## Phase 3: cluster caches
See [cluster-caches.md](cluster-caches.md). Not scheduled.

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
6. Branch protection on `main`: rulesets plus CODEOWNERS (2026-11-07, see Phase 1 status).
7. **Images (2026-11-07):** `pi-local-sandbox`, `pi-web-worker`, `pi-web`, all Fedora, one per use (see Images).
8. **Admin on the host, agents in roles (2026-11-10):** interactive sessions are admin and unsandboxed; unattended
   agents run as sandboxed roles; OpenShell is for agent runs on web only (see the decision at the top).
