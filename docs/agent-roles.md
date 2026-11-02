# Agent roles and sandboxed projects

Status: Phase 1 (Mac) built 2026-11-02; see [agent-roles-plan.md](agent-roles-plan.md) for what's built, how it differs
from this design (role files are JSON; the stall heartbeat lives in pi-background's runner), and what's next.

## Problem

- **Agents can't do enough.** A project's agent lacks the credentials and network access for routine work, so it stops and asks.
- **Approvals are too frequent.** Work that Bryan has already decided is fine should run without a prompt.
- **Blast radius should stay small.** Each credential should be usable only by the role that needs it, and the agent must not be able to widen its own access.

## Model

- **Repos define roles.** Repos are permanent, so a role lives with its repo in `.pi/roles/<role>.json`. A role lists egress hosts, secret names (not values) and broker actions.
- **Projects grant roles.** A project is a short-lived grouping of repos for a goal. Its `project.json` lists which repo roles its agents may take on.
- **One role per session.** Roles don't compose. The project agent (the one you talk to) runs as `roles.default` from `project.json`, which can be any granted role. With no default it runs sandboxed with no grants: a VM or pod with no role secrets and no role egress. To do another role's work it starts an agent as that role, with the task. That agent has its own VM or pod, egress and secrets, and reports back as text.
- **No prompts for granted work.** Granting a role to a project is the decision. Anything the role allows runs without asking.
- **Admin work is out of scope for now.** Agents propose admin commands and Bryan runs them.

## Where things live

| What | Where | Changed by |
|---|---|---|
| Role definition (egress, secret names, broker actions) | `<repo>/.pi/roles/<role>.json` | a merge to the repo's `main` |
| Grant (which repo roles a project may use) | `project.json` (never mounted) | Bryan |
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

- **pi-projects:** `project.json` gains plugin sections. Each top-level key belongs to the extension that validates and applies it, as pi-ez-chat-workspace did. pi-projects owns `repos` and `roles`, and starts role agents.
- **pi-mounts** (new, reworked from pi-ez-chat-mount): owns the `mounts` section. Uses Gondolin `RealFSProvider` and `ReadonlyProvider`, plus a filter provider for hidden paths. Nothing from pi-chat is reused.
- **Sandbox:** one Gondolin VM per session, with a Fedora `pi-worker` image and a per-role mise tool cache, so one role can't swap a binary another role runs.
- **Broker** (later, from pi-ez-secret-broker): host-side actions for non-HTTP credentials, such as S3 signing, read-only Postgres and tofu.
- **Pods:** the gateway holds pod grants. Pods don't run agents in a VM yet, so pod enforcement waits on that.

## Dispatching role agents

- **Tool:** pi-projects adds `role_agent(role, task, cwd?)`. It asks the runner to start a separate `pi` as that role, with its own VM or pod, and later reports the result as text. The tool only asks; the runner supervises (see Role agent runs). The role definition comes from `repos/<repo>/.pi/roles/` and the grant from `project.json`, never from `cwd`. `cwd` changes which code the agent works on, not what it may do.
- **Prompt:** at session start pi-projects injects the granted roles, e.g. "You may dispatch infra/infra-operator and infra/infra-developer with `role_agent` for work that needs their access. Use subagents for reading and exploring."
- **Errors name the role:** a blocked host or missing secret says which granted role has it, e.g. "api.cloudflare.com is not allowed for this role; infra/infra-developer has it, use role_agent."
- **A new session, not a fork.** A role agent starts as a fresh session in the project with just the task. It appears in the project's session history and can be opened, continued or taken over. Forking the calling session (`pi --fork`) to pass context is a later option.
- **In pi-web:** roles map to workers. A role worker is a pi-workspaced worker whose grant carries that role's credentials and egress, as `ws-infra` does for infra today. `role_agent` asks the gateway to start the session in the role's worker. Whether it then shows up in the web UI depends on how pi-web lists project sessions across workers (pi-sync). Unverified.
- **Subagents stay** for same-role work. `@gotgenes/pi-subagents` runs children in the parent's process and can only change their working directory, so they can't switch roles or do more than their parent.

## Role agent runs

`role_agent` hands the run to a **runner** outside the calling session, so a run survives the caller closing. The runner has two backends with the same behaviour: a new session appears in the project, and the result is reported back.

- **Desktop:** a small runner CLI (e.g. `pi-role run <role> <task>`) starts the Gondolin VM and the child `pi`, and runs the close steps. Supervision belongs to the OS: monit on macOS, systemd on Linux.
- **pi-web:** the gateway creates a Kubernetes Job; Kubernetes supervises it.

| | Mac (CLI) | pi-web |
|---|---|---|
| Runs as | local `pi` process plus a Gondolin VM | a Kubernetes Job per run |
| Starts in | ~1-2 s | ~10-20 s once cached (guess, measure) |
| Storage | the project's worktrees | a throwaway disk; clones what it needs and pushes a branch |
| Tools | per-role mise cache on disk | baked into the image, plus a read-only shared cache |

Lifecycle, owned by the harness, not the agent:

1. **Start:** clone or fetch the repos (from the git cache), then run `pi -p "<task>"`. `pi -p` exits on its own when the agent finishes. Tools that ask the user (`ask_user_question`) are disabled, so a blocked agent ends with "blocked: needs X" instead of waiting.
2. **Stalls, no time limit:** stuck tools are handled inside pi, and a frozen pi is caught by the runner. See below.
3. **Close:** push the branch, check that pi-sync has uploaded the session and report any sync failure, then exit. Finished Jobs are cleaned up automatically.
4. **Continue:** after a blocker is fixed, a new run resumes from the same session and branch.

On the Mac a sleeping laptop can pause a run; pi-keepalive helps.

### Stalls

Two questions, answered in two places:

- **Is the agent making progress?** Answered inside pi, where the tool, its command and its output are visible.
  - **Tool calls: [pi-hang-guard](https://github.com/ducaoya/pi-hang-guard)** (npm, MIT, v0.3.6). It measures silence, not run time: a `bash` command that keeps printing is never stalled. Known-slow commands get higher limits through a configurable list, and a command with an explicit bound (`timeout 3600 gh run watch`) is measured against that bound instead. In `guard` mode it aborts a stuck call and gives the model a report so it can change approach. Configured in `hang-guard.json` (`PI_GUARD_CONFIG`); role runs need `mode: guard` and `resumeWithoutUI: true`.
  - **Model calls:** a provider stream that stalls is handled by a retry extension such as `@narumitw/pi-retry`.
  - **Long waits such as CI:** the agent uses a command that prints while it waits (`gh run watch`), adds those commands to the slow list, or wraps the wait in `timeout <bound>`. The skill for role runs says so.
- **Is pi alive?** Answered outside pi, by the runner, using a heartbeat.
  - **pi-heartbeat** (small, configurable extension; name free on npm) writes a heartbeat file from pi's event loop every few seconds, with the run's state: idle, model streaming, or running a tool (name, start time, declared bound). A fresh heartbeat proves pi is responsive, not that it is making progress; progress is pi-hang-guard's job. Settings: file path and interval. When `NOTIFY_SOCKET` is set (running under systemd) it also sends `WATCHDOG=1`, e.g. through `systemd-notify`.
  - **macOS:** monit (`brew install monit`). For each run the runner writes a monit check, `check file <run> with path <heartbeat>` / `if timestamp > 10 minutes then exec "<stop script>"`, and reloads monit; it removes the check when the run ends. The stop script stops the child `pi`, and the runner then runs the close steps. Monit checks on its own cycle (30-120 s), which is fine for a minutes-long limit.
  - **Linux:** the runner starts each run as a transient systemd user unit, `systemd-run --user -p Type=notify -p NotifyAccess=all -p WatchdogSec=10min ...`. If the watchdog pings stop, systemd stops the unit; an `ExecStopPost=` runs the close steps. Unverified: notify from a node process via `systemd-notify` with `NotifyAccess=all`.
  - **k3s:** a liveness probe checks the heartbeat's age. If it goes stale, Kubernetes stops the container; the Job's wrapper traps the signal and runs the close steps within the grace period. The Job does not retry (`backoffLimit: 0`).
  - **Result:** the runner derives done, blocked or stalled from the session's last message and how pi exited; no extension needs to end the run.
- **Unverified:** whether pi-hang-guard's auto-resume (`resumeWithoutUI`) keeps a `pi -p` run going after it aborts a call, or whether `pi -p` exits first.
- **Alternatives looked at:** `@pi-unipi/watchdog` asks a model whether each long call is stuck and checks process CPU and disk activity; heavier, and part of the UniPi suite. pi has no built-in tool-call timeout (pi issues #2987, #8857).

## Startup speed

- **Now:** bake common tools into worker images, so they never install at run time.
- **Later:** shared read-only caches for git, mise tools and language packages are a separate effort that builds on this one. See [cluster-caches.md](cluster-caches.md).

## Egress in pods

- **Egress proxy first.** Role pods may reach only an in-cluster egress proxy, enforced with standard IP-based NetworkPolicy. The proxy checks each request's hostname against the role's allowlist, as Gondolin does on the Mac.
- **Non-HTTP traffic** (Postgres, the k3s API on 6443) gets plain IP rules in the role's NetworkPolicy; those addresses are ours and stable.
- **Hostname-aware network policies** (e.g. Cilium `toFQDNs`) are optional for clusters that already run them. Switching a cluster's network plugin is disruptive admin work, so it is not part of this plan.

## Hosting for others

The core is standard Kubernetes: Jobs, ServiceAccounts, Secrets, pi-sync, role files and project grants. Bryan's setup adds plug-ins: 1Password/fnox as a secret source (default: k8s Secrets), Gondolin on the Mac, a Fedora worker image, the git cache and infra's roles.

- **Default image:** slim Debian, not Alpine. mise prebuilt tools expect glibc; Alpine uses musl. Ship the default image, the install hook, and an example Dockerfile for baking in your own tools.
- **Egress by hostname** is not standard NetworkPolicy, which works on IP addresses. The egress proxy is the default; hostname-aware network policies are optional.

## Open checks

1. **Read-only files with a writable `.git`.** Mount `repos/<repo>/` read-only with `.git` mounted read-write on top. Test in a VM on the Mac that editing or checking out in `repos/` fails while `git worktree add` and commits in the worktree work.
2. **Hidden paths block writes.** pi-ez-chat-mount's filter rejects any file operation whose path contains the hidden name and filters directory listings. Swapping `node_modules` for a configurable list covers `.pi`. Code-read only; test in a VM.
3. **Gondolin read-only mounts.** `ReadonlyProvider` (`host/src/vfs/readonly.ts`, v0.14.0) returns `EROFS` for write opens, `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `chmod` and `symlink`. Code-read only; test in a VM.
4. **Role agents as processes.** Confirm a host-started `pi` can take a role and run its tools in its own VM.

## First step

List what each project agent keeps failing at, add that access to the matching repo role once, and have the project agent start that role instead of asking.
