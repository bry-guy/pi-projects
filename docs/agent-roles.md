# Agent roles and sandboxed projects

Status: Phase 1 (Mac) built; this doc describes the current design (updated 2026-11-10: interactive sessions are
admin on the host, unattended agents run as roles). Build status, checks and
next phases: [agent-roles-plan.md](agent-roles-plan.md).

## Problem

- **Agents can't do enough.** A project's agent lacks the credentials and network access for routine work, so it stops and asks.
- **Approvals are too frequent.** Work that Bryan has already decided is fine should run without a prompt.
- **Blast radius should stay small.** Each credential should be usable only by the role that needs it, and the agent must not be able to widen its own access.

## Model

- **Repos define roles.** Repos are permanent, so a role lives with its repo in `.pi/roles/<role>.json`. A role lists egress hosts, secret names (not values) and broker actions.
- **Projects grant roles.** A project is a short-lived grouping of repos for a goal. Its signed grant lists which repo roles its agents may take on.
- **Interactive sessions are admin on the host.** Bryan starts every session as himself, unsandboxed, with his own credentials. `/project sandbox on` stays as a per-project option for code you don't trust; it is off by default and not a goal to turn on. A sandboxed interactive session runs as the grant's default role (or with no role secrets and no role egress if there is none).
- **Unattended agents run as roles.** One role per run; roles don't compose. A role run is always sandboxed (`PI_ROLE` forces it) and holds only that role's credentials. To do a role's work, the admin session starts a role run with the task; it has its own VM or pod, egress and secrets, and reports back as text.
- **No prompts for granted work.** Granting a role to a project is the decision. Anything the role allows runs without asking.
- **New role actions come from admin work.** Roles aren't designed up front. The `role-survey` skill looks at what admin sessions did repeatedly and proposes role changes as PRs to `.pi/roles`, which wait for Bryan's review.

## Where things live

| What | Where | Changed by |
|---|---|---|
| Role definition (egress, secret names, broker actions) | `<repo>/.pi/roles/<role>.json` | a merge to the repo's `main` |
| Grant (which repo roles a project may use, default role, sandbox on/off, off by default) | `~/.pi/agent/pi-roles.json`, signed with `ssh-keygen -Y` and checked against an allowed-signers file outside dotfiles | Bryan (`/project grant`, `/project sign`) |
| Secret sources (`GH_TOKEN` → `op://…` or a k8s Secret) | global pi config, keyed by repo role, e.g. `infra/infra-developer` | Bryan |
| Shared pieces (the `tooling` host group, default image) | global pi config | Bryan |
| Pod grants | the pi-workspaced gateway's grants | a PR to infra |

Repo `AGENTS.md` `## Roles` sections stay as human documentation, not enforcement.

## Admin sessions and role runs

Built on the Mac (2026-11-10).

- **Who runs where.** Interactive sessions: Bryan, on the host, unsandboxed. Role runs: a separate `pi` process in a
  Gondolin VM, with only the role's egress, secret placeholders and broker actions. On web, interactive sessions run
  in the project's worker pod as today; agent runs move to OpenShell in Phase 2.
- **Handing work to a role.** An unsandboxed project session with signed grants lists the granted roles in its system
  prompt and is told to prefer `role_agent` for work that fits one, and to do the work itself when it needs access no
  role has. `role_agent` waits for the run and returns its final reply as the tool result; Esc stops the run. With
  `background: true` it returns at once and the reply arrives later as a message. A waiting call also turns into that
  when the run starts waiting on Bryan or passes 15 minutes.
- **Subagents inherit their parent.** The `subagent` tool runs children in the parent's process with the parent's
  extensions: in an admin session they are admin, in a role run they are sandboxed as that role (11-probe comparison,
  2026-11-10). A subagent can't switch roles.
- **Why not a role as a subagent type.** `@gotgenes/pi-subagents` drops unknown agent frontmatter, has no hook around
  child creation, and the sandbox extension sees a child's agent type only as text in its system prompt. A missed
  match would run the child as admin on the host without any error. The separate-process role run is the tested
  boundary, so the fix was making `role_agent` wait (foreground) instead.
- **Redaction.** pi-secret-broker replaces secret values with `[redacted:<kind>]` in tool output, `!command` output and
  every model request, in every session, admin or role. It is best effort, not a boundary: commands still get the
  secrets, and encoded or split values get through. Details: [pi-secret-broker README, Redaction](https://github.com/bry-guy/pi-secret-broker#redaction).

## Sketch

Built as JSON (no YAML dependency). Real examples: pi-web `.pi/roles/pi-web-developer.json` and infra
`.pi/roles/infra-developer.json` (generated from infra's task classification).

```json
{ "egress": ["api.cloudflare.com"],
  "secrets": { "GH_TOKEN": { "hosts": ["github.com", "api.github.com"] } },
  "broker": { "push": { "run": ["sh", "-c", "git push … HEAD:refs/heads/$0", "{branch}"], "args": { "branch": "agent/[a-z0-9./-]+" } } } }
```

Grants and mounts don't live in `project.json` (agents can edit it): grants are in the signed
`~/.pi/agent/pi-roles.json`, and mounts are fixed by pi-mounts.

## Boundaries

What actually limits an agent:

- **Per-role VMs.** A role agent gets only its role's egress and secrets.
- **Grants are out of reach.** `project.json` and global pi config are never mounted.
- **Role files are out of reach.** The VM never sees `.pi/`; pi-mounts hides it in every mount, for reads and writes. The host reads roles from `repos/<repo>/.pi/roles/`.
- **Agent GitHub access is per repo.** Agents can push only to the repos they work on, never to the pi-projects share repo or dotfiles, where grants and config sync from.

What these don't cover, on purpose:

- **`main` is not a reviewed gate today.** Agents can merge with Bryan's `gh` login, and merges aren't reviewed. A role change that lands on `main` takes effect. A separate agent GitHub identity and a review agent can tighten this later.
- **Running agent code on the host is trusted.** Running `mise run check` in an agent's worktree, or git hooks in a repo agents can write to, runs agent-written code as Bryan. That's accepted.

## Mounts

| Path | In the VM | Why |
|---|---|---|
| `repos/<repo>/` files | read-only | enforces the workflow rule: the main checkout stays on `main`, branch work goes in worktrees |
| `repos/<repo>/.git` | read-write | `git worktree add` and worktree commits write here |
| `worktrees/` | read-write | where changes happen |
| `.pi/`, `.envrc`, `fnox.local.toml`, `.env*` | hidden | role files and local secrets |
| `project.json`, global config | not mounted | grants |

Agents use normal `git worktree add` from `repos/<repo>`, so existing worktree tooling keeps working.

## Pieces

- **pi-projects:** owns `repos` in `project.json`, roles and signed grants, and starts role agents.
- **pi-mounts** (new): the mounts. Uses Gondolin `RealFSProvider` and `ReadonlyProvider`, plus a filter provider for hidden paths. Nothing from pi-chat is reused.
- **Sandbox:** one Gondolin VM per project and role (shared by its sessions), with the Fedora `pi-local-sandbox` image and a per-role mise tool cache, so one role can't swap a binary another role runs.
- **pi-secret-broker:** host-side `broker_run` actions (fixed argv) for credentials that can't be placeholders, such as kubectl and tofu.
- **Pods:** the gateway holds pod grants. Pods don't run agents in a VM yet, so pod enforcement waits on that.

## Dispatching role agents

- **Tool:** pi-projects adds `role_agent(role, task, cwd?, background?)`. It asks the runner to start a separate `pi` as that role, with its own VM or pod, waits, and returns the run's reply as text (`background: true`, a run waiting on Bryan, or one past 15 minutes report later as a message). The tool only asks; the runner supervises (see Role agent runs). The role definition comes from `repos/<repo>/.pi/roles/` and the grant from the signed grants file, never from `cwd`. `cwd` changes which code the agent works on, not what it may do. With `session` (what an earlier call's result named: the session file on the Mac, the run id on pi-web) the task is sent to that run's session as its next message, under the same role, sandbox and credentials; the caller's own record of the runs it started (Mac) or web's record of the run and of the worker that holds it (pi-web) decides whether it is this role's run in this project, and a run still running is refused.
- **Prompt:** at session start an unsandboxed session with signed grants lists the granted roles with their descriptions, then "Prefer role_agent for work that fits one of these roles: it runs sandboxed with only that role's credentials. Do the work yourself when it needs access no role has." A role run sees the other granted roles it can delegate to.
- **Errors name the role:** a blocked host or missing secret says which granted role has it, e.g. "api.cloudflare.com is not allowed for this role; infra/infra-developer has it, use role_agent."
- **A new session, not a fork.** A role agent starts as a fresh session in the project with just the task. It appears in the project's session history and can be opened, continued or taken over. Forking the calling session (`pi --fork`) to pass context is a later option.
- **In pi-web:** roles map to workers. A role worker is a pi-workspaced worker whose grant carries that role's credentials and egress, as `ws-infra` does for infra today. `role_agent` takes its runner from the host when the host offers one (`Symbol.for("pi-role-runner.v1")`, `HostRunner` in `src/role-runs.ts`): a pi-web worker asks web to start a hidden run in the role's worker and gets the final reply back. The signed-grant and role-file checks run in the calling session as on the Mac; pi-web checks its own grant for the project again and is the authority there. pi-web shows no role today; showing it comes with web roles.
- **Subagents stay** for same-role work. They inherit the parent's role or admin access and can't switch roles (see Admin sessions and role runs).

## Role agent runs

`role_agent` hands the run to a **runner** outside the calling session, so a run survives the caller closing. A new
session appears in the project, and the reply is returned to the caller (or sent to it as a message for background runs).

| | Mac | pi-web (Phase 2) |
|---|---|---|
| Runs as | pi-background's runner: a child `pi --mode rpc` plus a Gondolin VM (`pi-local-sandbox` image) | a role worker `ws-<project>-<grant>` (`pi-web-worker` image), a workspaced worker whose grant carries the role's credentials and egress; it sleeps when idle |
| Storage | the project's worktrees | the worker's disk |
| Tools | the image plus a per-role mise cache | the image |

- **Blocked runs wait.** A run that needs Bryan forwards the dialog (`ask_user_question`, confirms) to any open pi:
  the footer shows "waiting on you" and bare `/bg` answers it. It waits indefinitely, with keep-awake released.
- **Getting changes out.** Each role has its own GitHub App. Agents push `feature/<name>` or `agent/<name>`, open a PR
  and `gh pr merge --auto --squash`; rulesets require CI, and CODEOWNERS makes `.pi/` and `.github/` wait for Bryan.
- **Stalls.** The runner writes a heartbeat on every pi event and every 30 s while a tool runs (up to 2 hours per tool).
  On the Mac a per-run monit check stops a run whose heartbeat is 10 minutes stale and records it as `stalled`. pi
  retries model calls itself.
- **Continue.** After a blocker is fixed, a new run resumes from the same session and branch.

On the Mac a sleeping laptop can pause a run; pi-keepalive helps.

## Startup speed

- **Now:** bake common tools into the images, so they never install at run time.
- **Later:** shared read-only caches for git, mise tools and language packages. See [cluster-caches.md](cluster-caches.md).

## Images

Fedora (glibc) images, one per use: `pi-local-sandbox` (tools only, the Gondolin VM's root filesystem on the Mac),
`pi-web-worker` (tools plus Node, pi and the worker server; the self-hoster default) and `pi-web` (the app). Not
Alpine: musl breaks prebuilt tools. Details in [agent-roles-plan.md](agent-roles-plan.md#images-decided-2026-11-07).

## Egress on web

No home-grown egress proxy. Phase 2 uses OpenShell on k3s for agent and role runs on web workers only: it enforces
hostname egress and injects credentials as placeholders, as Gondolin does on the Mac. Interactive web sessions keep
today's model: the worker pod is the boundary, with today's NetworkPolicy (no cluster or LAN addresses, open internet).

## Rules

- **Grants are the gate, never environment variables.** Signed grants decide what a session may do; unsetting
  `PI_ROLE`, `PI_SESSION_ID` or similar must never unlock more access.
- **Role definitions are read from origin's default branch**, so a role can only widen through a reviewed merge.

## Hosting for others

The core is standard: role files, signed grants, pi-sync, workspaced workers. Bryan's setup adds plug-ins: 1Password
as a secret source, Gondolin on the Mac, GitHub Apps per role and infra's roles. Self-hosters start from
`pi-web-worker` and build their own image `FROM` it.

## First step

Run the `role-survey` skill: it lists what admin sessions keep doing by hand and proposes the matching role actions as
PRs, so the next time an admin session can hand that work to a role.
