# pi-projects plan

A **project** is a persistent workspace: sessions, repos, memory and scratch files that share one trust boundary. Sessions belong to a project, not to a single repo. pi-projects is a normal pi extension. The same package runs on a laptop, in pi-web and on workspaced workers without host-specific code.

## Principles

- **Plain extension.** Use only the public pi extension API (`registerCommand`, `registerTool`, `appendEntry`, `before_agent_start`, `session_start`). There are no host hooks.
- **Configurable root.** The only host knob is `PI_PROJECTS_DIR`, which defaults to `~/.pi/agent/pi-projects`. A workspaced worker installs the package and mounts its project volume at that path. Nothing else changes.
- **Code over prompts.** Structure (where repos and worktrees go) is enforced by tools. Skills cover judgment only.
- **Each record has one owner.**
  - A session records its own project ID with `appendEntry`.
  - The index fields listed below are caches that `doctor` can rebuild.

## Phase 1: local projects (current)

### Layout

```
$PI_PROJECTS_DIR/
  <name>/
    project.json           # id (uuid), name, state, memory{enabled, prompt}, sessions[]
    memory.md
    repos/<repo>/
    worktrees/<repo>/<branch>/
    artifacts/
```

- **Folder name:** a project folder is named after the project's slug, and slugs are unique.
- **ID:** the UUID in `project.json` is the real key. A local project needs no coordination with any other machine.
- **Session list:** `sessions[]` is an index for quick lookup. The authority is the `appendEntry` link inside each session.
- **No root manifest.** Listing projects reads the root folder and each `project.json`, which is cheap at personal scale. Folder names already guarantee unique names, so an index would add nothing.
- **Repo list:** there is none. Repos and worktrees are found by scanning `repos/` and `worktrees/`.

### Commands

| Command | Behavior |
|---|---|
| `/project` | Picker. Open a project (starts a session in the project folder) or create one. Lists that project's sessions. |
| `/project new <name>` | Creates the folder, `project.json` and an empty `memory.md`. |
| `/project name <new>` | Moves the folder. For every session whose `cwd` is inside the project, it moves the session file from `sessions/--<old cwd>--/` to `sessions/--<new cwd>--/` and rewrites the header `cwd` and any fork `parentSession` paths. Leaves no symlinks. |
| `/project memory` | Opens `memory.md` in `$EDITOR`. |
| `/project archive` / `restore` | Archived projects are hidden and read-only, and their sessions stay searchable. |
| `/project delete` | Asks for confirmation, removes the folder and unlinks its sessions, which stay as plain chats. |
| `/project doctor [--fix]` | Reports stray root files, broken worktrees, sessions whose `cwd` is wrong, and index drift. `--fix` only rebuilds indexes. |

### Tools

- **`project_clone <url>`** clones into `repos/<name>`.
- **`project_worktree <repo> <branch>`** creates `worktrees/<repo>/<branch>`.
- **`project_remember <text>`** appends to `memory.md`.

### Context injection

`before_agent_start` receives pi's system prompt and returns it with a project section appended. Pi uses the returned prompt *in place of* its own for that turn, so the handler must append to it, never return a new one. The section contains:

- the project name;
- the layout rules (use the tools; files go in `artifacts/`);
- the repos and worktrees found by scanning;
- `memory.md`.

The section is built when the session starts and is cached in memory, so it is byte-identical every turn. pi-ai puts Anthropic's `cache_control` on the system block, so identical text is served from the prompt cache. The section is rebuilt only after `project_remember`, a clone or a worktree change, and each rebuild costs one cache miss.

This follows pi's guidance (`docs/extensions.md`): change the prompt rather than inject messages. Messages returned from this hook are appended every turn and would pile up in history. A skill is not a substitute: pi shows the agent only a skill's description and loads the body on demand, so memory would not always be in context. Skills are for guidance. Facts the agent always needs go in the prompt.

### Skill

The package ships a skill through its `"pi": {"skills": [...]}` manifest. It explains when to save to memory (durable decisions, conventions, facts about the environment) and when to use a worktree versus the main checkout. Two `memory` settings in `project.json` adjust this:

- **`memory.prompt`** replaces the skill's guidance.
- **`memory.enabled: false`** turns off memory injection and `project_remember`.

### Status line

Shows the current project.

### Out of scope

pi-sync, sandboxing, secrets, memory engines, the pi-web UI and workspaced. Moving a session to another project is also out.

### Verified

- **Resume after rename** works if the session files move along with the header rewrite. Pi finds sessions by a directory derived from `cwd`, both for listing a directory and for `--continue`. `/resume` searches all directories.
- **Prompt caching**, as described under Context injection. This is confirmed from the code, not from a live request.
- **No root manifest**, as described under Layout.

### Open checks

- Repo `AGENTS.md` files load only when the session's working directory is inside that repo. Decide whether the injected section should point to them.

## Phase 2: sandboxing and secrets (Gondolin)

- **Execution:** run project sessions inside a Gondolin micro-VM, with the project folder mounted.
- **Secrets:** a project declares secret references, never values. For example: `{name, source: "keychain:…|fnox:…", hosts: [...]}`.
  - Repo-specific secrets sit on the repo. Infra secrets, such as a homelab prod database, sit at project level.
  - Gondolin swaps placeholders for real values only for allowed hosts, so the agent uses secrets without seeing them.
- **Hard case:** non-HTTP credentials, such as database logins, need a host-side proxy or a wrapper tool that holds the credential. Read Gondolin's `docs/secrets.md` first.
- **Trust boundary:** a session sees only its own project's memory and secrets. This becomes enforced rather than conventional at this point.

## Phase 3: memory engines

- **Interface:** `{ inject(ctx) → text, ingest(sessionEvents) }`. The default engine is `memory.md`.
- **Project observational memory:** a background worker runs when a session ends or goes idle.
  - It merges the per-session observational-memory reflections, not raw transcripts, into project reflections.
  - Each project reflection keeps provenance (session ID and observation ID), so `recall` can follow it back to its source.
- **Research first:** look for existing cross-session consolidation with provenance. Candidates are Mastra's observational memory, Letta/MemGPT, Mem0, Zep/Graphiti, A-MEM, and the reflection step from Generative Agents.
- **Direction:** a project with memory, secrets and a background worker is the home for a future agent.

## Phase 4: cross-machine sharing (pi-sync)

- **Machine-local by default.** pi-sync is needed only for projects shared across machines.
- **Server:** pi-sync gains a `/v1/projects/<id>` document, using the same ETag compare-and-swap and leases as sessions. It also gains a name index.
- **Name collisions:** sharing a project whose name is already taken under another ID returns 409. The client refuses it and tells the user to run `/project name`.
- **Repos:** each repo is recorded as a pi-sync workspace pointer `{gitRemote, branch, upstream commit}`. Opening a project on another machine runs pi-sync's `planCode`/`arriveCode` logic for each repo: clone if missing, fast-forward when it's safe, otherwise ask. This may require exporting those functions from pi-sync.
- **pi-sync changes:** pi-sync currently reconciles git state from the session's working directory. The project root is not a repo, so pi-sync needs project awareness.

## Phase 5: pi-web and workspaced

- **pi-web:** becomes a client of the store.
  - Migrate `config.json projects[]` and `bindings.json` into it.
  - UI: a scope switcher (Chats or an open project), a project home, an archive view.
- **workspaced:** provisions a worker for a project when its sessions wake. It mounts the project volume at `PI_PROJECTS_DIR` and installs the package as usual.
  - Grants and secrets become per project, not per repo.
- **Docs:** fix pi-web drift. `design/revision-2/ARCHITECTURE.md` mentions `projects.json` and claims that closing a session removes its worktree.

## Phase 6: lifecycle UI

Archive, restore and delete with purge, in pi-web. Archiving never deletes a worker volume.
