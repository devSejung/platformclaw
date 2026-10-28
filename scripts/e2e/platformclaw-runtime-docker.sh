#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/docker/platformclaw-runtime/compose.yaml"
smoke_compose_file="$repo_root/docker/platformclaw-runtime/compose.smoke.yaml"
work_dir="$(mktemp -d)"
project_name="platformclaw-smoke-$$"
compose=(docker compose --project-name "$project_name" --profile skillhub -f "$compose_file" -f "$smoke_compose_file")

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
  "$PLATFORMCLAW_DEPLOY_ROOT/secrets" \
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
export PLATFORMCLAW_SKILL_HUB_ENABLED=true
export PLATFORMCLAW_SKILL_HUB_SERVER_IMAGE=platformclaw-skillhub-server:6e133c006e49cb1217a0ba75
export PLATFORMCLAW_SKILL_HUB_SCANNER_IMAGE=platformclaw-skillhub-scanner:6e133c006e49
export PLATFORMCLAW_SKILL_HUB_POSTGRES_IMAGE=platformclaw-skillhub-postgres:44c4ee9810ef
export PLATFORMCLAW_SKILL_HUB_REDIS_IMAGE=platformclaw-skillhub-redis:e7723ff73d96
export PLATFORMCLAW_SKILL_HUB_URL=http://skillhub.platformclaw.local:8080
export PLATFORMCLAW_SKILL_HUB_TOKEN_FILE=/run/secrets/platformclaw_skill_hub_token
export PLATFORMCLAW_SKILL_HUB_BOOTSTRAP_PASSWORD_FILE=/run/secrets/platformclaw_skill_hub_bootstrap_password
export PLATFORMCLAW_SKILL_HUB_NAMESPACES=global=all
export PLATFORMCLAW_SKILL_HUB_MAX_PACKAGE_BYTES=524288000
skillhub_token_file="$PLATFORMCLAW_DEPLOY_ROOT/secrets/skillhub-token"
skillhub_postgres_password_file="$PLATFORMCLAW_DEPLOY_ROOT/secrets/skillhub-postgres-password"
skillhub_cookie_secret_file="$PLATFORMCLAW_DEPLOY_ROOT/secrets/skillhub-cookie-secret"
skillhub_bootstrap_password_file="$PLATFORMCLAW_DEPLOY_ROOT/secrets/skillhub-bootstrap-password"

ephemeral_probe="$(openssl rand -hex 32)"
printf '%s\n' "$ephemeral_probe" >"$PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE"
printf '%s\n' "admin.user" >"$PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_KNOX_WEBHOOK_SECRET_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_KNOX_SERVICE_TOKEN_SECRET_FILE"
openssl genpkey -algorithm ED25519 -out "$PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE"
openssl rand -base64 32 >"$PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE"
openssl rand -hex 32 >"$PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE"
touch "$skillhub_token_file"
openssl rand -hex 32 >"$skillhub_postgres_password_file"
openssl rand -hex 32 >"$skillhub_cookie_secret_file"
openssl rand -base64 36 >"$skillhub_bootstrap_password_file"
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

# Production keeps SkillHub secrets owner-only. Reproduce that ownership here
# so the smoke catches a server image that silently runs under a different UID.
docker run --rm --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --security-opt no-new-privileges:true \
  --volume "$PLATFORMCLAW_DEPLOY_ROOT/secrets:/work" --entrypoint sh "$PLATFORMCLAW_IMAGE" -ceu \
  'chown 1000:1000 /work/skillhub-* && chmod 0400 /work/skillhub-* && chmod 0600 /work/skillhub-token'

echo "==> Starting and bootstrapping embedded SkillHub"
if ! "${compose[@]}" up --detach --wait --wait-timeout 180 skillhub-server; then
  dump_logs
  exit 1
fi
docker run --rm --network "${project_name}_platformclaw-skillhub" --read-only \
  --user "$PLATFORMCLAW_RUNTIME_UID:$PLATFORMCLAW_RUNTIME_GID" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --env SKILLHUB_BASE_URL=http://skillhub.platformclaw.local:8080 \
  --env "SKILLHUB_NAMESPACES=$PLATFORMCLAW_SKILL_HUB_NAMESPACES" \
  --env SKILLHUB_CREATE_TOKEN=true \
  --env SKILLHUB_BOOTSTRAP_PASSWORD_FILE=/run/secrets/bootstrap-password \
  --env SKILLHUB_TOKEN_OUTPUT_FILE=/run/secrets/control-token \
  --volume "$skillhub_bootstrap_password_file:/run/secrets/bootstrap-password:ro" \
  --volume "$skillhub_token_file:/run/secrets/control-token" \
  --volume "$repo_root/docker/platformclaw-runtime/bootstrap-skillhub.mjs:/opt/platformclaw/bootstrap-skillhub.mjs:ro" \
  --entrypoint node "$PLATFORMCLAW_IMAGE" /opt/platformclaw/bootstrap-skillhub.mjs

echo "==> Starting PlatformClaw runtime smoke"
if ! "${compose[@]}" up --detach --wait --wait-timeout 180; then
  dump_logs
  exit 1
fi

echo "==> Checking SafeConnect streaming and disconnect cleanup"
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T fake-safeconnect python /fixture/test_server.py

origin="$PLATFORMCLAW_PUBLIC_ORIGIN"
cookie_jar="$work_dir/cookies.txt"
login_response="$work_dir/login.json"
session_response="$work_dir/session.json"
sso_cookie_jar="$work_dir/sso-cookies.txt"
sso_flow_response="$work_dir/sso-flow-response.txt"
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

if ! curl --fail-with-body --location --silent --show-error \
  --cookie-jar "$sso_cookie_jar" \
  --output "$sso_flow_response" \
  "$origin/employee/auth/adsso?returnTo=%2Fplatformclaw%2Fapp%2Fchat"; then
  cat "$sso_flow_response" >&2
  exit 1
fi
curl --fail --silent --show-error \
  --cookie "$sso_cookie_jar" \
  "$origin/platformclaw/api/auth/session" >"$sso_session_response"
jq -e '.authenticated == true and .user.accountId == "person.one"' \
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
for vm_number in 2 3; do
  admin_vm_mutation "$(jq -cn --arg endpointId "$endpoint_id" \
    --arg hostLabel "Development VM $vm_number" --arg address "10.0.0.$((vm_number * 10))" \
    '{action:"hosts", endpointId:$endpointId, label:$hostLabel, targetAddress:$address}')"
done
vm_host_two_id="$(jq -er '.hosts[] | select(.targetAddress == "10.0.0.20") | .id' "$vm_admin_response")"
vm_host_three_id="$(jq -er '.hosts[] | select(.targetAddress == "10.0.0.30") | .id' "$vm_admin_response")"
refresh_execution_settings() {
  curl --fail --silent --show-error --cookie "$cookie_jar" \
    "$origin/platformclaw/api/execution" >"$execution_response"
}
refresh_execution_settings
target_revision="$(jq -er .targetRevision "$execution_response")"
bad_credential_status="$(curl --silent --show-error --output "$execution_response" \
  --write-out '%{http_code}' \
  --cookie "$cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "$(jq -cn --arg vmHostId "$vm_host_id" --argjson expectedRevision "$target_revision" \
    '{vmHostId:$vmHostId, linuxAccount:"person_one", password:"wrong-fixture-password", expectedRevision:$expectedRevision}')" \
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
  --data-binary "$(jq -cn --arg vmHostId "$vm_host_id" --argjson expectedRevision "$target_revision" \
    '{vmHostId:$vmHostId, linuxAccount:"person_one", password:"platformclaw-safeconnect-fixture-password", expectedRevision:$expectedRevision}')" \
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
connection_one_id="$(jq -er --arg vmHostId "$vm_host_id" '.savedVms[] | select(.vmHostId == $vmHostId) | .id' "$execution_response")"
curl --fail --silent --show-error \
  --cookie "$cookie_jar" \
  --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "$(jq -cn --argjson expectedRevision "$target_revision" --arg connectionId "$connection_one_id" \
    '{target:"assigned_vm", connectionId:$connectionId, expectedRevision:$expectedRevision}')" \
  "$origin/platformclaw/api/execution/target" >"$execution_response"
jq -e '.activeTarget == "assigned_vm"' "$execution_response" >/dev/null

echo "==> Renaming an active SafeConnect endpoint without changing its authority"
endpoint_before="$(jq -c --arg id "$endpoint_id" '.endpoints[] | select(.id == $id) | del(.label, .updatedAt)' "$vm_admin_response")"
selection_before_rename="$(jq -c '{activeTarget,targetRevision,credentialStatus,assignment:(.assignment | del(.safeConnectLabel))}' "$execution_response")"
admin_vm_mutation "$(jq -cn --arg endpointId "$endpoint_id" \
  '{action:"rename-endpoint", endpointId:$endpointId, label:"Renamed active SafeConnect"}')"
jq -e --arg id "$endpoint_id" --argjson before "$endpoint_before" '
  (.endpoints[] | select(.id == $id)) as $endpoint |
  $endpoint.status == "active" and $endpoint.label == "Renamed active SafeConnect" and
  ($endpoint | del(.label, .updatedAt)) == $before and
  any(.auditEvents[]; .eventType == "safeconnect.endpoint.renamed" and .targetId == $id)
' "$vm_admin_response" >/dev/null
refresh_execution_settings
jq -e --argjson before "$selection_before_rename" '
  {activeTarget,targetRevision,credentialStatus,assignment:(.assignment | del(.safeConnectLabel))} == $before and
  .assignment.safeConnectLabel == "Renamed active SafeConnect" and
  all(.savedVms[]; .safeConnectLabel == "Renamed active SafeConnect")
' "$execution_response" >/dev/null
denied_rename_status="$(curl --silent --show-error --output "$work_dir/denied-rename.json" \
  --write-out '%{http_code}' --cookie "$cookie_jar" --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "$(jq -cn --arg endpointId "$endpoint_id" '{action:"rename-endpoint",endpointId:$endpointId,label:"Denied rename"}')" \
  "$origin/platformclaw/api/admin/vm")"
[[ "$denied_rename_status" == "403" ]]

register_vm() {
  local vm_host="$1" linux_account="$2" password="$3"
  refresh_execution_settings
  curl --fail --silent --show-error --cookie "$cookie_jar" \
    --header "Origin: $origin" --header "Content-Type: application/json" \
    --data-binary "$(jq -cn --arg vmHostId "$vm_host" --arg linuxAccount "$linux_account" \
      --arg password "$password" --argjson expectedRevision "$(jq -er .targetRevision "$execution_response")" \
      '{vmHostId:$vmHostId,linuxAccount:$linuxAccount,password:$password,expectedRevision:$expectedRevision}')" \
    "$origin/platformclaw/api/execution/selection" >"$execution_response"
  jq -e --arg account "$linux_account" '
    .activeTarget == "assigned_vm" and .assignment.linuxAccount == $account and
    .assignment.status == "ready" and .assignment.remoteHomeDir == ("/users/" + $account)
  ' "$execution_response" >/dev/null
}
save_coding_agent() {
  local executable="$1"
  curl --fail --silent --show-error --cookie "$cookie_jar" \
    --header "Origin: $origin" --header "Content-Type: application/json" \
    --data-binary "$(jq -cn --arg executablePath "$executable" \
      --argjson expectedRevision "$(jq -er .targetRevision "$execution_response")" \
      '{action:"save",expectedRevision:$expectedRevision,configuration:{agent:"codex",enabled:false,executablePath:$executablePath}}')" \
    "$origin/platformclaw/api/execution/coding-agent" >"$execution_response"
}
switch_work_location() {
  local target="$1" connection_id="${2:-}" account="${3:-}"
  refresh_execution_settings
  local previous_revision
  previous_revision="$(jq -er .targetRevision "$execution_response")"
  curl --fail --silent --show-error --cookie "$cookie_jar" \
    --header "Origin: $origin" --header "Content-Type: application/json" \
    --data-binary "$(jq -cn --arg target "$target" --arg connectionId "$connection_id" \
      --argjson expectedRevision "$previous_revision" \
      '{target:$target,expectedRevision:$expectedRevision} + (if $connectionId == "" then {} else {connectionId:$connectionId} end)')" \
    "$origin/platformclaw/api/execution/target" >"$execution_response"
  jq -e --arg target "$target" --arg account "$account" --argjson previous "$previous_revision" '
    .activeTarget == $target and .targetRevision > $previous and
    (if $target == "assigned_vm" then .assignment.linuxAccount == $account and .assignment.status == "ready" else true end)
  ' "$execution_response" >/dev/null
}
assert_coding_agent() {
  jq -e --arg executable "$1" '
    any(.codingAgents[]; .configuration.agent == "codex" and .configuration.executablePath == $executable)
  ' "$execution_response" >/dev/null
}

echo "==> Registering three isolated VM accounts with distinct credentials"
save_coding_agent /usr/local/bin/codex-vm1-fixture
register_vm "$vm_host_two_id" person_one_vm2 platformclaw-safeconnect-fixture-vm2-password
connection_two_id="$(jq -er --arg vmHostId "$vm_host_two_id" '.savedVms[] | select(.vmHostId == $vmHostId) | .id' "$execution_response")"
save_coding_agent /usr/local/bin/codex-vm2-fixture
register_vm "$vm_host_three_id" person_one_vm3 platformclaw-safeconnect-fixture-vm3-password
connection_three_id="$(jq -er --arg vmHostId "$vm_host_three_id" '.savedVms[] | select(.vmHostId == $vmHostId) | .id' "$execution_response")"
save_coding_agent /usr/local/bin/codex-vm3-fixture
jq -e '(.savedVms | length) == 3 and all(.savedVms[]; .status == "ready")' "$execution_response" >/dev/null

echo "==> Switching VM1 -> VM2 -> VM3 -> VM1 without Basic or supplied passwords"
for cycle in 1 2; do
  switch_work_location assigned_vm "$connection_one_id" person_one
  assert_coding_agent /usr/local/bin/codex-vm1-fixture
  switch_work_location assigned_vm "$connection_two_id" person_one_vm2
  assert_coding_agent /usr/local/bin/codex-vm2-fixture
  switch_work_location assigned_vm "$connection_three_id" person_one_vm3
  assert_coding_agent /usr/local/bin/codex-vm3-fixture
done
switch_work_location assigned_vm "$connection_one_id" person_one
switch_work_location platform_server
switch_work_location assigned_vm "$connection_two_id" person_one_vm2
switch_work_location assigned_vm "$connection_one_id" person_one
assert_coding_agent /usr/local/bin/codex-vm1-fixture

selection_before_failure="$(jq -c '{activeTarget,targetRevision,credentialStatus,assignment}' "$execution_response")"
reauth_status="$(curl --silent --show-error --output "$work_dir/failed-reauth.json" \
  --write-out '%{http_code}' --cookie "$cookie_jar" --header "Origin: $origin" \
  --header "Content-Type: application/json" \
  --data-binary "$(jq -cn --arg vmHostId "$vm_host_two_id" \
    --argjson expectedRevision "$(jq -er .targetRevision "$execution_response")" \
    '{vmHostId:$vmHostId,linuxAccount:"person_one_vm2",password:"wrong-fixture-password",expectedRevision:$expectedRevision}')" \
  "$origin/platformclaw/api/execution/selection")"
[[ "$reauth_status" == "422" ]]
refresh_execution_settings
jq -e --argjson before "$selection_before_failure" '
  {activeTarget,targetRevision,credentialStatus,assignment} == $before and (.savedVms | length) == 3
' "$execution_response" >/dev/null

echo "==> Restarting control plane and retaining saved VMs, current target, and host-key approval"
"${compose[@]}" restart platformclaw-control >/dev/null
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "$origin/platformclaw/health" 2>/dev/null | jq -e '.ready == true' >/dev/null; then
    break
  fi
  sleep 1
done
refresh_execution_settings
jq -e --argjson before "$selection_before_failure" '
  {activeTarget,targetRevision,credentialStatus,assignment} == $before and
  (.savedVms | length) == 3 and all(.savedVms[]; .safeConnectLabel == "Renamed active SafeConnect")
' "$execution_response" >/dev/null
assert_coding_agent /usr/local/bin/codex-vm1-fixture
curl --fail --silent --show-error --cookie "$admin_cookie_jar" \
  "$origin/platformclaw/api/admin/vm" >"$vm_admin_response"
jq -e --arg id "$endpoint_id" --argjson before "$endpoint_before" '
  (.endpoints[] | select(.id == $id)) as $endpoint |
  $endpoint.label == "Renamed active SafeConnect" and ($endpoint | del(.label,.updatedAt)) == $before
' "$vm_admin_response" >/dev/null

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
    # Match the production transport: OpenSSH rejects the SafeConnect domain
    # separator in command-line usernames, but accepts a literal User in config.
    safeconnect_user="samsungds.net\\person.one+person_one+10.0.0.10"
    printf '\''Host platformclaw-safeconnect\n  HostName safeconnect.platformclaw.test\n  User %s\n'\'' \
      "$safeconnect_user" >"$probe_dir/config"
    ssh_args=(
      -F "$probe_dir/config"
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
    target="platformclaw-safeconnect"
    printf platformclaw-safeconnect-stream | {
      exec 3<<<"platformclaw-safeconnect-fixture-password"
      sshpass -d 3 ssh "${ssh_args[@]}" "$target" '\''cat > "$HOME/.platformclaw/e2e-stream"'\''
    }
    exec 3<<<"platformclaw-safeconnect-fixture-password"
    result="$(sshpass -d 3 ssh "${ssh_args[@]}" "$target" \
      '\''cat "$HOME/.platformclaw/e2e-stream" && rm "$HOME/.platformclaw/e2e-stream"'\'')"
    [[ "$result" == platformclaw-safeconnect-stream ]]
    exec 3<<<"platformclaw-safeconnect-fixture-password"
    login_result="$(printf '\''%s\n'\'' \
      '\''printf "LOGIN:%s:%s\n" "$USER" "$PWD"'\'' exit | \
      sshpass -d 3 ssh -tt "${ssh_args[@]}" "$target" 2>/dev/null | tr -d '\''\r'\'')"
    grep -Fq "LOGIN:person_one:/users/person_one" <<<"$login_result"
  '

MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T fake-safeconnect cat /state/boundary.jsonl >"$safeconnect_boundary_log"
jq -se '
  (map(select(.event == "authentication_finished" and .accepted == false)) | length) >= 1 and
  (map(select(.event == "authentication_finished" and .accepted == true)) | length) >= 4 and
  (map(select(.event == "command_finished" and .linuxAccount == "person_one" and .exitStatus == 0)) | length) >= 4 and
  (map(select(.event == "login_shell_started" and .linuxAccount == "person_one")) | length) >= 1 and
  (map(select(.event == "command_finished" and .linuxAccount == "person_one_vm2" and .exitStatus == 0)) | length) >= 3 and
  (map(select(.event == "command_finished" and .linuxAccount == "person_one_vm3" and .exitStatus == 0)) | length) >= 3
' "$safeconnect_boundary_log" >/dev/null
if grep -Eq 'platformclaw-safeconnect-fixture(-vm[23])?-password' "$safeconnect_boundary_log"; then
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

wiki_status="$work_dir/wiki-status.txt"
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T openclaw-gateway \
  sh -ceu '
    export OPENCLAW_GATEWAY_TOKEN="$(tr -d "\r\n" </run/secrets/platformclaw_gateway_token)"
    exec openclaw wiki status --agent person_one
  ' >"$wiki_status"
grep -Fq 'Wiki vault mode: bridge' "$wiki_status"
grep -Fq 'Vault scope: agent (person_one)' "$wiki_status"
grep -Fq 'Render mode: native' "$wiki_status"

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

echo "==> Relogging in with all three saved VM registrations preserved"
curl --fail --silent --show-error --cookie-jar "$cookie_jar" \
  --header "Origin: $origin" --header "Content-Type: application/json" \
  --data-binary "@$repo_root/scripts/e2e/fixtures/platformclaw-login.json" \
  "$origin/platformclaw/api/auth/login" >"$login_response"
refresh_execution_settings
jq -e '(.savedVms | length) == 3 and .activeTarget == "assigned_vm" and .assignment.linuxAccount == "person_one"' \
  "$execution_response" >/dev/null
assert_coding_agent /usr/local/bin/codex-vm1-fixture
curl --fail --silent --show-error --cookie "$cookie_jar" \
  --header "Origin: $origin" --request POST "$origin/platformclaw/api/auth/logout" | jq -e '.ok == true' >/dev/null

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
if grep -Eq 'platformclaw-safeconnect-fixture(-vm[23])?-password' <<<"$runtime_logs"; then
  echo "SafeConnect password leaked into runtime logs" >&2
  exit 1
fi

echo "PlatformClaw runtime Docker smoke passed"
