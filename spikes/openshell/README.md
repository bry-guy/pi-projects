# OpenShell on k3s spike

Question: can NVIDIA OpenShell replace our web worker sandbox (Phase 2, W1 in `docs/agent-roles-plan.md`; paused until Phase 1 is done)
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
2. `./run.sh cli && ./run.sh install` (cluster admin), then the port-forward in a second terminal, then `./run.sh connect`.
   From here a namespace-only kubeconfig is enough: `KUBECONFIG=~/.kube/openshell-spike.yaml KUBECTL_CONTEXT=openshell-spike`
3. `./run.sh t1` … `./run.sh t4` (flags follow the v0.1.7 docs; if one is rejected, check `bin/openshell <cmd> --help`)
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

## Results

2026-11-10, OpenShell 0.1.7 and Agent Sandbox 1.0.10 on k3s (namespace `openshell`). All four pass.

| Test | Result |
|---|---|
| T1 | **Pass.** The gateway refreshed the dedicated login (the original refresh token was then rejected) and refreshed again after a gateway restart. It refreshes on its own about every 10 minutes. |
| T2 | **Pass.** pi with anthropic-auth and the shim replied `OPENSHELL-OK` in 3 s through the proxy; the sandbox env held only an `openshell:resolve:` placeholder. No CA fix was needed (the sandbox sets `NODE_EXTRA_CA_CERTS`). Streaming was not proven: the reply was too short to tell. |
| T3 | **Pass.** `/api/health` 200 through the gateway 6 s after create; SSE connects; stop removes both pods; start to health 200 in 3 s; a file on `/data` survives. |
| T4 | **Pass.** pi-syncd and the internet are denied by default (`EACCES`); pi-syncd answers 200 after one endpoint rule. |

What our setup needed:

- Chart keys: `server.auth.allowUnauthenticatedUsers` and `server.drivers.kubernetes.allowDriverConfig`, both set at
  install. After install every sandbox step works with a token limited to the `openshell` namespace.
- A policy file (`worker-policy.yaml`): the default filesystem policy makes `/app` unreadable, so the worker exits.
- The PVC mount needs `read_only: false` on the container mount too, or `/data` is read-only.
- OpenShell sets `HOME=/sandbox` for the workload: pass `HOME` explicitly.
- Cluster services need their full name (`<svc>.<ns>.svc.cluster.local`): the sandbox resolver has no search domains.
- Exposed services are reached through the gateway by Host header (`default--<sandbox>.openshell.localhost`).
- T2 needs the worker policy at create (`t2-policy.yaml`), or `/app` is unreadable. Scoped npm packages
  (`@scope/name`) need `allow_encoded_slash: true` on the registry rule, which only a policy file can set
  (`policy update --add-endpoint` cannot).
- `sandbox upload` skips git-ignored files unless `--no-git-ignore` is passed.
- Cost while running: gateway 48 Mi, plus one supervisor pod (18 Mi) per sandbox beside the workload pod.

After the run the dedicated login was deleted from the gateway (provider `anthropic-sub`), so T1 and T2 need a new
sign-in to repeat. Teardown needs cluster admin again (CRDs, cluster roles).

## Safety notes

- The gateway is plaintext and unauthenticated for the spike. It's reachable only by port-forward and from its own
  namespace (NetworkPolicy in `install`). Tear down when done.
