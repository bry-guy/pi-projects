# Agent roles and sandboxed projects

Status: design, not built. Replaces the earlier ideas of role files read from `main` with approval hashes, and of role definitions kept in dotfiles or `project.json`.

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
| Role definition (egress, secret names, broker actions) | `<repo>/.pi/roles/<role>.yaml` on `main` | a commit to the repo's `main`, by Bryan or a PR he merges |
| Grant (which repo roles a project may use) | `project.json` | Bryan |
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
  "mounts": { "repos": "ro", "worktrees": "rw", "hide": [".pi", ".envrc", "fnox.local.toml", ".env*", "node_modules"] },
  "roles":  ["infra/infra-operator", "infra/infra-developer"]
}
```

## Keeping the agent from editing its own role

- **The VM never sees `.pi/`.** pi-mounts hides it in every mount, read-only and read-write, for reads and writes.
- **The host reads roles from the main checkout** (`repos/<repo>/.pi/roles/`), which is mounted read-only.
- **`project.json` and global config are never mounted.** Only `repos/` (read-only) and `worktrees/` (read-write) are.
- **A role changes only when `main` changes** and the host pulls.

## Pieces

- **pi-projects:** `project.json` gains plugin sections. Each top-level key belongs to the extension that validates and applies it, as pi-ez-chat-workspace did. pi-projects owns `repos` and `roles`, and starts role agents.
- **pi-mounts** (new, reworked from pi-ez-chat-mount): owns the `mounts` section. Uses Gondolin `RealFSProvider` and `ReadonlyProvider`, plus a filter provider for hidden paths. Nothing from pi-chat is reused.
- **Sandbox:** one Gondolin VM per session, with a Fedora `pi-worker` image and a per-role mise tool cache, so one role can't swap a binary another role runs.
- **Broker** (later, from pi-ez-secret-broker): host-side actions for non-HTTP credentials, such as S3 signing, read-only Postgres and tofu.
- **Pods:** the gateway holds pod grants. Pods don't run agents in a VM yet, so pod enforcement waits on that.

## Open checks

1. **Worktree git data lives in the main repo** (`repos/<repo>/.git/worktrees/…`). If `repos/` is fully read-only, `git commit` in a worktree fails. `.git` likely has to stay writable while the checkout files are read-only. Test this.
2. **Hidden paths must block writes,** not just reads, so the agent can't create `.pi/roles/x.yaml` in a worktree. Test this.
3. **Gondolin read-only mounts** were "best-effort" per pi-ez-chat-mount's notes. Confirm that a write, a delete and a `git commit` fail.
4. **Can pi subagents run in their own VM?** If not, role agents are new pi sessions.
5. **Known gap:** the agent uses Bryan's `gh` login, so it could merge its own PR that changes a role. A separate agent GitHub identity closes this later.

## First step

List what each project agent keeps failing at, add that access to the matching repo role once, and have the project agent start that role instead of asking.
