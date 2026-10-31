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
  "mounts": { "repos": "ro", "worktrees": "rw", "hide": [".pi", ".envrc", "fnox.local.toml", ".env*", "node_modules"] },
  "roles":  ["infra/infra-operator", "infra/infra-developer"]
}
```

## Keeping the agent from editing its own role

- **The VM never sees `.pi/`.** pi-mounts hides it in every mount, read-only and read-write, for reads and writes.
- **The host reads roles from the main checkout** (`repos/<repo>/.pi/roles/`), which is mounted read-only.
- **`project.json` and global config are never mounted.** Only `repos/` (read-only), `agent/` and `worktrees/` (read-write) are.
- **A role changes only when `main` changes** and the host pulls.
- **Agents get their own repo to make worktrees from.** A `git worktree` writes refs and objects into its repo's `.git`. Made from Bryan's `repos/<repo>`, that would let the agent move `main`, plant hooks or overwrite objects `main` uses. Instead each repo gets an agent copy, `agent/<repo>.git`: a bare `git clone --shared` of `repos/<repo>` that borrows history read-only through `objects/info/alternates`. Agents run normal `git worktree add` against it, so worktree tooling and habits keep working, and `repos/` stays fully read-only. The host fetches the agent copy's `main` from `repos/<repo>` at session start. Tested on Linux: worktree add and commit work with `repos/<repo>` fully read-only; creating it takes about the same time as a worktree (22 ms on pi-web).
- **The host never runs repo code from `worktrees/`.** No host pi, `mise`, `direnv` or git hooks with a worktree as the working directory. Role agents start on the host with their tools in a VM.
- **The repo that stores grants must not be pushable by agent credentials.** pi-projects syncs `project.json` through a git repo, and every machine pulls it at session start. If an agent's GitHub credential could push there, it could widen its own grants. The same applies to dotfiles if grants live there. Per-repo deploy keys or a separate agent GitHub identity close this.

## Pieces

- **pi-projects:** `project.json` gains plugin sections. Each top-level key belongs to the extension that validates and applies it, as pi-ez-chat-workspace did. pi-projects owns `repos` and `roles`, and starts role agents.
- **pi-mounts** (new, reworked from pi-ez-chat-mount): owns the `mounts` section. Uses Gondolin `RealFSProvider` and `ReadonlyProvider`, plus a filter provider for hidden paths. Nothing from pi-chat is reused.
- **Sandbox:** one Gondolin VM per session, with a Fedora `pi-worker` image and a per-role mise tool cache, so one role can't swap a binary another role runs.
- **Broker** (later, from pi-ez-secret-broker): host-side actions for non-HTTP credentials, such as S3 signing, read-only Postgres and tofu.
- **Pods:** the gateway holds pod grants. Pods don't run agents in a VM yet, so pod enforcement waits on that.

## Dispatching role agents

- **Tool:** pi-projects adds `role_agent(role, task)`. It starts a separate `pi` process as that role, with its own VM, and returns the result as text.
- **Prompt:** at session start pi-projects injects the granted roles, e.g. "You may dispatch infra/infra-operator and infra/infra-developer with `role_agent` for work that needs their access. Use subagents for reading and exploring."
- **Errors name the role:** a blocked host or missing secret says which granted role has it, e.g. "api.cloudflare.com is not allowed for this role; infra/infra-developer has it, use role_agent."
- **Subagents stay** for same-role work. They can't do more than their parent.

## Open checks

1. **Worktree git data.** Resolved by design: worktrees come from the agent copy (see above). Tested on Linux without a VM. Rejected alternative: per-path write rules on Bryan's `.git` (hooks, config, `refs/heads/main`, never replace existing objects). Possible, but several rules where one mistake reopens a hole. A host `git gc` on `repos/` could in theory drop objects a clone relies on; `git repack -a -d` in the clone (or `--dissociate`) removes the dependency if that matters.
2. **Hidden paths block writes.** pi-ez-chat-mount's filter is a proxy over every provider method. It rejects any call whose path argument (both paths for `rename`, `copy`, `link`, `symlink`) contains the hidden name, and filters directory listings. Swapping `node_modules` for a configurable list covers `.pi`. Code-read only, not run in a VM. An agent could still add `.pi/roles/x.yaml` to a commit with git plumbing; that only matters if it reaches `main`, which needs Bryan's merge.
3. **Gondolin read-only mounts.** `ReadonlyProvider` (`host/src/vfs/readonly.ts`, v0.14.0) returns `EROFS` for write opens, `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `chmod` and `symlink`, and Gondolin's `docs/security.md` recommends it for host directories. Code-read only. Still test in a VM on the Mac that write, delete, rename and `git commit` fail.
4. **Subagents.** `@gotgenes/pi-subagents` runs children in the parent's process (`createAgentSession`), with a `WorkspaceProvider` hook that only sets the child's working directory. It has no per-child sandbox. Role agents should be separate `pi` processes started on the host with a role and their own VM. A `pi` started inside a VM is not an escape: it has only that VM's access.
5. **Self-merge gap:** the agent uses Bryan's `gh` login, so it could merge its own PR that changes a role. A separate agent GitHub identity closes this later.
6. **Host pi loading worktree config.** If a host pi ever runs with a worktree as its working directory, it may load that worktree's `.pi/` extensions and settings on the host. Check how pi discovers project extensions and whether a role agent can start without them.

## First step

List what each project agent keeps failing at, add that access to the matching repo role once, and have the project agent start that role instead of asking.
