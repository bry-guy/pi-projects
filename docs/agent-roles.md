# Agent roles and sandboxed projects

Status: design, not built.

## Problem

- **Agents can't do enough.** A project's agent lacks the credentials and network access for routine work, so it stops and asks.
- **Approvals are too frequent.** Work that Bryan has already decided is fine should run without a prompt.
- **Blast radius should stay small.** Each credential should be usable only by the role that needs it, and the agent must not be able to widen its own access.

## Model

- **Repos define roles.** Repos are permanent, so a role lives with its repo in `.pi/roles/<role>.yaml`. A role lists egress hosts, secret names (not values) and broker actions.
- **Projects grant roles.** A project is a short-lived grouping of repos for a goal. Its `project.json` lists which repo roles its agents may take on.
- **One role per session.** Roles don't compose. The project agent (the one you talk to) has few or no credentials. To do role work it starts an agent as that role, with the task. That agent has its own VM, egress and secrets, and reports back as text.
- **No prompts for granted work.** Granting a role to a project is the decision. Anything the role allows runs without asking.
- **Admin work is out of scope for now.** Agents propose admin commands and Bryan runs them.

## Where things live

| What | Where | Changed by |
|---|---|---|
| Role definition (egress, secret names, broker actions) | `<repo>/.pi/roles/<role>.yaml` | a merge to the repo's `main` |
| Grant (which repo roles a project may use) | `project.json` (never mounted) | Bryan |
| Secret sources (`GH_TOKEN` → `op://…` or a k8s Secret) | global pi config, keyed by repo role, e.g. `infra/infra-developer` | Bryan |
| Shared pieces (the `tooling` host group, default image) | global pi config | Bryan |
| Pod grants | the pi-workspaced gateway's grants | a PR to infra |

Repo `AGENTS.md` `## Roles` sections stay as human documentation, not enforcement.

## Sketch

```yaml
# infra/.pi/roles/infra-developer.yaml
egress:  [tooling, api.github.com, k3s:6443]
secrets: { GH_TOKEN: { hosts: [api.github.com, github.com] } }
broker:  { tofu: { plan: auto } }
```

```json
// project.json
{
  "repos":  [{ "name": "infra", "url": "…", "branch": "main" }],
  "mounts": { "repos": "ro-files", "worktrees": "rw", "hide": [".pi", ".envrc", "fnox.local.toml", ".env*", "node_modules"] },
  "roles":  ["infra/infra-operator", "infra/infra-developer"]
}
```

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

- **pi-projects:** `project.json` gains plugin sections. Each top-level key belongs to the extension that validates and applies it, as pi-ez-chat-workspace did. pi-projects owns `repos` and `roles`, and starts role agents.
- **pi-mounts** (new, reworked from pi-ez-chat-mount): owns the `mounts` section. Uses Gondolin `RealFSProvider` and `ReadonlyProvider`, plus a filter provider for hidden paths. Nothing from pi-chat is reused.
- **Sandbox:** one Gondolin VM per session, with a Fedora `pi-worker` image and a per-role mise tool cache, so one role can't swap a binary another role runs.
- **Broker** (later, from pi-ez-secret-broker): host-side actions for non-HTTP credentials, such as S3 signing, read-only Postgres and tofu.
- **Pods:** the gateway holds pod grants. Pods don't run agents in a VM yet, so pod enforcement waits on that.

## Dispatching role agents

- **Tool:** pi-projects adds `role_agent(role, task, cwd?)`. It starts a separate `pi` process as that role, with its own VM, and returns the result as text. The role definition comes from `repos/<repo>/.pi/roles/` and the grant from `project.json`, never from `cwd`. `cwd` changes which code the agent works on, not what it may do.
- **Prompt:** at session start pi-projects injects the granted roles, e.g. "You may dispatch infra/infra-operator and infra/infra-developer with `role_agent` for work that needs their access. Use subagents for reading and exploring."
- **Errors name the role:** a blocked host or missing secret says which granted role has it, e.g. "api.cloudflare.com is not allowed for this role; infra/infra-developer has it, use role_agent."
- **Fork for context:** a role agent can start as a fork of the calling session (`pi --fork <session> --session-id <new>`), so it has the conversation so far instead of a bare task. The result is a real session file in the project, so it appears in session lists and can be opened, continued or taken over.
- **In pi-web:** roles map to workers. A role worker is a pi-workspaced worker whose grant carries that role's credentials and egress, as `ws-infra` does for infra today. `role_agent` asks the gateway to start the forked session in the role's worker. Whether it then shows up in the web UI depends on how pi-web lists project sessions across workers (pi-sync). Unverified.
- **Subagents stay** for same-role work. `@gotgenes/pi-subagents` runs children in the parent's process and can only change their working directory, so they can't switch roles or do more than their parent.

## Open checks

1. **Read-only files with a writable `.git`.** Mount `repos/<repo>/` read-only with `.git` mounted read-write on top. Test in a VM on the Mac that editing or checking out in `repos/` fails while `git worktree add` and commits in the worktree work.
2. **Hidden paths block writes.** pi-ez-chat-mount's filter rejects any file operation whose path contains the hidden name and filters directory listings. Swapping `node_modules` for a configurable list covers `.pi`. Code-read only; test in a VM.
3. **Gondolin read-only mounts.** `ReadonlyProvider` (`host/src/vfs/readonly.ts`, v0.14.0) returns `EROFS` for write opens, `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `chmod` and `symlink`. Code-read only; test in a VM.
4. **Role agents as processes.** Confirm a host-started `pi` can take a role and run its tools in its own VM.

## First step

List what each project agent keeps failing at, add that access to the matching repo role once, and have the project agent start that role instead of asking.
