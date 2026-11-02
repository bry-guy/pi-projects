#!/usr/bin/env bash
# OpenShell on k3s spike. Run from the laptop, one step at a time: ./run.sh <step>
# Steps: cli install connect t1 t2 t3 t4 t5 teardown   (see README.md)
# Every cluster step uses KUBECTL_CONTEXT (default infra-k3s-admin); it needs Bryan's approval.
set -euo pipefail
cd "$(dirname "$0")"

OS_VERSION="${OS_VERSION:-v0.1.6}"            # OpenShell release (CLI + chart)
SANDBOX_CRD_VERSION="${SANDBOX_CRD_VERSION:-v1.0.9}"  # kubernetes-sigs/agent-sandbox
CTX="${KUBECTL_CONTEXT:-infra-k3s-admin}"
NS=openshell
IMAGE="${IMAGE:?set IMAGE=ghcr.io/bry-guy/pi-ez-web:sha-<commit> (a current worker build)}"
SCRATCH_REPO="${SCRATCH_REPO:-bry-guy/openshell-spike}"   # private, throwaway, has one commit
DENY_REPO="${DENY_REPO:-bry-guy/pi-projects}"             # push here must be refused
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
    --set 'gatewayConfig.openshell\.gateway\.auth.allow_unauthenticated_users=true' \
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

step_t2() {   # pi inside a sandbox talks to Claude through the proxy; agent never sees the token
  say "T2 sandbox from the worker image with the anthropic-sub provider"
  os sandbox create --name pi-spike --from "$IMAGE" --provider anthropic-sub --detach -- sleep infinity
  os policy update pi-spike --rule-name npm --binary /usr/local/bin/node \
    --add-endpoint registry.npmjs.org:443:read-only:rest:enforce --wait
  sx 'mkdir -p /sandbox/agent /sandbox/ext /sandbox/work'
  os sandbox upload pi-spike ./openshell-oauth.ts /sandbox/ext/
  sx 'printf "%s" "{\"packages\":[\"npm:@gotgenes/pi-anthropic-auth\"],\"extensions\":[\"/sandbox/ext/openshell-oauth.ts\"]}" > /sandbox/agent/settings.json'
  local run="cd /sandbox/work && PI_CODING_AGENT_DIR=/sandbox/agent ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-openshell $PI --no-session --model anthropic/claude-haiku-5-5"
  say "T2a a reply comes back"
  sx "$run -p 'Reply with exactly: OPENSHELL-OK'" | tee /dev/stderr | grep -q OPENSHELL-OK && pass "T2a reply through proxy" || fail "T2a"
  say "T2b streaming: deltas arrive spread over time"
  sx "$run --mode json 'Count from 1 to 60, one number per line.' | node -e '
    let n=0,a=0,b=0; require(\"readline\").createInterface({input:process.stdin}).on(\"line\",l=>{ if(l.includes(\"text_delta\")){ const t=Date.now(); a||=t; b=t; n++; } }).on(\"close\",()=>console.log(n>5&&b-a>500?\"PASS  T2b streamed\":\"FAIL  T2b\",n,\"deltas over\",b-a,\"ms\"))'"
  say "T2c the agent sees only a placeholder"
  sx 'v="$OPENSHELL_ANTHROPIC_PLACEHOLDER"; case "$v" in *openshell:resolve:env:*) echo "PASS  T2c placeholder only";; *) echo "FAIL  T2c";; esac; env | grep -q "sk-ant-oat01-[A-Za-z0-9_-]\{30\}" && echo "FAIL  real token in env" || true'
}

step_t3() {   # egress is deny-by-default
  say "T3 egress"
  sx 'node -e "fetch(\"https://example.com\").then(r=>console.log(\"FAIL  T3 example.com reachable\",r.status)).catch(e=>console.log(\"PASS  T3 example.com denied:\",e.cause?.code||e.message))"'
  sx 'curl -sS -m 10 -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models || echo "PASS  T3 curl (not an allowed binary) denied"'
}

step_t4() {   # GitHub: clone + push to one repo only
  say "T4 GitHub provider (your gh token lives only in the gateway for this spike)"
  os provider create --name gh-spike --type github --credential "GITHUB_TOKEN=$(gh auth token)"
  os sandbox provider attach pi-spike gh-spike --wait
  os policy update pi-spike --rule-name spike_push --binary /usr/bin/git --binary /usr/lib/git-core/git-remote-https \
    --add-endpoint github.com:443:read-only:rest:enforce --wait
  os policy update pi-spike --rule-name spike_push --binary /usr/bin/git --binary /usr/lib/git-core/git-remote-https \
    --add-allow "github.com:443:POST:/$SCRATCH_REPO.git/git-upload-pack" \
    --add-allow "github.com:443:POST:/$SCRATCH_REPO.git/git-receive-pack" --wait
  sx 'git config --global user.name spike && git config --global user.email spike@example.invalid &&
      git config --global credential.helper "!f(){ echo username=x-access-token; echo \"password=$GITHUB_TOKEN\"; }; f"'
  sx "cd /sandbox/work && rm -rf s && git clone -q https://github.com/$SCRATCH_REPO s && cd s && date > spike.txt && git add . && git commit -qm spike && git push -q origin HEAD:spike-allowed && echo 'PASS  T4a push to scratch repo'" || fail "T4a"
  sx "cd /sandbox/work/s && git push -q https://github.com/$DENY_REPO HEAD:refs/heads/openshell-spike-deny-test 2>&1 | tail -2; echo '(expect a policy denial above)'"
  echo "If T4b printed no denial, delete branch openshell-spike-deny-test on $DENY_REPO now."
}

step_t5() {   # a pi-web worker as a sandbox: exposed port, disk kept across stop/start
  say "T5 worker image as a long-running sandbox"
  os sandbox create --name worker-spike --from "$IMAGE" --expose 3141 --detach \
    --env PORT=3141 --env PI_WEB_MODE=real --env HOST=127.0.0.1 -- node /app/server/index.js
  os sandbox get worker-spike -o json | tee /tmp/worker-spike.json >/dev/null || true
  echo "Open the service URL printed above (or in 'openshell sandbox get worker-spike') + /api/health; expect 200."
  os sandbox exec -n worker-spike --no-login-shell -- sh -c 'echo kept > /sandbox/persist.txt'
  os sandbox stop worker-spike && os sandbox start worker-spike
  os sandbox exec -n worker-spike --no-login-shell -- cat /sandbox/persist.txt | grep -q kept && pass "T5 /sandbox kept across stop/start" || fail "T5"
}

step_teardown() {
  say "teardown"
  os sandbox delete pi-spike worker-spike || true
  os provider delete anthropic-sub gh-spike || true
  helm --kube-context "$CTX" uninstall openshell -n "$NS" || true
  k delete namespace "$NS" --wait=false || true
  k delete -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$SANDBOX_CRD_VERSION/sandbox.yaml" || true
  os gateway remove spike || true
  echo "Also: delete $SCRATCH_REPO; the dedicated Anthropic login died with the gateway database."
}

"step_${1:?usage: ./run.sh <cli|install|connect|t1|t2|t3|t4|t5|teardown>}"
