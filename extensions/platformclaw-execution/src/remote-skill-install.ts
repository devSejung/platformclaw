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
[ "$mode" = install ] || { printf 'VM skill updates are not supported\n' >&2; exit 65; }
[ ! -e "$target" ] || { printf 'skill already exists\n' >&2; exit 73; }
mv -- "$stage" "$target"
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
    verifyCurrentTarget: () => Promise<void>;
    refreshCatalog: () => Promise<unknown>;
  }): SkillArchiveInstallTargetAccess {
    const target = params.target;
    const skillsDir = path.posix.join(target.remoteWorkspaceDir, "skills");
    return {
      install: async ({ sourceDir, slug, mode, timeoutMs }) => {
        if (mode !== "install") {
          throw new Error("VM skill updates are not supported.");
        }
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
          // Recheck after the long upload so a target switch cannot commit to the captured VM.
          await params.verifyCurrentTarget();
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
    };
  }
}
