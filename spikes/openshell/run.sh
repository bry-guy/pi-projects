#!/usr/bin/env bash
# OpenShell on k3s spike. Run from the laptop, one step at a time: ./run.sh <step>
# Steps: cli install connect t1 t2 t3 t4 teardown   (see README.md)
# Every cluster step uses KUBECTL_CONTEXT (default infra-k3s-admin); it needs Bryan's approval.
set -euo pipefail
cd "$(dirname "$0")"

OS_VERSION="${OS_VERSION:-v0.1.7}"            # OpenShell release (CLI + chart)
SANDBOX_CRD_VERSION="${SANDBOX_CRD_VERSION:-v1.0.10}"  # kubernetes-sigs/agent-sandbox
CTX="${KUBECTL_CONTEXT:-infra-k3s-admin}"
NS=openshell
IMAGE="${IMAGE:?set IMAGE=ghcr.io/bry-guy/pi-ez-web:sha-<commit> (a current worker build)}"
OS="$PWD/bin/openshell"
k() { kubectl --context "$CTX" "$@"; }
os() { "$OS" "$@"; }
say() { printf '\n== %s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; }
# pi's public Anthropic OAuth client id (same value pi decodes in auth/oauth/anthropic.js)
CLIENT_ID="$(echo OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl | base64 -d)"
PI="node /app/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"

step_cli() {   # CLI only: no Homebrew formula, no local gateway service on the Mac
  say "download openshell CLI $OS_VERSION into ./bin"
  mkdir -p bin
  local asset=openshell-aarch64-apple-darwin.tar.gz
  [ "$(uname -s)" = Linux ] && asset=openshell-x86_64-unknown-linux-musl.tar.gz
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/$OS_VERSION/$asset" | tar -xz -C bin
  [ -x "$OS" ] || OS="$(find bin -type f -name openshell | head -1)"
  "$OS" --version
}

step_install() {
  say "Agent Sandbox CRDs + controller $SANDBOX_CRD_VERSION (cluster-scoped)"
  k apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$SANDBOX_CRD_VERSION/sandbox.yaml"
  k -n agent-sandbox-system rollout status deploy --timeout=120s
  say "namespace + ghcr pull secret (copied from pi-workspaced)"
  k create namespace "$NS" --dry-run=client -o yaml | k apply -f -
  k -n pi-workspaced get secret ghcr-pull -o json \
    | jq 'del(.metadata.namespace,.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.ownerReferences,.metadata.managedFields)' \
    | k -n "$NS" apply -f -
  say "OpenShell chart ${OS_VERSION#v}: plaintext + unauthenticated, reachable only via port-forward"
  helm --kube-context "$CTX" upgrade --install openshell oci://ghcr.io/nvidia/openshell/helm-chart \
    --version "${OS_VERSION#v}" --namespace "$NS" \
    --set server.disableTls=true \
    --set server.auth.allowUnauthenticatedUsers=true \
    --set server.drivers.kubernetes.allowDriverConfig=true \
    --set server.telemetryEnabled=false \
    --set 'imagePullSecrets[0].name=ghcr-pull'
  k -n "$NS" rollout status statefulset/openshell --timeout=300s
  say "lock the unauthenticated gateway to its own namespace (port-forward bypasses this)"
  k -n "$NS" apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: spike-same-namespace-only }
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress: [{ from: [{ podSelector: {} }] }]
EOF
}

step_connect() {
  say "port-forward + register gateway (leave this running in its own terminal)"
  echo "Run in another terminal:  kubectl --context $CTX -n $NS port-forward svc/openshell 8080:8080"
  os gateway add http://127.0.0.1:8080 --local --name spike || true
  os status
}

step_t1() {   # Gateway refreshes a Claude subscription login and keeps the rotated token
  : "${LOGIN_DIR:?set LOGIN_DIR to the throwaway agent dir you ran pi /login in (README step 0)}"
  local rt; rt="$(node -e 'console.log(require(process.argv[1]).anthropic.refresh)' "$LOGIN_DIR/auth.json")"
  say "T1 gateway refresh"
  os profile lint -f anthropic-oauth.yaml
  os profile import -f anthropic-oauth.yaml
  os provider create --name anthropic-sub --type anthropic-oauth --credential OPENSHELL_ANTHROPIC_PLACEHOLDER=placeholder
  os provider refresh configure anthropic-sub --credential-key OPENSHELL_ANTHROPIC_PLACEHOLDER \
    --strategy oauth2-refresh-token --material "client_id=$CLIENT_ID" --material "refresh_token=$rt" \
    --secret-material-key refresh_token
  os provider refresh rotate anthropic-sub --credential-key OPENSHELL_ANTHROPIC_PLACEHOLDER
  os provider refresh status anthropic-sub
  say "the original refresh token should now be spent (proves the gateway rotated it)"
  RT="$rt" CID="$CLIENT_ID" node --input-type=module -e '
    const r = await fetch("https://platform.claude.com/v1/oauth/token", { method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: process.env.CID, refresh_token: process.env.RT }) });
    console.log(r.status === 400 ? "PASS  original refresh token rejected (rotated)" : "CHECK original token status " + r.status);'
  rm -rf "$LOGIN_DIR"; echo "removed $LOGIN_DIR: only the gateway holds this login now"
  say "restart the gateway, rotate again: works only if the rotated refresh token was persisted"
  k -n "$NS" rollout restart statefulset/openshell && k -n "$NS" rollout status statefulset/openshell --timeout=300s
  echo "re-run the port-forward if it dropped, then press Enter"; read -r _
  os provider refresh rotate anthropic-sub --credential-key OPENSHELL_ANTHROPIC_PLACEHOLDER && pass "T1 refresh survives restart" || fail "T1"
}

sx() { os sandbox exec -n pi-spike --no-login-shell -- sh -c "$1"; }

step_t2() {   # our pi + anthropic-auth + shim, through the real proxy (TLS interception, Node CA)
  say "T2 pi in a sandbox from the worker image, Claude login via the gateway"
  # t2-policy.yaml = worker policy + npm rule with allow_encoded_slash (scoped packages are %2F-encoded)
  os sandbox create --name pi-spike --from "$IMAGE" --provider anthropic-sub --policy t2-policy.yaml --detach -- sleep infinity
  sx 'mkdir -p /sandbox/agent /sandbox/ext /sandbox/work'
  os sandbox upload pi-spike ./openshell-oauth.ts /sandbox/ext/ --no-git-ignore
  sx 'printf "%s" "{\"packages\":[\"npm:@gotgenes/pi-anthropic-auth\"],\"extensions\":[\"/sandbox/ext/openshell-oauth.ts\"]}" > /sandbox/agent/settings.json'
  local out t0 t1; out="$(mktemp)"; t0=$(date +%s)
  if ! sx "cd /sandbox/work && PI_CODING_AGENT_DIR=/sandbox/agent ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-openshell $PI --no-session --model anthropic/claude-haiku-5-5 -p 'Reply with exactly: OPENSHELL-OK'" 2>&1 | tee "$out"; then
    fail "T2 pi exited non-zero"; return 1
  fi
  t1=$(date +%s); echo "pi finished in $((t1 - t0))s"
  grep -q OPENSHELL-OK "$out" || { fail "T2 reply"; return 1; }
  pass "T2 reply through the real proxy"
  sx 'case "$OPENSHELL_ANTHROPIC_PLACEHOLDER" in *openshell:resolve:env:*) exit 0;; *) exit 1;; esac' || { fail "T2 placeholder"; return 1; }
  pass "T2 agent holds only a placeholder"
}

WORKER_HOST="Host: default--worker-spike.openshell.localhost:8080"   # the gateway routes exposed services by Host header
health() { for _ in $(seq 1 90); do [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' -H "$WORKER_HOST" http://127.0.0.1:8080/api/health)" = 200 ] && return 0; sleep 1; done; return 1; }
wx() { os sandbox exec -n worker-spike --no-login-shell -- sh -c "$1"; }

step_t3() {   # pi-web worker as a sandbox: our image, our disk at /data, exposed port, SSE, stop/start, wake time
  say "T3 worker sandbox (the PVC mount needs allowDriverConfig, set at install)"
  printf '%s\n' 'apiVersion: v1' 'kind: PersistentVolumeClaim' "metadata: { name: ws-spike, labels: { openshell.ai/sandbox-attachable: 'true', openshell.ai/sandbox-attachable-workspace: '${OS_WORKSPACE:-default}' } }" \
    'spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 1Gi } } }' | k -n "$NS" apply -f -
  local t0=$SECONDS
  # The default policy hides /app and the mount defaults to read-only; OpenShell also resets HOME to /sandbox.
  os sandbox create --name worker-spike --from "$IMAGE" --policy worker-policy.yaml --expose 3141 --detach --no-tty \
    --env PORT=3141 --env PI_WEB_MODE=real --env HOST=127.0.0.1 --env HOME=/data/pi-ez-operator-home \
    --driver-config-json '{"kubernetes":{"volumes":[{"name":"data","persistent_volume_claim":{"claim_name":"ws-spike","read_only":false}}],"containers":{"agent":{"volume_mounts":[{"name":"data","mount_path":"/data","read_only":false}]}}}}' \
    -- node /app/server/index.js
  health && pass "T3 /api/health via the gateway, $((SECONDS - t0))s after create (today's workers wake in ~5-6s)" || fail "T3 health"
  timeout 6 curl -sSN -H "$WORKER_HOST" http://127.0.0.1:8080/api/events | head -c 300 | grep -q connected && pass "T3 SSE through the gateway" || fail "T3 SSE"
  wx 'echo kept > /data/persist.txt'
  os sandbox stop worker-spike; t0=$SECONDS; os sandbox start worker-spike
  health && echo "stop -> start -> health: $((SECONDS - t0))s"
  wx 'cat /data/persist.txt' | grep -q kept && pass "T3 /data kept across stop/start" || fail "T3 disk"
}

step_t4() {   # in-cluster plain-http service behind the egress guard (pi-syncd), from the worker sandbox
  say "T4 pi-syncd reachable from a sandbox only via an explicit rule"
  # The sandbox resolver has no cluster search domains: use the full service name.
  local probe='node -e "fetch(\"http://pi-syncd.pi-sync.svc.cluster.local:8080/v1/health\").then(r=>console.log(\"status\",r.status)).catch(e=>console.log(\"denied\",e.cause?.code||e.message))"'
  wx "$probe" | grep -q denied && pass "T4 denied before the rule" || fail "T4 open before the rule"
  os policy update worker-spike --rule-name pisync --binary /usr/local/bin/node \
    --add-endpoint 'pi-syncd.pi-sync.svc.cluster.local:8080:read-write:rest:enforce' --wait
  wx "$probe" | grep -q "status 200" && pass "T4 pi-syncd reachable after the rule" || fail "T4"
}

step_teardown() {
  say "teardown"
  os sandbox delete pi-spike worker-spike || true
  k -n "$NS" delete pvc ws-spike --wait=false || true
  os provider delete anthropic-sub || true
  helm --kube-context "$CTX" uninstall openshell -n "$NS" || true
  k delete namespace "$NS" --wait=false || true
  k delete -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$SANDBOX_CRD_VERSION/sandbox.yaml" || true
  os gateway remove spike || true
  echo "The dedicated Anthropic login died with the gateway database."
}

"step_${1:?usage: ./run.sh <cli|install|connect|t1|t2|t3|t4|teardown>}"
