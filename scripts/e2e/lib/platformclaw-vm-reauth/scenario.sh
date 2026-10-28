#!/usr/bin/env bash
# Sourced by the runtime Docker smoke: uses its isolated Compose project and state.

reauth_client() {
  MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T platformclaw-control \
    node /smoke/vm-reauth/client.mjs "$@"
}

reauth_fixture() {
  MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T fake-safeconnect \
    python /fixture/reauth/configure.py "$1"
}

reauth_snapshot_boundary() {
  MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T fake-safeconnect \
    cat /state/boundary.jsonl >"$work_dir/reauth-boundary.jsonl"
}

reauth_credential_body() {
  jq -c --arg password "$1" '{password:$password,expectedRevision:.targetRevision,
    expectedCredentialRevision:.credentialRevision,expectedAllocationId:.assignment.id}' \
    "$execution_response"
}

reauth_update_password() {
  local password="$1" expected_status="$2" payload actual_status
  payload="$(reauth_credential_body "$password")"
  actual_status="$(curl --silent --show-error --output "$work_dir/reauth-update.json" \
    --write-out '%{http_code}' --cookie "$cookie_jar" --header "Origin: $origin" \
    --header "Content-Type: application/json" --data-binary "$payload" \
    "$origin/platformclaw/api/execution/credential")"
  if [[ "$actual_status" != "$expected_status" ]]; then
    echo "VM recovery expected HTTP $expected_status, received $actual_status" >&2
    cat "$work_dir/reauth-update.json" >&2
    return 1
  fi
  refresh_execution_settings
}

echo "==> Recovering a real SSH lease after synthetic AD password rotation"
reauth_client ready
reauth_client target >"$work_dir/reauth-old-target.json"
refresh_execution_settings
reauth_old_credential_revision="$(jq -er .credentialRevision "$execution_response")"
reauth_other_registrations="$(jq -c --arg id "$connection_one_id" \
  '[.savedVms[] | select(.id != $id)]' "$execution_response")"
reauth_fixture rotate

# Confirm the fixture reaches the real OpenSSH final-rejection exit, not only
# sshpass's repeated-prompt exit 5. The production lease must detect this too.
MSYS_NO_PATHCONV=1 "${compose[@]}" exec -T openclaw-gateway \
  node /smoke/vm-reauth/client.mjs raw-final-rejection <"$work_dir/reauth-old-target.json"
reauth_snapshot_boundary
reauth_commands_before="$(jq -s '[.[] | select(.event == "command_started" and .linuxAccount == "person_one")] | length' \
  "$work_dir/reauth-boundary.jsonl")"
reauth_rejections_before="$(jq -s '[.[] | select(.event == "authentication_finished" and .accepted == false)] | length' \
  "$work_dir/reauth-boundary.jsonl")"

# Retire only this smoke project's warm master. Never touch operator services.
"${compose[@]}" restart openclaw-gateway >/dev/null
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "$origin/platformclaw/health" 2>/dev/null |
    jq -e '.ready == true' >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error "$origin/platformclaw/health" | jq -e '.ready == true' >/dev/null
reauth_client rejected
refresh_execution_settings
jq -e --arg id "$connection_one_id" --argjson revision "$reauth_old_credential_revision" '
  .activeTarget == "assigned_vm" and .credentialStatus == "update_required" and
  .credentialRevision == $revision and (.credentialLastAuthFailureAt | type == "number") and
  .assignment.status == "connection_required" and .assignment.failureCode == "vm_authentication_failed" and
  any(.savedVms[]; .id == $id and .active and .status == "connection_required" and .failureCode == "vm_authentication_failed")
' "$execution_response" >/dev/null
reauth_snapshot_boundary
jq -se --argjson commands "$reauth_commands_before" --argjson rejected "$reauth_rejections_before" '
  ([.[] | select(.event == "command_started" and .linuxAccount == "person_one")] | length) == $commands and
  ([.[] | select(.event == "authentication_finished" and .accepted == false)] | length) == ($rejected + 1)
' "$work_dir/reauth-boundary.jsonl" >/dev/null
reauth_failed_state="$(jq -c '{targetRevision,credentialStatus,credentialRevision,credentialLastAuthFailureAt,assignment,savedVms}' \
  "$execution_response")"

# Repeated delivery must be idempotent, including the failure timestamp.
reauth_client report-ignored <"$work_dir/reauth-old-target.json"
reauth_client report-ignored <"$work_dir/reauth-old-target.json"
refresh_execution_settings
jq -e --argjson before "$reauth_failed_state" \
  '{targetRevision,credentialStatus,credentialRevision,credentialLastAuthFailureAt,assignment,savedVms} == $before' \
  "$execution_response" >/dev/null

reauth_update_password wrong-fixture-password 422
jq -e '.error == "AD password was not accepted"' "$work_dir/reauth-update.json" >/dev/null
jq -e --argjson before "$reauth_failed_state" \
  '{targetRevision,credentialStatus,credentialRevision,credentialLastAuthFailureAt,assignment,savedVms} == $before' \
  "$execution_response" >/dev/null

reauth_update_password platformclaw-safeconnect-fixture-password-rotated 200
jq -e --arg id "$connection_one_id" --argjson revision "$reauth_old_credential_revision" \
  --argjson others "$reauth_other_registrations" '
  .credentialStatus == "current" and .credentialRevision == ($revision + 1) and
  .assignment.status == "ready" and .activeTarget == "assigned_vm" and
  any(.savedVms[]; .id == $id and .active and .status == "ready") and
  [.savedVms[] | select(.id != $id)] == $others
' "$execution_response" >/dev/null
reauth_client ready
reauth_client target >"$work_dir/reauth-new-target.json"
jq -en --slurpfile old "$work_dir/reauth-old-target.json" --slurpfile new "$work_dir/reauth-new-target.json" '
  $new[0].allocationId == $old[0].allocationId and
  $new[0].credentialRevision == ($old[0].credentialRevision + 1)
' >/dev/null

# An old revision must never poison the successfully replaced credential.
reauth_current_state="$(jq -c '{targetRevision,credentialStatus,credentialRevision,credentialLastAuthFailureAt,assignment,savedVms}' \
  "$execution_response")"
reauth_client report-ignored <"$work_dir/reauth-old-target.json"
reauth_client connection-errors
reauth_fixture command-failure
reauth_client command-failure
reauth_fixture command-failure-255
reauth_client command-failure
refresh_execution_settings
jq -e --argjson before "$reauth_current_state" \
  '{targetRevision,credentialStatus,credentialRevision,credentialLastAuthFailureAt,assignment,savedVms} == $before' \
  "$execution_response" >/dev/null
reauth_snapshot_boundary
jq -se '
  any(.[]; .event == "command_finished" and .linuxAccount == "person_one" and .exitStatus == 5) and
  any(.[]; .event == "command_finished" and .linuxAccount == "person_one" and .exitStatus == 255)
' \
  "$work_dir/reauth-boundary.jsonl" >/dev/null

# Restore synthetic credentials before the smoke's existing streaming checks.
reauth_fixture restore
reauth_update_password platformclaw-safeconnect-fixture-password 200
jq -e '.credentialStatus == "current" and .assignment.status == "ready"' "$execution_response" >/dev/null
reauth_client ready
echo "==> Real SSH password recovery, stale reports, and non-authentication failures passed"
