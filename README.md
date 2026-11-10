# pi-projects

Projects for pi: persistent workspaces of sessions, repos, memory and artifacts, as a plain pi extension.

## Install

```sh
pi install /path/to/pi-projects   # or: pi -e /path/to/pi-projects
```

## Use

- `/project`: pick a project and a session, or create a project.
- `/project new|name|memory|repos|share|archive|restore|delete|list|doctor`
- Tools for the agent: `project_clone`, `project_worktree`, `project_remember`.

Projects live in `$PI_PROJECTS_DIR`, which defaults to `~/.pi/agent/pi-projects/<name>/`. Each one holds `project.json`, `memory.md`, `repos/`, `worktrees/` and `artifacts/`.

`project.json` lists the project's repos (`repos: [{name, url, branch}]`). `project_clone` adds to it, `/project repos remove <name>` removes one, and a session that opens a project clones any listed repo missing on this machine.

Sync projects across machines with `/project share <git-remote>` (once per machine, one private repo for all projects). It makes `$PI_PROJECTS_DIR` a git repo tracking only `project.json` and `memory.md` (`repos/`, `worktrees/` and `artifacts/` are ignored; memory merges line by line). pi-projects commits and pushes after every project change and pulls when a session starts. Each session records `{projectId, name, rel}` in a `pi-project` custom entry, so pi-sync can reopen it in the same project folder on another machine.

See [docs/plan.md](docs/plan.md) for the phases and which are implemented.

## Roles and sandboxing (Mac)

Design: [docs/agent-roles.md](docs/agent-roles.md). Needs [pi-mounts](https://github.com/bry-guy/pi-mounts) (Gondolin
sandbox), [pi-secret-broker](https://github.com/bry-guy/pi-secret-broker) (secrets, host actions) and
[pi-background](https://github.com/bry-guy/pi-background) (role runs).

- A role is `<repo>/.pi/roles/<role>.json` (egress hosts, secrets with the hosts they're for, broker actions, extra host
  tools), read from origin's default branch only, so it changes by a merge.
- Grants are `~/.pi/agent/pi-roles.json`, signed with your SSH key (1Password agent, Touch ID). The trust anchor is
  `~/.local/state/pi-roles/allowed_signers`, set up on first use. Unsigned or tampered grants count as none, and a
  tampered file puts sessions in the sandbox.
- `/project roles`: grants, signature, missing secret sources. `/project grant <repo>/<role> [--default]`,
  `/project ungrant <repo>/<role>`, `/project source <repo>/<role> <NAME> <source>`, `/project sandbox on|off`,
  `/project sign` (review and sign the file as it is). Each change signs once (one Touch ID).
- `role_agent(role, task, cwd?)`: a fresh background session as a granted role, sandboxed, whose final reply comes
  back to the caller as a message. Role runs can't change grants.
- Host git run by pi-projects never runs repo hooks or fsmonitor (agents can write `.git`).

## Test

```sh
npm test
```
