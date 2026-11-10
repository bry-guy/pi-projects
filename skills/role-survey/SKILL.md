---
name: role-survey
description: Survey recent sessions for repeated admin work and propose role actions. Use when asked what could be delegated to a role, to review role coverage, or on a schedule by an upkeep agent.
---

# Role survey

Interactive sessions are admin on the host. Work they repeat by hand is a candidate for a role, so the next session
can hand it to `role_agent`. This skill finds that work and proposes the role changes. It changes no grants and merges
nothing.

## 1. Scope

- One project and a time window (default: the last 14 days).
- Session files are JSONL under the pi agent dir's `sessions/` folders (`~/.pi/agent/sessions/--<cwd with / as ->--/`),
  one folder per cwd. Take the folders for the project root and its `repos/` and `worktrees/` paths.
- Read only tool calls: bash commands and `broker_run` actions (and their exit status). Filter with `jq` or a script;
  never dump whole transcripts into the chat.
- Never print secrets, tokens, system prompts or model thinking.

## 2. Tally (cheap subagent)

Give an `Explore` subagent the file list and window and ask for a short table:

- commands the admin session ran repeatedly, grouped by program and subcommand (`gh pr merge`, `kubectl get`,
  `tofu plan`), with counts and the repos or cwds they ran in;
- which of them an existing role action already covers (read `repos/<repo>/.pi/roles/*.json` on `origin/main`);
- which needed credentials or hosts no role has;
- which were one-off.

## 3. Propose

For each repeated workflow, pick one:

- "already covered by `<role>` action `<x>`: delegate next time";
- "add broker action `<name>` to `<role>`: `<argv template>`, auto or ask";
- "add egress host `<h>` to `<role>`";
- "keep as admin: `<why>`". DB writes, host SSH, secret rotation and anything destructive stay admin.

Rules:

- Propose the narrowest action: fixed argv, fixed cwd, arguments limited by a pattern.
- Prefer read-only actions.
- Never propose giving a role the admin's own credentials. A new credential is a scoped one Bryan creates.

## 4. Output

1. A short table ranked by how often the work came up: workflow, count, proposal.
2. One PR per repo that changes `.pi/roles/<role>.json` (branch `agent/role-survey-<date>`). These PRs wait for
   Bryan's code-owner review; never merge them yourself.
3. A note listing anything that needs a new credential, App permission or secret source from Bryan.
