#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/docker/platformclaw-runtime/compose.yaml"
smoke_compose_file="$repo_root/docker/platformclaw-runtime/compose.smoke.yaml"
work_dir="$(mktemp -d)"
project_name="platformclaw-smoke-$$"
compose=(docker compose --project-name "$project_name" -f "$compose_file" -f "$smoke_compose_file")

cleanup_work_dir() {
  if rm -rf "$work_dir" 2>/dev/null; then
    return
  fi

  # Rootless sandbox UID mappings can leave synthetic workspace files owned by
  # subordinate host UIDs. Delete only this mktemp payload through the host daemon.
  if [[ -n "${PLATFORMCLAW_IMAGE:-}" ]] && docker image inspect "$PLATFORMCLAW_IMAGE" >/dev/null 2>&1; then
    docker run --rm --network none --read-only --user 0:0 \
      --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true \
      --volume "$work_dir:/cleanup" \
      --entrypoint find "$PLATFORMCLAW_IMAGE" \
      /cleanup -mindepth 1 -depth -delete
  fi
  rm -rf "$work_dir"
}

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  cleanup_work_dir
}
trap cleanup EXIT

if [[ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" != "1" ]]; then
  node "$repo_root/scripts/platformclaw-build.mjs" --allow-dirty --no-export
fi

version="$(node -p "require('$repo_root/package.json').version")"
export PLATFORMCLAW_IMAGE="${PLATFORMCLAW_RUNTIME_IMAGE:-platformclaw:$version}"
export PLATFORMCLAW_SANDBOX_IMAGE="${PLATFORMCLAW_SANDBOX_IMAGE:-platformclaw-sandbox:$version}"
export PLATFORMCLAW_REPO_ROOT="$repo_root"
export PLATFORMCLAW_SANDBOX_DOCKER_RUNTIME_DIR="$work_dir/unused-sandbox-docker-runtime"
export PLATFORMCLAW_SMOKE_WORKSPACE_DIR="$work_dir/workspaces"
export PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR="$work_dir/platformclaw-sandbox.tar"
mkdir -p \
  "$PLATFORMCLAW_SANDBOX_DOCKER_RUNTIME_DIR" \
  "$PLATFORMCLAW_SMOKE_WORKSPACE_DIR"
# Synthetic smoke state contains no secrets. World-write avoids assuming the
# Linux CI caller, Gateway UID, and nested rootless UID namespace are identical.
chmod 0777 "$PLATFORMCLAW_SMOKE_WORKSPACE_DIR"
docker save --output "$PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR" "$PLATFORMCLAW_SANDBOX_IMAGE"
# Docker creates archive output with an implementation-defined mode. The
# non-root image loader only needs immutable read access to this ephemeral file.
chmod 0444 "$PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR"
export PLATFORMCLAW_PUBLIC_PORT="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
export PLATFORMCLAW_PUBLIC_ORIGIN="http://127.0.0.1:$PLATFORMCLAW_PUBLIC_PORT"
export PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL="http://127.0.0.1:18080/login"
export PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE="$work_dir/gateway-token"
export PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE="$work_dir/execution-service-token"
export PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE="$work_dir/initial-admin-ids"
export PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE="$work_dir/ssh-credential-master-key"

ephemeral_probe="$(openssl rand -hex 32)"
printf '%s\n' "$ephemeral_probe" >"$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"
printf '%s\n' "admin.user" >"$PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE"
openssl rand -base64 32 >"$PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE"
credential_key_probe="$(tr -d '\r\n' <"$PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE")"
execution_service_probe="$(tr -d '\r\n' <"$PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE")"
# Compose bind-mounts these files without remapping ownership. The mktemp directory
# remains host-private; read-only file mode lets the non-root containers read them.
chmod 0444 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE" \
  "$PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE" \
  "$PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE" \
  "$PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE"

dump_logs() {
  "${compose[@]}" ps || true
  "${compose[@]}" logs --no-color --tail 200 || true
}

echo "==> Starting PlatformClaw runtime smoke"
if ! "${compose[@]}" up --detach --wait --wait-timeout 180; then
  dump_logs
  exit 1
fi

origin="$PLATFORMCLAW_PUBLIC_ORIGIN"
cookie_jar="$work_dir/cookies.txt"
login_response="$work_dir/login.json"
session_response="$work_dir/session.json"
app_document="$work_dir/app.html"

curl --fail --silent --show-error "$origin/platformclaw/health" |
  jq -e '.ready == true' >/dev/null
curl --fail --silent --show-error "$origin/platformclaw/login" |
  grep -q 'data-platformclaw-login'

curl --fail --silent --show-error \
  --cookie-jar "$cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "@$repo_root/scripts/e2e/fixtures/platformclaw-login.json" \
  "$origin/platformclaw/api/auth/login" >"$login_response"
jq -e '.authenticated == true and .agent.agentId == "person_one"' \
  "$login_response" >/dev/null

sandbox_container="platformclaw-smoke-sandbox-$RANDOM"
"${compose[@]}" exec -T openclaw-gateway docker run --detach --rm \
  --name "$sandbox_container" \
  --label openclaw.sandbox=1 \
  --network bridge \
  --user 0:0 \
  --volume /var/lib/platformclaw/workspaces/person_one:/workspace \
  "$PLATFORMCLAW_SANDBOX_IMAGE" sleep infinity >/dev/null
"${compose[@]}" exec -T openclaw-gateway docker inspect \
  --format '{{.HostConfig.NetworkMode}}' "$sandbox_container" | grep -qx bridge
"${compose[@]}" exec -T openclaw-gateway docker inspect \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  "$sandbox_container" | grep -q '/var/lib/platformclaw/workspaces/person_one -> /workspace'
"${compose[@]}" exec -T openclaw-gateway docker exec "$sandbox_container" \
  bash -ceu 'printf sandbox-ok > /workspace/.platformclaw-sandbox-smoke'
grep -qx sandbox-ok "$PLATFORMCLAW_SMOKE_WORKSPACE_DIR/person_one/.platformclaw-sandbox-smoke"
"${compose[@]}" exec -T openclaw-gateway docker rm --force "$sandbox_container" >/dev/null

"${compose[@]}" exec -T platformclaw-control node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import {
    deriveExecutionHandoffAddress,
    ExecutionHandoffClient,
  } from "/app/packages/platformclaw-control-plane/dist/index.mjs";
  const token = readFileSync("/run/secrets/platformclaw_execution_service_token", "utf8").trim();
  const broker = "/run/platformclaw-credential-broker/credential.sock";
  const body = await new ExecutionHandoffClient(
    deriveExecutionHandoffAddress(broker),
    token,
  ).resolveTarget("person_one");
  if (body.kind !== "platform_server" || body.agentId !== "person_one") {
      throw new Error("unexpected execution handoff response");
    }
'

curl --fail --silent --show-error --cookie "$cookie_jar" \
  "$origin/platformclaw/api/auth/session" >"$session_response"
jq -e '.authenticated == true and .user.accountId == "person.one"' \
  "$session_response" >/dev/null

curl --fail --silent --show-error --cookie "$cookie_jar" \
  "$origin/platformclaw/app/chat" >"$app_document"
grep -q 'platformclaw-web-descriptor' "$app_document"

if [[ -n "$("${compose[@]}" port openclaw-gateway 18789 2>/dev/null || true)" ]]; then
  echo "Gateway port 18789 must not be published" >&2
  exit 1
fi

echo "==> Restarting private Gateway"
"${compose[@]}" restart openclaw-gateway >/dev/null
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "$origin/platformclaw/health" 2>/dev/null |
    jq -e '.ready == true' >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error "$origin/platformclaw/health" |
  jq -e '.ready == true' >/dev/null

curl --fail --silent --show-error --cookie "$cookie_jar" \
  --header "Origin: $origin" --request POST \
  "$origin/platformclaw/api/auth/logout" |
  jq -e '.ok == true' >/dev/null
curl --fail --silent --show-error --cookie "$cookie_jar" \
  "$origin/platformclaw/api/auth/session" |
  jq -e '.authenticated == false' >/dev/null

runtime_logs="$("${compose[@]}" logs --no-color)"
if grep -Fq "$ephemeral_probe" <<<"$runtime_logs"; then
  echo "Gateway token leaked into container logs" >&2
  exit 1
fi
if grep -Fq "$ephemeral_probe" "$app_document"; then
  echo "Gateway token leaked into browser document" >&2
  exit 1
fi
if grep -Fq "$credential_key_probe" <<<"$runtime_logs"; then
  echo "SSH credential master key leaked into container logs" >&2
  exit 1
fi
if grep -Fq "$credential_key_probe" "$app_document"; then
  echo "SSH credential master key leaked into browser document" >&2
  exit 1
fi
if grep -Fq "$execution_service_probe" <<<"$runtime_logs"; then
  echo "Execution service token leaked into container logs" >&2
  exit 1
fi
if grep -Fq "$execution_service_probe" "$app_document"; then
  echo "Execution service token leaked into browser document" >&2
  exit 1
fi

echo "PlatformClaw runtime Docker smoke passed"
