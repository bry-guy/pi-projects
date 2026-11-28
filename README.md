# pi-projects

Projects for pi: persistent workspaces of sessions, repos, memory and artifacts, as a plain pi extension.

## Install

```sh
pi install npm:@bry-guy/pi-projects
# or from git:
pi install git:github.com/bry-guy/pi-projects
# or a local checkout:
pi install /path/to/pi-projects   # or: pi -e /path/to/pi-projects
```

## Use

- `/project`: pick a project and a session, or create a project.
  With pi-sync installed, the session list also shows the project's conversations that are on the sync server but
  not on this machine (made on another machine or in pi-web), marked `(on <device>)`; picking one opens it here as
  `/sync open` does. If the server does not answer within 2 seconds, the list shows this machine's sessions only.
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

Interactive sessions run on the host as you (admin). Unattended agents run as roles, always sandboxed, with only the
role's credentials. `/project sandbox on` sandboxes a project's interactive sessions too; it is off by default.

- A role is `<repo>/.pi/roles/<role>.json` (egress hosts, secrets with the hosts they're for, broker actions, extra host
  tools), read from origin's default branch only, so it changes by a merge.
- Grants are `~/.pi/agent/pi-roles.json`, signed with your SSH key (1Password agent, Touch ID). The trust anchor is
  `~/.local/state/pi-roles/allowed_signers`, set up on first use. Unsigned or tampered grants count as none, and a
  tampered file puts sessions in the sandbox. Once the trust anchor exists, an unsigned file with grants counts as
  tampered. Either state shows a warning at session start; `/project sign` recovers.
- `/project roles`: grants, signature, missing secret sources. `/project grant <repo>/<role> [--default]`,
  `/project ungrant <repo>/<role>`, `/project source <repo>/<role> <NAME> <source>`, `/project sandbox on|off`,
  `/project sign` (review and sign the file as it is). Each change signs once (one Touch ID).
- `role_agent(role, task, cwd?, background?, session?)`: a fresh session as a granted role, sandboxed with that role's
  credentials (pi-background runs it). The call waits and returns the run's final reply; Esc stops the run (with a
  pi-background that has `stop()`). With `background: true`, or once the run asks the user something or passes 15
  minutes, the reply comes back to the calling session as a message instead. Role runs can't change grants.
  With `session` (the session file an earlier call's result named), `task` is sent as the next message in that run's
  session instead: same role, sandbox, credentials and folder, and every check a new run gets. It is refused unless
  the calling session itself started that run as this role in this project (it keeps a `role-run` entry for each run
  it starts; nothing the run's own session says counts), and while the run is still running. Needs a pi-background
  that has `send()`.
  While it waits, the call's progress reads `<role>: <activity> · 6m 20s`, where `<activity>` is what the run's record says it
  is doing now (`running <tool>`; with an older pi-background, the run's newest
  [pi-summarize](https://github.com/bry-guy/pi-summarize) activity line), else `starting` / `running`. A run whose
  record is missing counts as died once its process is gone, or once it has had no record for 15 minutes.
  A host that sets `globalThis[Symbol.for("pi-role-runner.v1")] = { run(o) }` runs the role itself, in its own
  sandbox, in place of pi-background (pi-web's workers do; `HostRunner` in `src/role-runs.ts`). The checks before the
  run are the same, and the host's refusal is the tool's error.
  Role runs are not synced by pi-sync (unless you continue one yourself with `/bg` or `/resume`) and are
  hidden from the `/project` session list unless you pick `Show role runs (N)`, the second row.
- Unsandboxed sessions with signed grants see the granted roles in the system prompt, with a nudge to use
  `role_agent` for work that fits one.
- Host git run by pi-projects never runs repo hooks or fsmonitor (agents can write `.git`).

## Test

```sh
npm test
```
