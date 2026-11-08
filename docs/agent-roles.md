# Agent roles and sandboxed projects

Status: Phase 1 (Mac) built; this doc describes the current design (updated 2026-11-07). Build status, checks and
next phases: [agent-roles-plan.md](agent-roles-plan.md).

## Problem

- **Agents can't do enough.** A project's agent lacks the credentials and network access for routine work, so it stops and asks.
- **Approvals are too frequent.** Work that Bryan has already decided is fine should run without a prompt.
- **Blast radius should stay small.** Each credential should be usable only by the role that needs it, and the agent must not be able to widen its own access.

## Model

- **Repos define roles.** Repos are permanent, so a role lives with its repo in `.pi/roles/<role>.json`. A role lists egress hosts, secret names (not values) and broker actions.
- **Projects grant roles.** A project is a short-lived grouping of repos for a goal. Its signed grant lists which repo roles its agents may take on.
- **One role per session.** Roles don't compose. The project agent (the one you talk to) runs as the grant's default role, which can be any granted role. With no default it runs sandboxed with no grants: a VM or pod with no role secrets and no role egress. To do another role's work it starts an agent as that role, with the task. That agent has its own VM or pod, egress and secrets, and reports back as text.
- **No prompts for granted work.** Granting a role to a project is the decision. Anything the role allows runs without asking.
- **Admin work is out of scope for now.** Agents propose admin commands and Bryan runs them.

## Where things live

| What | Where | Changed by |
|---|---|---|
| Role definition (egress, secret names, broker actions) | `<repo>/.pi/roles/<role>.json` | a merge to the repo's `main` |
| Grant (which repo roles a project may use, default role, sandbox on/off) | `~/.pi/agent/pi-roles.json`, signed with `ssh-keygen -Y` and checked against an allowed-signers file outside dotfiles | Bryan (`/project grant`, `/project sign`) |
| Secret sources (`GH_TOKEN` → `op://…` or a k8s Secret) | global pi config, keyed by repo role, e.g. `infra/infra-developer` | Bryan |
| Shared pieces (the `tooling` host group, default image) | global pi config | Bryan |
| Pod grants | the pi-workspaced gateway's grants | a PR to infra |

Repo `AGENTS.md` `## Roles` sections stay as human documentation, not enforcement.

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

- **Tool:** pi-projects adds `role_agent(role, task, cwd?)`. It asks the runner to start a separate `pi` as that role, with its own VM or pod, and later reports the result as text. The tool only asks; the runner supervises (see Role agent runs). The role definition comes from `repos/<repo>/.pi/roles/` and the grant from the signed grants file, never from `cwd`. `cwd` changes which code the agent works on, not what it may do.
- **Prompt:** at session start pi-projects injects the granted roles, e.g. "You may dispatch infra/infra-operator and infra/infra-developer with `role_agent` for work that needs their access. Use subagents for reading and exploring."
- **Errors name the role:** a blocked host or missing secret says which granted role has it, e.g. "api.cloudflare.com is not allowed for this role; infra/infra-developer has it, use role_agent."
- **A new session, not a fork.** A role agent starts as a fresh session in the project with just the task. It appears in the project's session history and can be opened, continued or taken over. Forking the calling session (`pi --fork`) to pass context is a later option.
- **In pi-web:** roles map to workers. A role worker is a pi-workspaced worker whose grant carries that role's credentials and egress, as `ws-infra` does for infra today. `role_agent` asks the gateway to start the session in the role's worker. Whether it then shows up in the web UI depends on how pi-web lists project sessions across workers (pi-sync). Unverified.
- **Subagents stay** for same-role work. `@gotgenes/pi-subagents` runs children in the parent's process and can only change their working directory, so they can't switch roles or do more than their parent.

## Role agent runs

`role_agent` hands the run to a **runner** outside the calling session, so a run survives the caller closing. A new
session appears in the project, and the result is reported back to the caller.

| | Mac | pi-web (Phase 2) |
|---|---|---|
| Runs as | pi-background's runner: a child `pi --mode rpc` plus a Gondolin VM (`pi-local-sandbox` image) | a role worker `ws-<project>--<role>` (`pi-web-worker` image), a workspaced worker whose grant carries the role's credentials and egress; it sleeps when idle |
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

No home-grown egress proxy. Phase 2 spikes OpenShell on k3s, which enforces hostname egress and injects credentials as
placeholders, as Gondolin does on the Mac. Without it, worker pods keep today's NetworkPolicy (no cluster or LAN
addresses, open internet).

## Rules

- **Grants are the gate, never environment variables.** Signed grants decide what a session may do; unsetting
  `PI_ROLE`, `PI_SESSION_ID` or similar must never unlock more access.
- **Role definitions are read from origin's default branch**, so a role can only widen through a reviewed merge.

## Hosting for others

The core is standard: role files, signed grants, pi-sync, workspaced workers. Bryan's setup adds plug-ins: 1Password
as a secret source, Gondolin on the Mac, GitHub Apps per role and infra's roles. Self-hosters start from
`pi-web-worker` and build their own image `FROM` it.

## First step

List what each project agent keeps failing at, add that access to the matching repo role once, and have the project agent start that role instead of asking.
