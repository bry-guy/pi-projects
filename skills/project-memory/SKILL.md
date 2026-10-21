---
name: project-memory
description: Decide what to save to a pi project's shared memory and how to organize repos and worktrees. Use when working inside a pi project (the system prompt names one) and you learn a durable fact, make a decision, or need a repo or branch checkout.
---

# Project memory

Every session in the project sees `memory.md`. Keep it short and true.

Save with `project_remember` when you learn something a future session would otherwise have to rediscover:

- decisions and their reason ("use Postgres 16 for homelab-db, matches prod");
- conventions (naming, deploy commands, where things live);
- environment facts (hosts, service names, which repo owns what);
- user preferences stated for this project.

Do not save:

- progress logs, task status, or anything true only for this session;
- secrets or credentials, ever;
- facts already in a repo's README or AGENTS.md;
- guesses. Save only what was confirmed.

Write one self-contained line per fact. If a fact replaces an older one, tell the user so they can edit memory with `/project memory`.

# Layout

- `repos/<name>`: main clones. Use `project_clone`.
- `worktrees/<repo>/<branch>`: branch checkouts. Use `project_worktree` when working on a non-default branch or in parallel with another session. Small changes on the default branch can go in `repos/<name>`.
- `artifacts/`: notes, generated files and scratch output.
- Never put files at the project root.
