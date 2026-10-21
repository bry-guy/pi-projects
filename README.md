# pi-projects

Projects for pi: persistent workspaces of sessions, repos, memory and artifacts, as a plain pi extension.

## Install

```sh
pi install /path/to/pi-projects   # or: pi -e /path/to/pi-projects
```

## Use

- `/project`: pick a project and a session, or create a project.
- `/project new|open|name|memory|archive|restore|delete|list|doctor`
- Tools for the agent: `project_clone`, `project_worktree`, `project_remember`.

Projects live in `$PI_PROJECTS_DIR`, which defaults to `~/.pi/agent/pi-projects/<name>/`. Each one holds `project.json`, `memory.md`, `repos/`, `worktrees/` and `artifacts/`.

See [docs/plan.md](docs/plan.md). Phase 1 (local projects) is implemented.

## Test

```sh
npm test
```
