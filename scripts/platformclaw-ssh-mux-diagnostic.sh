#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

aging=false
if [[ "${1:-}" == "--aging" ]]; then
  aging=true
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--aging]" >&2
  exit 2
fi

aging_seconds="${PLATFORMCLAW_SSH_AGING_SECONDS:-90000}"
sample_seconds="${PLATFORMCLAW_SSH_AGING_SAMPLE_SECONDS:-600}"
keep_artifacts="${PLATFORMCLAW_SSH_DIAGNOSTIC_KEEP_ARTIFACTS:-1}"

if $aging; then
  [[ "$aging_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo "PLATFORMCLAW_SSH_AGING_SECONDS must be a positive integer" >&2
    exit 2
  }
  [[ "$sample_seconds" =~ ^[1-9][0-9]*$ ]] || {
    echo "PLATFORMCLAW_SSH_AGING_SAMPLE_SECONDS must be a positive integer" >&2
    exit 2
  }
fi

read -r -p "SafeConnect host: " safeconnect_host
read -r -p "SafeConnect port [44422]: " safeconnect_port
safeconnect_port="${safeconnect_port:-44422}"
read -r -p 'Composite SSH user (domain\AD+Linux+VM): ' safeconnect_user
read -r -p "Approved ED25519 fingerprint (SHA256:...): " approved_fingerprint
read -r -s -p "AD password: " safeconnect_password
printf '\n'

[[ "$safeconnect_host" =~ ^[A-Za-z0-9.-]+$ ]] || {
  echo "FAIL invalid SafeConnect host" >&2
  exit 2
}
[[ "$safeconnect_port" =~ ^[0-9]+$ ]] &&
  ((safeconnect_port >= 1 && safeconnect_port <= 65535)) || {
  echo "FAIL invalid SafeConnect port" >&2
  exit 2
}
[[ "$safeconnect_user" != *[$'\r\n\t ']* ]] || {
  echo "FAIL composite SSH user contains whitespace" >&2
  exit 2
}
[[ "$approved_fingerprint" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]] || {
  echo "FAIL invalid host-key fingerprint" >&2
  exit 2
}

diagnostic_dir="$(mktemp -d /tmp/platformclaw-ssh.XXXXXX)"
config_path="$diagnostic_dir/config"
known_hosts_path="$diagnostic_dir/known_hosts"
control_path="$diagnostic_dir/mux"
master_pid=""
completed=false

cleanup() {
  local exit_code=$?
  set +e
  if [[ -S "$control_path" ]]; then
    ssh -F "$config_path" -S "$control_path" -O exit platformclaw-diagnostic \
      >/dev/null 2>&1
  fi
  if [[ -n "$master_pid" ]]; then
    wait "$master_pid" 2>/dev/null
  fi
  unset safeconnect_password
  if [[ "$keep_artifacts" == "1" ]]; then
    printf 'Artifacts: %s\n' "$diagnostic_dir"
    echo "Artifacts contain internal endpoint metadata; do not commit or export them."
  else
    rm -rf "$diagnostic_dir"
  fi
  if ! $completed && [[ $exit_code -ne 0 ]]; then
    printf 'OVERALL=FAIL exit=%d\n' "$exit_code" >&2
  fi
}
trap cleanup EXIT INT TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'FAIL required command missing: %s\n' "$1" >&2
    exit 3
  fi
}

for command_name in ssh sshpass ssh-keyscan ssh-keygen sha256sum timeout getent; do
  require_command "$command_name"
done

echo "== Runtime =="
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release || true
ssh -V
sshpass -V | head -1
printf 'identity='; id
printf 'started_at='; date --iso-8601=seconds

echo "== PlatformClaw boundary =="
[[ -x /usr/local/bin/platformclaw-sshpass ]] && echo "launcher=PASS" || echo "launcher=ABSENT"
[[ -n "${PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS:-}" ]] &&
  echo "credential_broker_env=PASS" || echo "credential_broker_env=ABSENT"
[[ -r "${PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE:-/missing}" ]] &&
  echo "execution_token_mount=PASS" || echo "execution_token_mount=ABSENT"

echo "== Network and pinned host key =="
getent ahosts "$safeconnect_host" | awk '{print $1}' | sort -u |
  tee "$diagnostic_dir/resolved-addresses.txt"
timeout 10 bash -c "exec 9<>/dev/tcp/$safeconnect_host/$safeconnect_port" || {
  echo "FAIL TCP connection" >&2
  exit 4
}
echo "tcp=PASS"
ssh-keyscan -T 10 -p "$safeconnect_port" -t ed25519 "$safeconnect_host" \
  2>"$diagnostic_dir/keyscan.err" >"$known_hosts_path"
observed_fingerprint="$(ssh-keygen -lf "$known_hosts_path" -E sha256 | awk 'NR == 1 {print $2}')"
printf 'approved_fingerprint=%s\nobserved_fingerprint=%s\n' \
  "$approved_fingerprint" "$observed_fingerprint"
[[ "$observed_fingerprint" == "$approved_fingerprint" ]] || {
  echo "FAIL host-key fingerprint mismatch" >&2
  exit 5
}
echo "host_key=PASS"

cat >"$config_path" <<EOF
Host platformclaw-diagnostic
  HostName $safeconnect_host
  Port $safeconnect_port
  User $safeconnect_user
  BatchMode no
  PreferredAuthentications keyboard-interactive
  KbdInteractiveAuthentication yes
  PasswordAuthentication no
  PubkeyAuthentication no
  NumberOfPasswordPrompts 1
  ConnectTimeout 15
  ServerAliveInterval 30
  ServerAliveCountMax 3
  TCPKeepAlive yes
  StrictHostKeyChecking yes
  UpdateHostKeys no
  UserKnownHostsFile $known_hosts_path
  GlobalKnownHostsFile /dev/null
  ForwardAgent no
  RequestTTY no
EOF
chmod 600 "$config_path" "$known_hosts_path"

fresh_ssh() {
  local started_at finished_at result
  started_at="$(date +%s%3N)"
  exec 3<<<"$safeconnect_password"
  if sshpass -d 3 ssh -F "$config_path" \
    -o ControlMaster=no -o ControlPath=none \
    platformclaw-diagnostic 'true'; then
    result=0
  else
    result=$?
  fi
  exec 3<&-
  finished_at="$(date +%s%3N)"
  printf 'fresh_auth_rc=%d duration_ms=%d\n' "$result" "$((finished_at - started_at))"
  return "$result"
}

mux_ssh() {
  ssh -F "$config_path" -S "$control_path" \
    -o ControlMaster=no -o BatchMode=yes \
    platformclaw-diagnostic "$@"
}

if ! $aging; then
  echo "== New-connection baseline =="
  for _ in 1 2 3; do
    fresh_ssh
  done | tee "$diagnostic_dir/fresh-auth.txt"
fi

echo "== Establish one authenticated master =="
exec 3<<<"$safeconnect_password"
sshpass -d 3 ssh -vv -F "$config_path" \
  -o ControlMaster=yes -o ControlPersist=no \
  -S "$control_path" -N platformclaw-diagnostic \
  </dev/null >"$diagnostic_dir/master.out" 2>"$diagnostic_dir/master.err" &
master_pid=$!
exec 3<&-

master_ready=false
for _ in $(seq 1 30); do
  if ssh -F "$config_path" -S "$control_path" -O check platformclaw-diagnostic \
    >/dev/null 2>&1; then
    master_ready=true
    break
  fi
  if ! kill -0 "$master_pid" 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! $master_ready; then
  echo "FAIL authenticated master did not become ready" >&2
  tail -100 "$diagnostic_dir/master.err" >&2
  exit 6
fi
unset safeconnect_password
echo "master_authentication=PASS"
grep -E 'Next authentication method|Authenticated to|muxserver_listen' \
  "$diagnostic_dir/master.err" || true

if $aging; then
  echo "== 25-hour aging test =="
  printf 'duration_seconds=%s sample_seconds=%s keepalive_seconds=30\n' \
    "$aging_seconds" "$sample_seconds"
  started_epoch="$(date +%s)"
  deadline_epoch="$((started_epoch + aging_seconds))"
  while (( $(date +%s) < deadline_epoch )); do
    current_epoch="$(date +%s)"
    if ! ssh -F "$config_path" -S "$control_path" -O check platformclaw-diagnostic \
      >/dev/null 2>&1; then
      printf '%s master=DEAD elapsed_seconds=%d\n' \
        "$(date --iso-8601=seconds)" "$((current_epoch - started_epoch))" |
        tee -a "$diagnostic_dir/aging.txt"
      exit 7
    fi
    printf '%s master=ALIVE elapsed_seconds=%d\n' \
      "$(date --iso-8601=seconds)" "$((current_epoch - started_epoch))" |
      tee -a "$diagnostic_dir/aging.txt"
    remaining_seconds="$((deadline_epoch - current_epoch))"
    ((remaining_seconds <= 0)) && break
    if ((remaining_seconds < sample_seconds)); then
      sleep "$remaining_seconds"
    else
      sleep "$sample_seconds"
    fi
  done
  mux_ssh 'printf "remote_command_after_aging=PASS\n"'
  completed=true
  echo "OVERALL=PASS mode=aging"
  exit 0
fi

echo "== Sequential multiplex latency =="
for sequence in $(seq 1 20); do
  started_ms="$(date +%s%3N)"
  mux_ssh 'true'
  finished_ms="$(date +%s%3N)"
  printf '%02d duration_ms=%d\n' "$sequence" "$((finished_ms - started_ms))"
done | tee "$diagnostic_dir/sequential.txt"

echo "== Concurrent multiplex channels =="
for channel_count in 1 2 4 8 16; do
  pids=()
  failures=0
  started_ms="$(date +%s%3N)"
  for channel in $(seq 1 "$channel_count"); do
    mux_ssh 'sleep 2; true' \
      >"$diagnostic_dir/channel-$channel_count-$channel.out" 2>&1 &
    pids+=("$!")
  done
  for channel_pid in "${pids[@]}"; do
    wait "$channel_pid" || failures=$((failures + 1))
  done
  finished_ms="$(date +%s%3N)"
  printf 'channels=%d failures=%d duration_ms=%d\n' \
    "$channel_count" "$failures" "$((finished_ms - started_ms))"
  ((failures == 0)) || exit 8
done | tee "$diagnostic_dir/concurrency.txt"

echo "== Independent long and short channels =="
mux_ssh 'sleep 30; printf "long_channel=PASS\n"' >"$diagnostic_dir/long-channel.out" &
long_channel_pid=$!
sleep 2
mux_ssh 'printf "parallel_command=PASS\n"'
wait "$long_channel_pid"
cat "$diagnostic_dir/long-channel.out"

echo "== Reused-connection upload/download integrity =="
dd if=/dev/urandom of="$diagnostic_dir/payload.bin" bs=1M count=16 status=none
local_hash="$(sha256sum "$diagnostic_dir/payload.bin" | awk '{print $1}')"
mux_ssh 'umask 077; mkdir -p "$HOME/.platformclaw"; cat >"$HOME/.platformclaw/ssh-mux-diagnostic.bin"' \
  <"$diagnostic_dir/payload.bin"
remote_hash="$(mux_ssh 'sha256sum "$HOME/.platformclaw/ssh-mux-diagnostic.bin" | cut -d" " -f1')"
mux_ssh 'cat "$HOME/.platformclaw/ssh-mux-diagnostic.bin"' >"$diagnostic_dir/download.bin"
download_hash="$(sha256sum "$diagnostic_dir/download.bin" | awk '{print $1}')"
mux_ssh 'rm -f "$HOME/.platformclaw/ssh-mux-diagnostic.bin"'
printf 'local_hash=%s\nremote_hash=%s\ndownload_hash=%s\n' \
  "$local_hash" "$remote_hash" "$download_hash"
[[ "$local_hash" == "$remote_hash" && "$local_hash" == "$download_hash" ]] || {
  echo "FAIL stream hash mismatch" >&2
  exit 9
}
echo "stream_integrity=PASS"

ssh -F "$config_path" -S "$control_path" -O check platformclaw-diagnostic
completed=true
echo "OVERALL=PASS mode=immediate"
