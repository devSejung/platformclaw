import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildRemoteCommand,
  createRemoteShellSandboxFsBridge,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  type SandboxBackendCommandParams,
  type SandboxBackendCommandResult,
  type SandboxBackendSkillCatalog,
  type SkillWorkshopTargetAccess,
  type SkillWorkshopTargetFile,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import { PLATFORMCLAW_EXECUTION_BACKEND_ID, type AssignedVmTargetSnapshot } from "./backend.js";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SHELL_PARAMETER_OPEN = "${";

const VM_REMOTE_SKILL_TREE_READ_SCRIPT = String.raw`
set -eu
root=$1
[ -e "$root" ] || exit 0
[ -d "$root" ] && [ ! -L "$root" ] || { printf 'invalid skill root\n' >&2; exit 65; }
count=0
total=0
while IFS= read -r -d '' entry; do
  rel=${SHELL_PARAMETER_OPEN}entry#"$root"/}
  first=${SHELL_PARAMETER_OPEN}rel%%/*}
  case "$first" in .clawhub|.clawdhub|.openclaw) continue ;; esac
  [ -f "$entry" ] && [ ! -L "$entry" ] || { printf 'unsupported skill entry\n' >&2; exit 65; }
  links=$(stat -c %h -- "$entry")
  [ "$links" = 1 ] || { printf 'hard-linked skill entry\n' >&2; exit 65; }
  size=$(stat -c %s -- "$entry")
  [ "$size" -le ${MAX_FILE_BYTES} ] || { printf 'skill file limit exceeded\n' >&2; exit 75; }
  count=$((count + 1))
  total=$((total + size))
  [ "$count" -le ${MAX_FILES} ] && [ "$total" -le ${MAX_BUNDLE_BYTES} ] || {
    printf 'skill bundle limit exceeded\n' >&2
    exit 75
  }
  printf '%s' "$rel" | base64 | tr -d '\n'
  printf '\t'
  base64 < "$entry" | tr -d '\n'
  printf '\n'
done < <(find -P "$root" -mindepth 1 -maxdepth 16 ! -type d -print0 | LC_ALL=C sort -z)
`;

const VM_REMOTE_SKILL_TREE_MUTATE_SCRIPT = String.raw`
set -eu
root=$1
mode=$2
skills=${SHELL_PARAMETER_OPEN}root%/*}
command -v flock >/dev/null 2>&1 || { printf 'flock is required\n' >&2; exit 69; }
mkdir -p -- "$skills"
[ -d "$skills" ] && [ ! -L "$skills" ] || { printf 'invalid skills root\n' >&2; exit 65; }
exec 9<"$skills"
flock -x 9
tmp=$(mktemp -d)
cleanup() { rm -rf -- "$tmp"; }
trap cleanup EXIT HUP INT TERM
mkdir -p -- "$tmp/next" "$tmp/backup"
: > "$tmp/expected"
: > "$tmp/plan"
decode_path() {
  decoded=$(printf '%s' "$1" | base64 -d)
  [ -n "$decoded" ] && [ "${SHELL_PARAMETER_OPEN}decoded#/}" = "$decoded" ] || return 1
  case "$decoded" in *\\*|*/../*|../*|*/..|./*|*/./*|*/.|.*/*) return 1 ;; esac
  if [ "$2" != E ] && [ "$decoded" != SKILL.md ]; then
    case "$decoded" in assets/*|examples/*|references/*|scripts/*|templates/*) ;; *) return 1 ;; esac
  fi
  printf '%s' "$decoded"
}
while IFS=$'\t' read -r kind encoded_path value size; do
  [ -n "$kind" ] || continue
  rel=$(decode_path "$encoded_path" "$kind") || { printf 'invalid mutation path\n' >&2; exit 65; }
  case "$kind" in
    E)
      printf '%s\t%s\t%s\n' "$rel" "$value" "$size" >> "$tmp/expected"
      ;;
    W)
      next="$tmp/next/$(printf '%s' "$encoded_path" | tr '/+' '_-')"
      printf '%s' "$value" | base64 -d > "$next"
      [ "$(stat -c %s -- "$next")" = "$size" ] || { printf 'invalid mutation content\n' >&2; exit 65; }
      printf 'W\t%s\t%s\n' "$rel" "$next" >> "$tmp/plan"
      ;;
    D)
      printf 'D\t%s\t-\n' "$rel" >> "$tmp/plan"
      ;;
    *) printf 'invalid mutation command\n' >&2; exit 65 ;;
  esac
done
LC_ALL=C sort -o "$tmp/expected" "$tmp/expected"
: > "$tmp/actual"
if [ -e "$root" ]; then
  [ -d "$root" ] && [ ! -L "$root" ] || { printf 'invalid skill root\n' >&2; exit 65; }
  count=0
  total=0
  while IFS= read -r -d '' entry; do
    rel=${SHELL_PARAMETER_OPEN}entry#"$root"/}
    first=${SHELL_PARAMETER_OPEN}rel%%/*}
    case "$first" in .clawhub|.clawdhub|.openclaw) continue ;; esac
    [ -f "$entry" ] && [ ! -L "$entry" ] && [ "$(stat -c %h -- "$entry")" = 1 ] || {
      printf 'unsupported skill entry\n' >&2
      exit 65
    }
    size=$(stat -c %s -- "$entry")
    [ "$size" -le ${MAX_FILE_BYTES} ] || { printf 'skill file limit exceeded\n' >&2; exit 75; }
    count=$((count + 1))
    total=$((total + size))
    [ "$count" -le ${MAX_FILES} ] && [ "$total" -le ${MAX_BUNDLE_BYTES} ] || {
      printf 'skill bundle limit exceeded\n' >&2
      exit 75
    }
    printf '%s\t%s\t%s\n' "$rel" "$(sha256sum -- "$entry" | cut -d ' ' -f 1)" "$size" >> "$tmp/actual"
  done < <(find -P "$root" -mindepth 1 -maxdepth 16 ! -type d -print0 | LC_ALL=C sort -z)
fi
LC_ALL=C sort -o "$tmp/actual" "$tmp/actual"
cmp -s "$tmp/expected" "$tmp/actual" || { printf 'skill target changed\n' >&2; exit 73; }
if [ "$mode" = create ]; then
  [ ! -e "$root/SKILL.md" ] || { printf 'skill already exists\n' >&2; exit 73; }
elif [ "$mode" = update ]; then
  [ -f "$root/SKILL.md" ] && [ ! -L "$root/SKILL.md" ] || { printf 'skill is missing\n' >&2; exit 73; }
elif [ "$mode" = restore ]; then
  :
else
  printf 'invalid mutation mode\n' >&2
  exit 65
fi
mkdir -p -- "$root"
[ -d "$root" ] && [ ! -L "$root" ] || { printf 'invalid skill root\n' >&2; exit 65; }
rollback() {
  while IFS=$'\t' read -r rel state; do
    target="$root/$rel"
    if [ "$state" = missing ]; then
      rm -f -- "$target"
    else
      mkdir -p -- "${SHELL_PARAMETER_OPEN}target%/*}"
      cp -- "$tmp/backup/$state" "$target"
    fi
  done < "$tmp/applied"
}
: > "$tmp/applied"
trap 'rollback; cleanup' EXIT HUP INT TERM
index=0
while IFS=$'\t' read -r action rel next; do
  target="$root/$rel"
  parent=${SHELL_PARAMETER_OPEN}target%/*}
  cursor=$root
  old_ifs=$IFS
  IFS=/
  for segment in ${SHELL_PARAMETER_OPEN}rel%/*}; do
    [ "$segment" = "$rel" ] && break
    cursor="$cursor/$segment"
    if [ -e "$cursor" ]; then
      [ -d "$cursor" ] && [ ! -L "$cursor" ] || { printf 'invalid support directory\n' >&2; exit 65; }
    else
      mkdir -- "$cursor"
    fi
  done
  IFS=$old_ifs
  if [ -e "$target" ]; then
    [ -f "$target" ] && [ ! -L "$target" ] && [ "$(stat -c %h -- "$target")" = 1 ] || {
      printf 'invalid mutation target\n' >&2
      exit 65
    }
    cp -- "$target" "$tmp/backup/$index"
    printf '%s\t%s\n' "$rel" "$index" >> "$tmp/applied"
  else
    printf '%s\tmissing\n' "$rel" >> "$tmp/applied"
  fi
  if [ "$action" = D ]; then
    rm -f -- "$target"
  else
    mkdir -p -- "$parent"
    stage="$parent/.platformclaw-workshop-$$-$index"
    cp -- "$next" "$stage"
    chmod 600 "$stage"
    mv -f -- "$stage" "$target"
  fi
  index=$((index + 1))
done < "$tmp/plan"
trap cleanup EXIT HUP INT TERM
`;

type RemoteSkillWorkshopIo = {
  createSession(target: AssignedVmTargetSnapshot): Promise<SshSandboxSession>;
  disposeSession: typeof disposeSshSandboxSession;
  runCommand: typeof runSshSandboxCommand;
};

function decodeBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error(`VM Skill Workshop ${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`VM Skill Workshop ${label} is invalid`);
  }
  return decoded;
}

function decodeUtf8(value: Buffer, label: string): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value) || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error(`VM Skill Workshop ${label} is invalid`);
  }
  return decoded;
}

function parseTree(stdout: Buffer): SkillWorkshopTargetFile[] {
  if (stdout.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error("VM Skill Workshop response exceeded the limit");
  }
  const files: SkillWorkshopTargetFile[] = [];
  let total = 0;
  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length !== 2) {
      throw new Error("VM Skill Workshop response is invalid");
    }
    const relativePath = decodeUtf8(decodeBase64(parts[0] ?? "", "path"), "path");
    const content = decodeBase64(parts[1] ?? "", "content");
    if (
      !relativePath ||
      relativePath.includes("\\") ||
      path.posix.isAbsolute(relativePath) ||
      relativePath.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("VM Skill Workshop path is invalid");
    }
    total += content.byteLength;
    if (
      files.length >= MAX_FILES ||
      content.byteLength > MAX_FILE_BYTES ||
      total > MAX_BUNDLE_BYTES
    ) {
      throw new Error("VM Skill Workshop bundle exceeded the limit");
    }
    files.push({ path: relativePath, content });
  }
  return files;
}

function skillKeyFromFilePath(filePath: string): string | null {
  const key = path.posix.basename(path.posix.dirname(filePath));
  return SKILL_KEY_PATTERN.test(key) ? key : null;
}

export class VmRemoteSkillWorkshopService {
  constructor(private readonly io: RemoteSkillWorkshopIo) {}

  createAccess(params: {
    target: AssignedVmTargetSnapshot;
    catalog?: SandboxBackendSkillCatalog;
    refreshCatalog: () => Promise<SandboxBackendSkillCatalog>;
  }): SkillWorkshopTargetAccess {
    const target = params.target;
    let catalog = params.catalog;
    const skillsDir = path.posix.join(target.remoteWorkspaceDir, "skills");
    const runRemoteShellScript = async (
      command: SandboxBackendCommandParams,
    ): Promise<SandboxBackendCommandResult> => {
      const session = await this.io.createSession(target);
      try {
        return await this.io.runCommand({
          session,
          remoteCommand: buildRemoteCommand([
            "/bin/bash",
            "-c",
            command.script,
            "platformclaw-skill-workshop",
            ...(command.args ?? []),
          ]),
          stdin: command.stdin,
          allowFailure: command.allowFailure,
          signal: command.signal ?? AbortSignal.timeout(COMMAND_TIMEOUT_MS),
          maxBufferBytes: MAX_OUTPUT_BYTES,
        });
      } finally {
        await this.io.disposeSession(session);
      }
    };
    const fsBridge = createRemoteShellSandboxFsBridge({
      sandbox: {
        workspaceDir: target.remoteWorkspaceDir,
        agentWorkspaceDir: target.remoteWorkspaceDir,
        workspaceAccess: "rw",
        containerName: `platformclaw-workshop-${target.allocationId}`,
        containerWorkdir: target.remoteWorkspaceDir,
        docker: {},
        backend: { runShellCommand: runRemoteShellScript },
      },
      runtime: {
        remoteWorkspaceDir: target.remoteWorkspaceDir,
        remoteAgentWorkspaceDir: target.remoteWorkspaceDir,
        additionalFilesystemRoots: [{ root: target.remoteHomeDir, access: "rw" }],
        runRemoteShellScript,
      },
    });
    return {
      backendId: PLATFORMCLAW_EXECUTION_BACKEND_ID,
      // Allocation identity stays stable across credential/selection revisions.
      targetId: target.allocationId,
      targetLabel: target.vmLabel,
      workspaceDir: target.remoteWorkspaceDir,
      skillsDir,
      source: "platformclaw-vm-workspace",
      fsBridge,
      listSkills: async () => {
        catalog ??= await params.refreshCatalog();
        return catalog.files.flatMap((file) => {
          if (
            file.source !== "platformclaw-vm-workspace" ||
            !file.filePath.startsWith(`${skillsDir}/`)
          ) {
            return [];
          }
          const skillKey = skillKeyFromFilePath(file.filePath);
          return skillKey
            ? [
                {
                  name: skillKey,
                  skillKey,
                  source: file.source,
                  skillDir: path.posix.dirname(file.filePath),
                  skillFile: file.filePath,
                },
              ]
            : [];
        });
      },
      readSkillTree: async (skillDir) => {
        const relative = path.posix.relative(skillsDir, skillDir);
        if (
          !SKILL_KEY_PATTERN.test(relative) ||
          path.posix.join(skillsDir, relative) !== skillDir
        ) {
          throw new Error("VM Skill Workshop target must be a personal workspace skill");
        }
        const result = await runRemoteShellScript({
          script: VM_REMOTE_SKILL_TREE_READ_SCRIPT,
          args: [skillDir],
          signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
        });
        if (result.code !== 0) {
          throw new Error(`VM Skill Workshop read failed (${result.code})`);
        }
        return parseTree(result.stdout);
      },
      mutateSkill: async ({ mode, skillDir, expectedTree, files }) => {
        const relative = path.posix.relative(skillsDir, skillDir);
        if (
          !SKILL_KEY_PATTERN.test(relative) ||
          path.posix.join(skillsDir, relative) !== skillDir
        ) {
          throw new Error("VM Skill Workshop target must be a personal workspace skill");
        }
        const lines = [
          ...expectedTree.map((file) => {
            const encodedPath = Buffer.from(file.path, "utf8").toString("base64");
            return ["E", encodedPath, sha256(file.content), String(file.content.byteLength)].join(
              "\t",
            );
          }),
          ...files.map((file) => {
            const encodedPath = Buffer.from(file.path, "utf8").toString("base64");
            return file.content === null
              ? ["D", encodedPath, "", "0"].join("\t")
              : [
                  "W",
                  encodedPath,
                  file.content.toString("base64"),
                  String(file.content.byteLength),
                ].join("\t");
          }),
        ];
        const result = await runRemoteShellScript({
          script: VM_REMOTE_SKILL_TREE_MUTATE_SCRIPT,
          args: [skillDir, mode],
          stdin: `${lines.join("\n")}\n`,
          signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
          allowFailure: true,
        });
        if (result.code === 73) {
          throw new Error("VM skill target changed; reload and retry");
        }
        if (result.code !== 0) {
          throw new Error(`VM Skill Workshop write failed (${result.code})`);
        }
      },
      notifyChanged: async () => {
        catalog = await params.refreshCatalog();
      },
    };
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
