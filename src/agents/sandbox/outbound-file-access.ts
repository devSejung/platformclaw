import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";
import type { SandboxFsBridge, SandboxOutboundFileAccess } from "./fs-bridge.types.js";
import { resolveRemoteCanonicalPath } from "./remote-fs-bridge-canonical-path.js";

const OUTBOUND_FILE_SCRIPT = [
  "set -eu",
  "python3 /dev/fd/3 \"$@\" 3<<'PY'",
  SANDBOX_PINNED_MUTATION_PYTHON,
  "PY",
].join("\n");

/** Prepare attachment access once, pinned to the same backend and roots as execution. */
export async function createSandboxOutboundFileAccess(params: {
  backend: Pick<
    SandboxBackendHandle,
    "runtimeId" | "workdir" | "runShellCommand" | "assertCurrentAuthority"
  >;
  bridge: Pick<SandboxFsBridge, "resolvePath" | "resolveUserPath" | "readFile">;
  scopeKey: string;
  workspaceDir: string;
  workspaceOnly?: boolean;
}): Promise<SandboxOutboundFileAccess> {
  const assertCurrentAuthority = params.backend.assertCurrentAuthority;
  await assertCurrentAuthority?.();
  const scope = createHash("sha256")
    .update(`${params.backend.runtimeId}\0${params.scopeKey}`)
    .digest("hex");
  const prepared = await params.backend.runShellCommand({
    script: OUTBOUND_FILE_SCRIPT,
    args: ["prepare-temp", scope],
    maxBufferBytes: 4096,
  });
  await assertCurrentAuthority?.();
  const tempDir = prepared.stdout.toString("utf8");
  if (!new RegExp(`^/tmp/openclaw-[0-9]+-${scope}$`, "u").test(tempDir)) {
    throw new Error("Sandbox did not prepare a valid account-owned private temp directory.");
  }
  return {
    tempDir,
    ...(assertCurrentAuthority ? { assertCurrentAuthority } : {}),
    async readFile({ filePath, cwd, maxBytes, signal }) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError("Outbound file limit must be a non-negative safe integer.");
      }
      signal?.throwIfAborted();
      await assertCurrentAuthority?.();
      const candidate = path.posix.resolve(cwd ?? params.backend.workdir, filePath);
      let data: Buffer;
      if (params.workspaceOnly || candidate.startsWith("/tmp/")) {
        // /tmp belongs to the selected runtime. Never resolve it through the
        // Gateway host. Export retains its own descriptor and byte-limit checks.
        if (
          candidate.startsWith("/tmp/") &&
          (filePath.split("/").includes("..") || cwd?.split("/").includes(".."))
        ) {
          throw new Error(
            "Outbound temp paths cannot contain parent traversal; use an absolute path.",
          );
        }
        const logicalRoot = params.workspaceOnly ? params.backend.workdir : "/tmp";
        const runtimePath = params.workspaceOnly
          ? (params.bridge.resolveUserPath ?? params.bridge.resolvePath).call(params.bridge, {
              filePath,
              cwd: cwd ?? params.workspaceDir,
            }).containerPath
          : candidate;
        const root = params.workspaceOnly
          ? (
              await resolveRemoteCanonicalPath({
                containerPath: logicalRoot,
                mountRootPath: logicalRoot,
                action: "export attachments",
                signal,
                runRemoteShellScript: (command) => params.backend.runShellCommand(command),
              })
            ).canonicalMountRoot
          : logicalRoot;
        let relative = [logicalRoot, root]
          .map((entry) => path.posix.relative(entry, runtimePath))
          .find(
            (entry) =>
              entry && entry !== ".." && !entry.startsWith("../") && !path.posix.isAbsolute(entry),
          );
        if (relative === undefined) {
          throw new Error("Workspace-only attachments must stay under the execution workspace.");
        }
        const tempSource = runtimePath.startsWith("/tmp/") || root.startsWith("/tmp/");
        if (params.workspaceOnly && !tempSource) {
          const canonical = await resolveRemoteCanonicalPath({
            containerPath: path.posix.join(root, relative),
            mountRootPath: root,
            action: "export attachments",
            signal,
            runRemoteShellScript: (command) => params.backend.runShellCommand(command),
          });
          relative = path.posix.relative(root, canonical.canonicalPath);
        }
        signal?.throwIfAborted();
        await assertCurrentAuthority?.();
        signal?.throwIfAborted();
        // Pin the read to the workspace itself, not a broader home mount. A
        // configured root alias is canonicalized; child aliases cannot escape it.
        const result = await params.backend.runShellCommand({
          script: OUTBOUND_FILE_SCRIPT,
          args: [
            tempSource ? "read-own" : "read",
            root,
            path.posix.dirname(relative),
            path.posix.basename(relative),
            String(maxBytes),
          ],
          signal,
          maxBufferBytes: Math.max(16 * 1024, maxBytes),
        });
        data = result.stdout;
      } else {
        const resolved = (params.bridge.resolveUserPath ?? params.bridge.resolvePath).call(
          params.bridge,
          { filePath, cwd: cwd ?? params.workspaceDir },
        );
        data = await params.bridge.readFile({
          filePath: resolved.containerPath,
          cwd: cwd ?? params.backend.workdir,
          maxBytes,
          signal,
        });
      }
      signal?.throwIfAborted();
      await assertCurrentAuthority?.();
      signal?.throwIfAborted();
      if (data.length > maxBytes) {
        throw new RangeError(`Outbound file exceeds ${maxBytes} bytes.`);
      }
      return data;
    },
  };
}
