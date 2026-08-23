import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildRemoteCommand,
  disposeSshSandboxSession,
  runSshSandboxCommand,
  uploadDirectoryToSshTarget,
  type SkillArchiveInstallTargetAccess,
  type SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import type { AssignedVmTargetSnapshot } from "./backend.js";

const VM_REMOTE_SKILL_INSTALL_SCRIPT = String.raw`
set -eu
stage=$1
target=$2
skills=$3
mode=$4
expected_revision=$5
command -v flock >/dev/null 2>&1 || { printf 'flock is required\n' >&2; exit 69; }
[ -d "$stage" ] && [ ! -L "$stage" ] || { printf 'invalid skill staging directory\n' >&2; exit 65; }
mkdir -p -- "$skills"
[ -d "$skills" ] && [ ! -L "$skills" ] || { printf 'invalid skills root\n' >&2; exit 65; }
while IFS= read -r -d '' entry; do
  if [ -d "$entry" ] && [ ! -L "$entry" ]; then
    continue
  fi
  [ -f "$entry" ] && [ ! -L "$entry" ] && [ "$(stat -c %h -- "$entry")" = 1 ] || {
    printf 'unsupported skill entry\n' >&2
    exit 65
  }
done < <(find -P "$stage" -mindepth 1 -print0)
[ -f "$stage/SKILL.md" ] && [ ! -L "$stage/SKILL.md" ] || { printf 'skill is missing SKILL.md\n' >&2; exit 65; }
exec 9<"$skills"
flock -x 9
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT HUP INT TERM
if [ "$mode" = install ]; then
  [ ! -e "$target" ] || { printf 'skill already exists\n' >&2; exit 73; }
  mv -- "$stage" "$target"
elif [ "$mode" = update ]; then
  [ -d "$target" ] && [ ! -L "$target" ] || { printf 'skill is missing or invalid\n' >&2; exit 73; }
  [ -n "$expected_revision" ] || { printf 'expected skill revision is required\n' >&2; exit 65; }
  actual_revision="sha256:$(sha256sum -- "$target/SKILL.md" | cut -c1-16)"
  [ "$actual_revision" = "$expected_revision" ] || { printf 'skill changed; reload and retry\n' >&2; exit 73; }
  backup="$skills/.platformclaw-skill-backup-$$"
  [ ! -e "$backup" ] || { printf 'skill backup collision\n' >&2; exit 73; }
  rollback() {
    if [ -d "$backup" ] && [ ! -L "$backup" ]; then
      rm -rf -- "$target"
      mv -- "$backup" "$target"
    fi
  }
  trap 'rollback; cleanup' EXIT HUP INT TERM
  mv -- "$target" "$backup"
  mv -- "$stage" "$target"
  # Commit before cleanup: backup deletion failure must preserve the new target,
  # never roll back from a partially deleted backup.
  trap cleanup EXIT HUP INT TERM
  rm -rf -- "$backup" || printf 'skill backup cleanup failed\n' >&2
else
  printf 'invalid skill install mode\n' >&2
  exit 65
fi
`;

const VM_REMOTE_SKILL_REMOVE_SCRIPT = String.raw`
set -eu
target=$1
skills=$2
expected_revision=$3
command -v flock >/dev/null 2>&1 || { printf 'flock is required\n' >&2; exit 69; }
[ -d "$skills" ] && [ ! -L "$skills" ] || { printf 'invalid skills root\n' >&2; exit 65; }
exec 9<"$skills"
flock -x 9
[ -d "$target" ] && [ ! -L "$target" ] || { printf 'skill is missing or invalid\n' >&2; exit 73; }
[ -f "$target/SKILL.md" ] && [ ! -L "$target/SKILL.md" ] || { printf 'skill is missing SKILL.md\n' >&2; exit 73; }
actual_revision="sha256:$(sha256sum -- "$target/SKILL.md" | cut -c1-16)"
[ "$actual_revision" = "$expected_revision" ] || { printf 'skill changed; reload and retry\n' >&2; exit 73; }
stage="$skills/.platformclaw-skill-remove-$$"
[ ! -e "$stage" ] || { printf 'skill removal collision\n' >&2; exit 73; }
mv -- "$target" "$stage"
rollback() { [ ! -e "$target" ] && [ -d "$stage" ] && [ ! -L "$stage" ] && mv -- "$stage" "$target"; }
trap rollback EXIT HUP INT TERM
staged_revision="sha256:$(sha256sum -- "$stage/SKILL.md" | cut -c1-16)"
[ "$staged_revision" = "$expected_revision" ] || { printf 'skill changed; reload and retry\n' >&2; exit 73; }
rm -rf -- "$stage"
trap - EXIT HUP INT TERM
`;

type RemoteSkillInstallIo = {
  createSession(target: AssignedVmTargetSnapshot): Promise<SshSandboxSession>;
  disposeSession: typeof disposeSshSandboxSession;
  runCommand: typeof runSshSandboxCommand;
  uploadDirectory: typeof uploadDirectoryToSshTarget;
};

export class VmRemoteSkillInstallerService {
  constructor(private readonly io: RemoteSkillInstallIo) {}

  createAccess(params: {
    target: AssignedVmTargetSnapshot;
    refreshCatalog: () => Promise<unknown>;
  }): SkillArchiveInstallTargetAccess {
    const target = params.target;
    const skillsDir = path.posix.join(target.remoteWorkspaceDir, "skills");
    return {
      install: async ({ sourceDir, slug, mode, timeoutMs, expectedSkillRevision }) => {
        const stagingRoot = path.posix.join(
          target.remoteWorkspaceDir,
          ".openclaw",
          "skill-installs",
        );
        const stage = path.posix.join(stagingRoot, randomUUID());
        const targetDir = path.posix.join(skillsDir, slug);
        const session = await this.io.createSession(target);
        const signal = AbortSignal.timeout(timeoutMs);
        try {
          await this.io.uploadDirectory({
            session,
            localDir: sourceDir,
            remoteDir: stage,
            remoteRootDir: target.remoteWorkspaceDir,
            signal,
          });
          const result = await this.io.runCommand({
            session,
            remoteCommand: buildRemoteCommand([
              "/bin/bash",
              "-c",
              VM_REMOTE_SKILL_INSTALL_SCRIPT,
              "platformclaw-skill-install",
              stage,
              targetDir,
              skillsDir,
              mode,
              expectedSkillRevision ?? "",
            ]),
            allowFailure: true,
            signal,
          });
          if (result.code === 73) {
            throw new Error("VM skill already exists or changed; reload and retry");
          }
          if (result.code !== 0) {
            throw new Error(`VM skill install failed (${result.code})`);
          }
          // The target revision does not change for a workspace mutation, so
          // refresh the revision-keyed catalog before releasing the install guard.
          await params.refreshCatalog();
          return { targetDir };
        } finally {
          await this.io
            .runCommand({
              session,
              remoteCommand: buildRemoteCommand([
                "/bin/sh",
                "-c",
                'rm -rf -- "$1"',
                "platformclaw-skill-install-cleanup",
                stage,
              ]),
              allowFailure: true,
              signal: AbortSignal.timeout(10_000),
            })
            .catch(() => undefined);
          await this.io.disposeSession(session);
        }
      },
      remove: async ({ slug, timeoutMs, expectedSkillRevision }) => {
        const targetDir = path.posix.join(skillsDir, slug);
        const session = await this.io.createSession(target);
        try {
          const result = await this.io.runCommand({
            session,
            remoteCommand: buildRemoteCommand([
              "/bin/bash",
              "-c",
              VM_REMOTE_SKILL_REMOVE_SCRIPT,
              "platformclaw-skill-remove",
              targetDir,
              skillsDir,
              expectedSkillRevision,
            ]),
            allowFailure: true,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (result.code === 73) {
            throw new Error("VM skill is missing or changed; reload and retry");
          }
          if (result.code !== 0) {
            throw new Error(`VM skill removal failed (${result.code})`);
          }
          await params.refreshCatalog();
          return { targetDir };
        } finally {
          await this.io.disposeSession(session);
        }
      },
    };
  }
}
