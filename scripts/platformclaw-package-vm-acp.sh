#!/usr/bin/env bash
# Build transfer artifacts on Linux x64; never install into the shared VM here.
set -euo pipefail
staging=
finish() {
  local result=$?
  if [[ -n ${staging:-} ]]; then
    rm -rf -- "$staging" || result=1
  fi
  if [[ $result -ne 0 ]]; then
    echo "FAILED: PlatformClaw VM ACP packaging" >&2
  fi
  exit "$result"
}
trap finish EXIT

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: bash scripts/platformclaw-package-vm-acp.sh <output-directory> [claude|codex|opencode]" >&2
  exit 2
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "Build inside Linux x64 with Node and npm installed." >&2
  exit 1
fi
output=$(realpath -m "$1")
agent=${2:-codex}
case "$agent" in
  claude) package=@agentclientprotocol/claude-agent-acp; version=0.62.0; name=claude-agent-acp; command=claude-agent-acp ;;
  codex) package=@agentclientprotocol/codex-acp; version=1.1.7; name=codex-acp; command=codex-acp ;;
  opencode) package=opencode-ai; version=1.18.27; name=opencode-acp; command=opencode ;;
  *) echo "Unknown agent: $agent" >&2; exit 2 ;;
esac
mkdir -p "$output"
staging=$(mktemp -d)
root="$staging/package"
mkdir -p "$root/bin" "$staging/home"

# Keep the lock alongside the artifact so rebuilding uses npm ci, including
# transitive resolutions. Initial builds resolve once; top-level pins alone
# are not a transitive lock. These npm projects are transfer artifacts only.
lock="$output/platformclaw-$name-$version-linux-x64.package-lock.json"
node - "$root/package.json" "$package" "$version" "$agent" <<'NODE'
const fs = require('node:fs');
const [file, name, version, agent] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  name: `platformclaw-vm-${agent}`, private: true, version: '0.0.0',
  dependencies: {[name]: version},
  // Matches the reviewed Codex adapter override in the repository lock.
  ...(agent === 'codex' ? {overrides: {'@openai/codex': '0.146.1'}} : {}),
}, null, 2) + '\n');
NODE
if [[ -f "$lock" ]]; then
  cp "$lock" "$root/package-lock.json"
  npm --prefix "$root" ci --omit=dev --no-audit --no-fund
else
  npm --prefix "$root" install --omit=dev --no-audit --no-fund
fi

# Bundle the build's Linux Node runtime so remote login shells need no Node
# installation or PATH repair. Resolve the package's own canonical npm bin.
node_path=$(node -p 'process.execPath')
cp "$node_path" "$root/bin/node"
cp "$(dirname "$(dirname "$node_path")")/LICENSE" "$root/NODE-LICENSE"
entry=$(node - "$root/node_modules/$package/package.json" "$command" <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[process.argv[3]]);
NODE
)
cat > "$root/bin/$command" <<EOF
#!/bin/sh
root=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
export PATH="\$root/bin:\$PATH"
exec "\$root/node_modules/$package/$entry" "\$@"
EOF
chmod 0755 "$root/bin/node" "$root/bin/$command"
env -i HOME="$staging/home" PATH=/usr/bin:/bin "$root/bin/$command" --version
if [[ "$agent" == codex ]]; then
  env -i HOME="$staging/home" PATH=/usr/bin:/bin "$root/bin/$command" cli login --help
fi
env -i HOME="$staging/home" PATH=/usr/bin:/bin "$root/bin/node" - "$root/bin/$command" "$agent" <<'NODE'
const {spawn} = require('node:child_process');
const [command, agent] = process.argv.slice(2);
const child = spawn(command, agent === 'opencode' ? ['acp'] : [], {
  detached: true, stdio: ['pipe', 'pipe', 'inherit'],
});
let output = '';
let done = false;
function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  if (error) { console.error(error); process.exitCode = 1; }
  else console.log(`${agent}: ACP initialize passed`);
  // Stop the adapter and its Codex/OpenCode children after the protocol probe.
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}
const timer = setTimeout(() => finish('ACP initialize timed out'), 30_000);
child.on('error', error => finish(error.message));
child.on('exit', () => finish('Adapter exited before ACP initialize'));
child.stdout.on('data', chunk => {
  output += chunk.toString();
  if (output.length > 1024 * 1024) return finish('ACP initialize output exceeded 1 MiB');
  let newline;
  while ((newline = output.indexOf('\n')) !== -1) {
    const line = output.slice(0, newline); output = output.slice(newline + 1);
    let response;
    try { response = JSON.parse(line); } catch { return finish('Non-JSON ACP stdout'); }
    if (response.id === 1) {
      finish(response.result?.protocolVersion ? undefined : 'ACP initialize failed');
    }
  }
});
child.stdin.on('error', error => finish(error.message));
child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: 1, clientCapabilities: {},
  clientInfo: {name: 'platformclaw-package-proof', version: '1.0.0'},
}}) + '\n');
NODE
cp "$root/package-lock.json" "$lock"
archive="$output/platformclaw-$name-$version-linux-x64.tar.gz"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$root" -czf "$archive" .
(cd "$output" && sha256sum "$(basename "$archive")") > "$archive.sha256"
cat "$archive.sha256"
