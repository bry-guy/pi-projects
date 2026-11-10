# Portable Projects — plan across repos

Goal: **My Pi, everywhere I work.** A project (its memory, its repo list, its
sessions) is the same on the laptop, on another laptop, and in pi-web, and a
session always opens inside its project.

## Status (2026-10-30)

Done and pushed:
- pi-projects `ca45400`, `e327a51`: `repos[]` in project.json (clone records,
  missing repos clone on session start, `/project repos [remove <name>]`),
  state repo (`/project share <remote>`, commit+push after changes, background
  pull on start), `pi-project` link entry `{projectId, name, rel}`, titled
  session list. Docs `dc6172e`.
- State repo: private `bry-guy/pi-projects-state`; the laptop's
  `~/.pi/agent/pi-projects` is shared to it.
- pi-sync `96f84ea` on main (deployed): S1 background enroll + lease fix, S2
  arrival in the project folder (file goes in that folder's sessions dir),
  S3 no code sharing from the state repo, S4 parentSession kept, S5 optional
  `project` on envelope/list/append (server + client).
- pi-background `bc880e8`, public `bry-guy/pi-background`, installed from
  git: B1, B2 (snapshot on connect, tested), B3 (early-exit notice, untested).

Pod wake measured on `ws-pi-projects` (k3s, read-only): scheduled → sandbox
ready 3 s, prestart ~0.1 s, server listening +0.2 s, prewarm 1.3 s, ready ~2 s
after container start. Image is already `IfNotPresent`. So a clean wake is
about 5–6 s; the slow wake seen that day (6 min) was two container crashes
(exit 139, segfault) before the third start succeeded. W6: skip-dotfiles and
image items are not needed; wake-on-open exists (sidebar); investigate the
exit-139 crashes instead.

pi-web `portable-projects`, rebased and merged to main as `e7cb2fe`
(2026-10-30); CI deployed preview and production, Argo synced, existing
repo-keyed workers restarted with 0 restarts. 331 tests + DOM gate pass.
exit-139: evidence gone after the rollout (pods replaced, events expired);
no native addons in the image, so suspect node/runtime; capture
`logs --previous` and node on the next occurrence.
- W-a: with `PI_PROJECTS_DIR`, each repo in a project's `project.json` is a
  pi-web project (`id pp-<project>-<repo>`, `group`), worktrees in
  `<project>/worktrees/<repo>/`, root-folder sessions listed under the first
  repo, add/remove repo edits project.json and pushes the state repo.
- W-b: sidebar shows one entry per pi project; Project menu lists repos
  (add/remove, worktrees), sessions, past, other devices (pi-sync `project`
  filter); files pane has repo and branch switchers (no git checkout).
- W-c: `POST /v1/workspaces {project}` makes worker `ws-<project>` with
  `PI_PROJECTS_DIR=/data/projects`, `PI_WEB_PROJECT`; it sparse-clones its
  project from `PI_PROJECTS_STATE_REMOTE` (added to workspace-env ConfigMap)
  or creates it. New project in the UI asks for a name.
- Dotfiles: pi-projects and pi-background install from git (yadm 0218806).
- Verified on the cluster 2026-10-30: a project worker (`ws-pi-web-ecosystem`)
  was created from the UI; its sparse clone of the private state repo and its
  HTTPS repo clones worked, and a session opened there. Not yet verified:
  laptop sessions listing in its Project menu.
- S6 done: pi-sync `335c4ca` (deployed) adds `GET /v1/projects` and
  `?project=` on `/v1/sessions`.
- W7 built: pi-web `1c3ea89` on `portable-projects`, live on preview (UI only;
  preview's `/api` is production, so the new listing needs main). Web lists
  pi-sync projects without a worker, shows their other-device conversations
  from pi-sync (no worker), "Open on the web" or opening a conversation
  creates the worker; opening the Project menu wakes a sleeping worker.
- Gap: sessions get a `project` on pi-sync only after pi-projects writes the
  named link (session start with pi-projects >= ca45400) and the next push;
  on 2026-10-30 none of 88 synced sessions had one yet.
- Verified 2026-10-30: a laptop session in pi-web-ecosystem opened on its
  web worker (`ws-pi-web-ecosystem`) in `/data/projects/pi-web-ecosystem`,
  all 7 repos cloned (GitHub SSH remotes clone over HTTPS on web).
- One Project menu for every pi project; other devices' sessions sit in its
  Sessions list labelled by device; opening a project creates its worker.
- Project folder sessions (pi-web `13986a6`): the folder is its own web entry
  (`pp-<name>`, kind `folder`, no Git); New session defaults to it, so a
  project needs no repository.
- Workers skip laptop-only packages via `PI_WEB_SKIP_PACKAGES`
  (pi-background, pi-keepalive).
- Project-first on the web: old repo-keyed workers are removed from
  Settings -> Workers; web no longer creates them. The single-repo code path
  stays for pi-web without PI_PROJECTS_DIR (local, self-hosted).
- Project sessions live in the project: web lists every session under the
  project folder entry, starts and opens them there; pi-sync opens arriving
  project conversations at the project root (pi-sync c9b85c4).
- Repository sessions (2026-11-07, pi-web #5, supersedes "repos own no
  sessions"): a session run in a repository or one of its worktrees lists
  under that repository (Project menu drill-through) and opens there on the
  project's worker; project-level sessions stay on the folder entry. pi-sync's
  `/sync open` inside a project keeps the conversation where it ran.
- Project code sharing, in pi-sync (d196f89; it already owned turn-end
  capture, leases and arrival): every repo/worktree with unshared work is
  pushed to `refs/pi-projects/<project-id>/<branch>` on that repo's remote,
  compare-and-swap so unseen work is never overwritten. Arrival creates
  missing worktrees and restores into clean trees only; otherwise a notice
  and `/sync code`. Replaces per-conversation code sync inside projects.

## Rules

1. One writer per session: pi-background's lock on a machine, pi-sync's lease
   across machines.
2. pi-web's worker REST/SSE API is how clients attach to a session a worker
   runs.
3. A session changes machine only between turns.
4. pi-sync owns only session logs and leases. Code moves through git (each
   repo's remote). Project state moves through git (one state repo).
5. The trust boundary is the project. A worker pod serves one project at a
   time; pods sleep and wake, project disks persist.

## Project shape

```text
$PI_PROJECTS_DIR/            # one git repo: the state repo
  .gitignore                 # */repos/  */worktrees/  */artifacts/
  .gitattributes             # */memory.md merge=union
  <name>/
    project.json             # {id, name, repos: [{name, url, branch}]}
    memory.md
    repos/<repo>/            # re-cloned from project.json, not tracked
    worktrees/<repo>/<branch>/
    artifacts/               # local scratch, never synced
```

## Changes

### pi-projects
- P1 `project.json` gains `repos[]`. `project_clone` records the repo. On
  session start, missing repos are cloned (in the background, with a notice).
- P2 State repo. `/project share <remote>` (one time) turns `PI_PROJECTS_DIR`
  into a git repo with the ignore and union-merge files. After any project
  change (remember, clone, rename, new) pi-projects commits and pushes,
  pull --rebase and retry once on rejection. On session start it pulls.
  Failure never blocks pi; it shows a notice.
- P3 Session link. On the first turn in a project, append one custom entry
  `{customType: "pi-project", data: {projectId, name, rel}}` (`rel` = cwd relative
  to the project folder). Custom entries survive pi-sync verbatim.
- P4 `/project` session list labels sessions by name or first message.
- P5 Update `docs/plan.md`: Phase 4 becomes the state repo, Phase 5 becomes
  project disks with a pool of pods.

### pi-sync
- S1 Merge `bg-enroll-lease` (f5661d6): background sessions enroll and hold
  the lease; session_start no longer drops another local process's lease.
- S2 Arrival: when materializing a session that has a `pi-projects` entry,
  write it with `cwd = $PI_PROJECTS_DIR/<name>/<rel>` instead of `ctx.cwd`
  (create the folder if missing). Without the entry, behavior is unchanged.
- S3 Skip code sync when the cwd's git toplevel is `PI_PROJECTS_DIR` (the
  state repo). pi-projects owns that repo; pi-sync must not push WIP
  snapshots into it.
- S4 Keep `parentSession` on materialize (currently dropped,
  adapter.ts:97).
- S5 Optional `project` (name) on the session envelope and server list,
  set from the pi-projects entry, with a list filter. Needed because the
  default session cwd is the project root, which has no code workspace
  pointer, so grouping by repo URL would miss most sessions.

### pi-background
- B1 Create github.com/bry-guy/pi-background, push, reinstall from git.
- B2 On watcher connect, send the in-progress message and running tool first.
- B3 Report runners that die before writing a run record.

### pi-web / workspaced
- W1 workspaced keys a worker by **project name**, not repo. One PVC per
  project mounted at `PI_PROJECTS_DIR=/data/projects`. Prestart: sparse clone
  of the state repo with only `<name>/` (needs git credentials in the pod;
  pi-web already has `git-credential-helper.js`), then pi-projects clones the
  repos. Today prestart is only dotfiles (`workspace-env.yaml:16-53`); the
  startup probe allows ~300s (`manifests.js:78-80`).
  Sleep/wake/max-awake/busy rules stay as they are.
- W2 Workers load pi-projects (via the dotfiles settings layer).
- W3 pi-web's project becomes the pi-projects project (folder + project.json)
  instead of `{id, name, repoPath}`. The existing Project menu
  (`public/js/project-menu.js`: sessions, past sessions, other devices,
  worker, removal) becomes the Project modal:
  - shown by project name;
  - Repos: list, add (reuse `repo-picker.js`, records in project.json),
    delete; each repo shows its worktrees;
  - Sessions: all sessions whose cwd is inside the project (historical),
    plus other devices' sessions (S5); open one, or New session (cwd =
    project root by default, or pick repo + branch for a worktree);
  - open sessions stay what they are today: the live ones in the sidebar.
  Code viewer (`files.js`) gets a repo switcher and a branch switcher; the
  branch switcher picks an existing checkout/worktree, it does not run git
  checkout. Server: per-repo git/worktree routes take `{project, repo}`;
  `worktreeRoot = <project>/worktrees` so worktrees land at
  `worktrees/<repo>/<branch>` (check `slug(branch)`).
- S6 pi-sync server `GET /v1/projects` → `[{name, lastActive, sessions}]`,
  derived from session metadata `project` (S5; `internal/api/api.go:588`),
  no new storage. Also add a `project` query filter to `GET /v1/sessions`
  (today only `repository`, `api.go:550-563`; pi-web filters client-side).
  The server is single-user and unauthenticated (`api.go:41-68`), so the
  list is global; fine while pi-sync stays private to the cluster/tailnet.
- W7 pi-ez-web home lists projects from S6 (it already has
  `PI_SYNC_SERVER_URL`, `deploy/k8s/web/deployment.yaml:185-189`) merged with
  workers (awake/asleep). The front end caches each worker's last Project
  menu response opaquely (no interpretation) and shows it at once, marked
  updating, while it wakes or creates the worker. Today `/projects/:id/*` is
  forwarded to the owning worker and 404s without one
  (`server/remote-workspaces.js:520-525`), so a project with no worker
  needs a front-end route that creates it on open. The front end never
  reads the state repo. Limit: a project appears after its first synced
  session.
- W6 Faster wake (measure first: `kubectl get events` + pod log for one
  wake, to see time per step):
  - wake the pod when the Project modal opens, not when a session opens
    (the modal renders from the state repo and pi-sync server, no pod);
  - prestart skips the yadm update when the dotfiles commit is unchanged,
    and reinstalls pi packages only when settings.json changed (the
    project PVC keeps them);
  - `imagePullPolicy: IfNotPresent` and pre-pull the image on nodes;
  - one warm spare pod that can adopt any project (only if the above is
    not enough).
- W4 Web home lists projects (needs state-repo access on the web front end,
  medium) and their sessions (pi-sync server list, filtered by project, S5).
  Opening one wakes that project's pod and runs `/sync open` (today:
  temp session at `context.path` + `/sync open <id>`,
  `server/routes/projects.js:208-213`); S2 puts it in the right folder.

## Order

1. P1, P3, S1, S4, B1 (small, independent).
2. P2 + S3 (state repo) — dogfood laptop↔laptop.
3. S2 + S5 — synced sessions open in their project and list under it.
4. W1, W2, W3 — project pods. W4 last.
5. B2, B3, P4 polish; W6 (wake on modal open lands with W4).

## Final UX

- Laptop: `/project` as today. Cloning a repo records it; remembering a fact
  commits and pushes it. `/bg`, switching mid-turn, and `/resume` to watch work
  as now.
- Another machine: pull a session (pi-sync) and it opens in the same project
  folder, with memory already there and repos cloned on first use.
- Web: home shows projects. Opening a project wakes its pod (seconds); its
  sessions, including laptop ones, are listed; opening one runs it in the
  project. Up to N pods awake; busy pods never sleep.
- One writer always: opening a session busy elsewhere shows "running on X"
  with take over.

## Open checks
- S2 writes header cwd = project folder, but the file lands in the per-cwd
  sessions dir of `ctx.cwd` (`chat-transfer.js:12`). Verify pi-web
  `listSessions(cwd)` and pi `/resume` still find it (pi-projects scans
  header cwd, so it is fine).
- pi-sync code refs (S2–S4) come from an earlier read; re-check on the
  current pi-sync before building.
- pi-web `slug(branch)` vs pi-projects worktree folder naming.
- Where pi-web's web home lists synced sessions from today (worker or server).
- Pod warm-start time on k3s.
