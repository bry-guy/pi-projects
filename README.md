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

See [docs/plan.md](docs/plan.md). Phase 1 (local projects) is implemented.

## Test

```sh
npm test
```
