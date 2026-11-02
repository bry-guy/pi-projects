# OpenShell on k3s spike

Question: can NVIDIA OpenShell replace our web worker sandbox (Phase 1.5 in `docs/agent-roles-phase1.md`)
without breaking the Claude subscription login, streaming, git, or the worker model? Mac stays on Gondolin.

Already proven without OpenShell (2026-11-01, see the plan): Anthropic accepts OpenShell's form-encoded
refresh, and pi + `openshell-oauth.ts` works through OpenShell's exact header-rewrite rule.

Scope: only **our** setup. OpenShell's own features (streaming, deny-by-default egress, per-repo git push,
placeholder Basic auth) are proven by its users and docs, so they aren't retested here.

## Run (laptop, cluster-admin; needs Bryan's approval)

Prereqs: `kubectl` context `infra-k3s-admin`, `helm`, `jq`, node. Nothing is installed on the Mac except a CLI
binary in `./bin` (no Homebrew formula, no local gateway).

0. **Dedicated sign-in for the gateway.** Same Claude account, its own refresh token (like each device has):
   `export LOGIN_DIR=$(mktemp -d); PI_CODING_AGENT_DIR=$LOGIN_DIR pi` → `/login` → Anthropic → quit.
   T1 deletes `LOGIN_DIR` once the gateway holds the token.
1. `export IMAGE=ghcr.io/bry-guy/pi-ez-web:sha-<current main commit>`
2. `./run.sh cli && ./run.sh install`, then the port-forward in a second terminal, then `./run.sh connect`
3. `./run.sh t1` … `./run.sh t4` (flags follow the v0.1.6 docs; if one is rejected, check `bin/openshell <cmd> --help`)
4. `./run.sh teardown`

## Pass criteria

| Test | Our-setup risk | Pass |
|---|---|---|
| T1 | Gateway refresh against Anthropic's endpoint, which rotates the refresh token | rotate OK; original token then rejected; rotate OK again after gateway restart |
| T2 | Our pi + anthropic-auth + `openshell-oauth.ts` through the real proxy (TLS interception, Node CA) | `OPENSHELL-OK`; env holds only `openshell:resolve:env:…` |
| T3 | Our worker image as a sandbox: our PVC at `/data`, pi-web on an exposed port, pi-web's SSE through OpenShell's service forwarding, stop/start, wake time | `/api/health` 200; events stream; file survives; times noted |
| T4 | Our in-cluster plain-http pi-syncd behind OpenShell's private-address (SSRF) guard | denied before the rule, reachable after |

Not covered: Codex login (decide after T1/T2), the infra worker (needs a cluster-admin service account and
the kube API, so it stays on today's provider).

## Safety notes

- The gateway is plaintext and unauthenticated for the spike. It's reachable only by port-forward and from its own
  namespace (NetworkPolicy in `install`). Tear down when done.
