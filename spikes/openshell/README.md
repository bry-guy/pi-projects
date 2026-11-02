# OpenShell on k3s spike

Question: can NVIDIA OpenShell replace our web worker sandbox (Phase 1.5 in `docs/agent-roles-phase1.md`)
without breaking the Claude subscription login, streaming, git, or the worker model? Mac stays on Gondolin.

Already proven without OpenShell (2026-11-01, see the plan): Anthropic accepts OpenShell's form-encoded
refresh, and pi + `openshell-oauth.ts` works through OpenShell's exact header-rewrite rule.

## Run (laptop, cluster-admin; needs Bryan's approval)

Prereqs: `kubectl` context `infra-k3s-admin`, `helm`, `jq`, `gh` (logged in), node. Nothing is installed on
the Mac except a CLI binary in `./bin` (no Homebrew formula, no local gateway).

0. **Dedicated sign-in for the gateway.** Same Claude account, its own refresh token (like each device has):
   `export LOGIN_DIR=$(mktemp -d); PI_CODING_AGENT_DIR=$LOGIN_DIR pi` → `/login` → Anthropic → quit.
   T1 deletes `LOGIN_DIR` once the gateway holds the token.
1. Create a private throwaway repo `bry-guy/openshell-spike` with one commit (or set `SCRATCH_REPO`).
2. `export IMAGE=ghcr.io/bry-guy/pi-ez-web:sha-<current main commit>`
3. `./run.sh cli && ./run.sh install`, then the port-forward in a second terminal, then `./run.sh connect`
4. `./run.sh t1` … `./run.sh t5` (flags follow the v0.1.6 docs; if one is rejected, check `bin/openshell <cmd> --help`)
5. `./run.sh teardown`

## Pass criteria

| Test | Proves | Pass |
|---|---|---|
| T1 | gateway refreshes a Claude subscription login and persists the rotated refresh token | rotate OK; original token then rejected; rotate OK again after gateway restart |
| T2a | pi in a sandbox reaches Claude through the proxy (TLS interception + Node CA) | `OPENSHELL-OK` |
| T2b | streaming through the L7 proxy | many `text_delta` events spread over time |
| T2c | the agent never holds the token | env shows only `openshell:resolve:env:…` |
| T3 | deny-by-default egress, binary matching | example.com and curl→Anthropic denied |
| T4 | per-repo GitHub push via placeholder Basic auth | push to scratch repo works; push to `pi-projects` denied |
| T5 | worker model: long-running server, exposed port, disk kept across stop/start | `/api/health` 200 via service URL; file survives |

Not covered here: Codex (ChatGPT OAuth plus account header), pi-web front end calling sandboxes through the
OpenShell gateway instead of workspaced, and wake latency. Decide after T1–T5.

## Safety notes

- The gateway is plaintext and unauthenticated for the spike. It's reachable only by port-forward and from its own
  namespace (NetworkPolicy in `install`). Tear down when done.
- T4 puts your `gh` token in the gateway (the sandbox sees only a placeholder). The spike repo and the deny test
  touch only the scratch repo. If T4b prints no denial, delete branch `openshell-spike-deny-test` on pi-projects.
