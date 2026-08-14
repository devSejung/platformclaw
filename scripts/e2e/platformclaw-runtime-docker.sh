#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/docker/platformclaw-runtime/compose.yaml"
smoke_compose_file="$repo_root/docker/platformclaw-runtime/compose.smoke.yaml"
work_dir="$(mktemp -d)"
project_name="platformclaw-smoke-$$"
compose=(docker compose --project-name "$project_name" -f "$compose_file" -f "$smoke_compose_file")

dump_logs() {
  "${compose[@]}" ps || true
  "${compose[@]}" logs --no-color --tail 200 || true
}

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
  local status=$?
  if [[ $status -ne 0 ]]; then
    dump_logs
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  cleanup_work_dir
  return "$status"
}
trap cleanup EXIT

if [[ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" != "1" ]]; then
  node "$repo_root/scripts/platformclaw-build.mjs" --allow-dirty --no-export
fi

version="$(node -p "require('$repo_root/package.json').version")"
export PLATFORMCLAW_IMAGE="${PLATFORMCLAW_RUNTIME_IMAGE:-platformclaw:$version}"
export PLATFORMCLAW_SANDBOX_IMAGE="${PLATFORMCLAW_SANDBOX_IMAGE:-platformclaw-sandbox:$version}"
export PLATFORMCLAW_RUNTIME_UID=1000
export PLATFORMCLAW_RUNTIME_GID=1000
export PLATFORMCLAW_DEPLOY_ROOT="$work_dir/platformclaw"
export PLATFORMCLAW_DEPLOY_HOST_ROOT="$PLATFORMCLAW_DEPLOY_ROOT"
export PLATFORMCLAW_CREDENTIAL_BROKER_VOLUME_NAME="$project_name-credential-broker-1000-1000"
export PLATFORMCLAW_REPO_ROOT="$repo_root"
export PLATFORMCLAW_SANDBOX_DOCKER_RUNTIME_DIR="$work_dir/unused-sandbox-docker-runtime"
export PLATFORMCLAW_SMOKE_WORKSPACE_DIR="$PLATFORMCLAW_DEPLOY_ROOT/data/workspaces"
export PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR="$work_dir/platformclaw-sandbox.tar"
mkdir -p \
  "$PLATFORMCLAW_DEPLOY_ROOT/data/gateway-home/.openclaw" \
  "$PLATFORMCLAW_DEPLOY_ROOT/data/control" \
  "$PLATFORMCLAW_SANDBOX_DOCKER_RUNTIME_DIR" \
  "$PLATFORMCLAW_SMOKE_WORKSPACE_DIR"
# Synthetic smoke state contains no secrets. World-write avoids assuming the
# Linux CI caller, Gateway UID, and nested rootless UID namespace are identical.
chmod 0777 \
  "$PLATFORMCLAW_DEPLOY_ROOT" \
  "$PLATFORMCLAW_DEPLOY_ROOT/data" \
  "$PLATFORMCLAW_DEPLOY_ROOT/data/gateway-home" \
  "$PLATFORMCLAW_DEPLOY_ROOT/data/gateway-home/.openclaw" \
  "$PLATFORMCLAW_DEPLOY_ROOT/data/control" \
  "$PLATFORMCLAW_SMOKE_WORKSPACE_DIR"
docker save --output "$PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR" "$PLATFORMCLAW_SANDBOX_IMAGE"
# Docker creates archive output with an implementation-defined mode. The
# non-root image loader only needs immutable read access to this ephemeral file.
chmod 0444 "$PLATFORMCLAW_SMOKE_SANDBOX_IMAGE_TAR"
read -r PLATFORMCLAW_PUBLIC_PORT PLATFORMCLAW_EMPLOYEE_AUTH_MOCK_PORT < <(python3 - <<'PY'
import socket
with socket.socket() as public_sock, socket.socket() as employee_auth_sock:
    public_sock.bind(("127.0.0.1", 0))
    employee_auth_sock.bind(("127.0.0.1", 0))
    print(public_sock.getsockname()[1], employee_auth_sock.getsockname()[1])
PY
)
export PLATFORMCLAW_PUBLIC_PORT PLATFORMCLAW_EMPLOYEE_AUTH_MOCK_PORT
export PLATFORMCLAW_PUBLIC_ORIGIN="http://127.0.0.1:$PLATFORMCLAW_PUBLIC_PORT"
export PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL="http://127.0.0.1:18080/login"
export PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_URL="http://127.0.0.1:$PLATFORMCLAW_EMPLOYEE_AUTH_MOCK_PORT/adsso"
export PLATFORMCLAW_EMPLOYEE_AUTH_CA_FILE="$work_dir/employee-auth-ca.pem"
export PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE="$work_dir/employee-auth-adsso-secret"
export PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE="$work_dir/gateway-token"
export PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE="$work_dir/execution-service-token"
export PLATFORMCLAW_KNOX_CDEP_URL="http://127.0.0.1:18081/api/v1/platformclaw/knox/outbound/send"
export PLATFORMCLAW_KNOX_WEBHOOK_SECRET_SECRET_FILE="$work_dir/knox-webhook-secret"
export PLATFORMCLAW_KNOX_SERVICE_TOKEN_SECRET_FILE="$work_dir/knox-service-token"
export PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE="$work_dir/gateway-service-identity.pem"
export PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE="$work_dir/initial-admin-ids"
export PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE="$work_dir/ssh-credential-master-key"

ephemeral_probe="$(openssl rand -hex 32)"
printf '%s\n' "$ephemeral_probe" >"$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"
printf '%s\n' "admin.user" >"$PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_KNOX_WEBHOOK_SECRET_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_KNOX_SERVICE_TOKEN_SECRET_FILE"
openssl genpkey -algorithm ED25519 -out "$PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE"
openssl rand -base64 32 >"$PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE"
cp /etc/ssl/certs/ca-certificates.crt "$PLATFORMCLAW_EMPLOYEE_AUTH_CA_FILE"
credential_key_probe="$(tr -d '\r\n' <"$PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE")"
execution_service_probe="$(tr -d '\r\n' <"$PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE")"
# Compose bind-mounts these files without remapping ownership. The mktemp directory
# remains host-private; read-only file mode lets the non-root containers read them.
chmod 0444 "$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE" \
  "$PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE" \
  "$PLATFORMCLAW_KNOX_WEBHOOK_SECRET_SECRET_FILE" \
  "$PLATFORMCLAW_KNOX_SERVICE_TOKEN_SECRET_FILE" \
  "$PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE" \
  "$PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE" \
  "$PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE" \
  "$PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE" \
  "$PLATFORMCLAW_EMPLOYEE_AUTH_CA_FILE"

echo "==> Starting PlatformClaw runtime smoke"
if ! "${compose[@]}" up --detach --wait --wait-timeout 180; then
  dump_logs
  exit 1
fi

origin="$PLATFORMCLAW_PUBLIC_ORIGIN"
cookie_jar="$work_dir/cookies.txt"
login_response="$work_dir/login.json"
session_response="$work_dir/session.json"
sso_cookie_jar="$work_dir/sso-cookies.txt"
sso_session_response="$work_dir/sso-session.json"
app_document="$work_dir/app.html"
admin_cookie_jar="$work_dir/admin-cookies.txt"
admin_response="$work_dir/admin-login.json"
vm_admin_response="$work_dir/vm-admin.json"
execution_response="$work_dir/execution.json"
safeconnect_host_key="$work_dir/safeconnect-host-key.json"
safeconnect_boundary_log="$work_dir/safeconnect-boundary.jsonl"

curl --fail --silent --show-error "$origin/platformclaw/health" |
  jq -e '.ready == true' >/dev/null
curl --fail --silent --show-error "$origin/platformclaw/login" |
  grep -q 'data-platformclaw-login'

curl --fail --location --silent --show-error \
  --cookie-jar "$sso_cookie_jar" \
  "$origin/employee/auth/adsso?returnTo=%2Fplatformclaw%2Fapp%2Fchat" >/dev/null
curl --fail --silent --show-error \
  --cookie "$sso_cookie_jar" \
  "$origin/platformclaw/api/auth/session" >"$sso_session_response"
jq -e '.authenticated == true and .agent.agentId == "person_one"' \
  "$sso_session_response" >/dev/null

curl --fail --silent --show-error \
  --cookie-jar "$cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "@$repo_root/scripts/e2e/fixtures/platformclaw-login.json" \
  "$origin/platformclaw/api/auth/login" >"$login_response"
jq -e '.authenticated == true and .agent.agentId == "person_one"' \
  "$login_response" >/dev/null

curl --fail --silent --show-error \
  --cookie-jar "$admin_cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary '{"identifier":"admin.user","password":"test-password"}' \
  "$origin/platformclaw/api/auth/login" >"$admin_response"
jq -e '.authenticated == true and .user.globalRole == "admin"' \
  "$admin_response" >/dev/null

MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T fake-safeconnect cat /state/host-key.json >"$safeconnect_host_key"
jq -e \
  '.algorithm == "ssh-ed25519" and (.publicKey | length > 40) and (.fingerprint | startswith("SHA256:"))' \
  "$safeconnect_host_key" >/dev/null

admin_vm_mutation() {
  local payload="$1"
  curl --fail --silent --show-error \
    --cookie "$admin_cookie_jar" \
    --header "Origin: $origin" \
    --header "Content-Type: application/json" \
    --data-binary "$payload" \
    "$origin/platformclaw/api/admin/vm" >"$vm_admin_response"
}

admin_vm_mutation '{
  "action": "endpoints",
  "label": "Fake SafeConnect",
  "host": "safeconnect.platformclaw.test",
  "port": 44422,
  "adDomain": "samsungds.net"
}'
endpoint_id="$(jq -er '.endpoints[] | select(.host == "safeconnect.platformclaw.test") | .id' \
  "$vm_admin_response")"
admin_vm_mutation "$(jq -cn \
  --arg endpointId "$endpoint_id" \
  --arg algorithm "$(jq -r .algorithm "$safeconnect_host_key")" \
  --arg publicKey "$(jq -r .publicKey "$safeconnect_host_key")" \
  --arg fingerprint "$(jq -r .fingerprint "$safeconnect_host_key")" \
  '{action:"host-key", endpointId:$endpointId, algorithm:$algorithm, publicKey:$publicKey, fingerprint:$fingerprint}')"
admin_vm_mutation "$(jq -cn \
  --arg endpointId "$endpoint_id" \
  '{action:"hosts", endpointId:$endpointId, label:"Development VM", targetAddress:"10.0.0.10"}')"
vm_host_id="$(jq -er '.hosts[] | select(.targetAddress == "10.0.0.10") | .id' \
  "$vm_admin_response")"
bad_credential_status="$(curl --silent --show-error --output "$execution_response" \
  --write-out '%{http_code}' \
  --cookie "$cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "$(jq -cn --arg vmHostId "$vm_host_id" \
    '{vmHostId:$vmHostId, linuxAccount:"person_one", password:"wrong-fixture-password"}')" \
  "$origin/platformclaw/api/execution/selection")"
if [[ "$bad_credential_status" != "422" ]]; then
  echo "Expected rejected SafeConnect credential to return 422, got $bad_credential_status" >&2
  cat "$execution_response" >&2
  exit 1
fi
jq -e '.error == "AD password was not accepted"' "$execution_response" >/dev/null

selection_status="$(curl --silent --show-error --output "$execution_response" \
  --write-out '%{http_code}' \
  --cookie "$cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "$(jq -cn --arg vmHostId "$vm_host_id" \
    '{vmHostId:$vmHostId, linuxAccount:"person_one", password:"platformclaw-safeconnect-fixture-password"}')" \
  "$origin/platformclaw/api/execution/selection")"
if [[ "$selection_status" != "200" ]]; then
  echo "Expected accepted SafeConnect selection to return 200, got $selection_status" >&2
  cat "$execution_response" >&2
  exit 1
fi
jq -e \
  '.credentialStatus == "current" and .assignment.status == "ready" and .assignment.remoteHomeDir == "/users/person_one" and .assignment.remoteWorkspaceDir == "/users/person_one/.platformclaw/workspace"' \
  "$execution_response" >/dev/null

target_revision="$(jq -er .targetRevision "$execution_response")"
curl --fail --silent --show-error \
  --cookie "$cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "$(jq -cn --argjson expectedRevision "$target_revision" \
    '{target:"assigned_vm", expectedRevision:$expectedRevision}')" \
  "$origin/platformclaw/api/execution/target" >"$execution_response"
jq -e '.activeTarget == "assigned_vm"' "$execution_response" >/dev/null

curl --fail --silent --show-error \
  --cookie "$cookie_jar" \
  --header "Origin: $origin" \
  --request POST \
  "$origin/platformclaw/api/execution/test" >"$execution_response"
jq -e \
  '.activeTarget == "assigned_vm" and .credentialStatus == "current" and .assignment.status == "ready"' \
  "$execution_response" >/dev/null

safeconnect_algorithm="$(jq -r .algorithm "$safeconnect_host_key")"
safeconnect_public_key="$(jq -r .publicKey "$safeconnect_host_key")"
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T \
  --env "SAFECONNECT_ALGORITHM=$safeconnect_algorithm" \
  --env "SAFECONNECT_PUBLIC_KEY=$safeconnect_public_key" \
  openclaw-gateway bash -ceu '
    probe_dir="$(mktemp -d)"
    trap '\''rm -rf "$probe_dir"'\'' EXIT
    printf '\''[safeconnect.platformclaw.test]:44422 %s %s\n'\'' \
      "$SAFECONNECT_ALGORITHM" "$SAFECONNECT_PUBLIC_KEY" >"$probe_dir/known_hosts"
    ssh_args=(
      -p 44422
      -o BatchMode=no
      -o PreferredAuthentications=keyboard-interactive
      -o KbdInteractiveAuthentication=yes
      -o PasswordAuthentication=no
      -o NumberOfPasswordPrompts=1
      -o StrictHostKeyChecking=yes
      -o UserKnownHostsFile="$probe_dir/known_hosts"
      -o GlobalKnownHostsFile=/dev/null
    )
    target="samsungds.net\\person.one+person_one+10.0.0.10@safeconnect.platformclaw.test"
    printf platformclaw-safeconnect-stream | {
      exec 3<<<"platformclaw-safeconnect-fixture-password"
      sshpass -d 3 ssh "${ssh_args[@]}" "$target" '\''cat > "$HOME/.platformclaw/e2e-stream"'\''
    }
    exec 3<<<"platformclaw-safeconnect-fixture-password"
    result="$(sshpass -d 3 ssh "${ssh_args[@]}" "$target" \
      '\''cat "$HOME/.platformclaw/e2e-stream" && rm "$HOME/.platformclaw/e2e-stream"'\'')"
    [[ "$result" == platformclaw-safeconnect-stream ]]
  '

MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T fake-safeconnect cat /state/boundary.jsonl >"$safeconnect_boundary_log"
jq -se '
  (map(select(.event == "authentication_finished" and .accepted == false)) | length) >= 1 and
  (map(select(.event == "authentication_finished" and .accepted == true)) | length) >= 4 and
  (map(select(.event == "command_finished" and .linuxAccount == "person_one" and .exitStatus == 0)) | length) >= 4
' "$safeconnect_boundary_log" >/dev/null
if grep -Fq "platformclaw-safeconnect-fixture-password" "$safeconnect_boundary_log"; then
  echo "SafeConnect password leaked into fixture boundary logs" >&2
  exit 1
fi

sandbox_container="platformclaw-smoke-sandbox-$RANDOM"
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T openclaw-gateway docker run --detach --rm \
  --name "$sandbox_container" \
  --label openclaw.sandbox=1 \
  --network bridge \
  --user 0:0 \
  --volume "$PLATFORMCLAW_DEPLOY_ROOT/data/workspaces/person_one:/workspace" \
  "$PLATFORMCLAW_SANDBOX_IMAGE" sleep infinity >/dev/null
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T openclaw-gateway docker inspect \
  --format '{{.HostConfig.NetworkMode}}' "$sandbox_container" | grep -qx bridge
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T openclaw-gateway docker inspect \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' \
  "$sandbox_container" | grep -Fq "$PLATFORMCLAW_DEPLOY_ROOT/data/workspaces/person_one -> /workspace"
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T openclaw-gateway docker exec "$sandbox_container" \
  bash -ceu 'printf sandbox-ok > /workspace/.platformclaw-sandbox-smoke'
grep -qx sandbox-ok "$PLATFORMCLAW_SMOKE_WORKSPACE_DIR/person_one/.platformclaw-sandbox-smoke"
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T openclaw-gateway docker rm --force "$sandbox_container" >/dev/null

MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T platformclaw-control node --input-type=module -e '
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
  if (
    body.kind !== "assigned_vm" ||
    body.agentId !== "person_one" ||
    body.linuxAccount !== "person_one" ||
    body.remoteWorkspaceDir !== "/users/person_one/.platformclaw/workspace"
  ) {
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
curl --fail --silent --show-error \
  --cookie "$cookie_jar" \
  --header "Origin: $origin" \
  --request POST \
  "$origin/platformclaw/api/execution/test" >"$execution_response"
jq -e \
  '.activeTarget == "assigned_vm" and .credentialStatus == "current" and .assignment.status == "ready"' \
  "$execution_response" >/dev/null

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
if grep -Fq "platformclaw-safeconnect-fixture-password" <<<"$runtime_logs"; then
  echo "SafeConnect password leaked into runtime logs" >&2
  exit 1
fi

echo "PlatformClaw runtime Docker smoke passed"
