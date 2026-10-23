import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

export type SandboxOutboundFileAccess = {
  /** Stable account-owned scratch directory on this exact runtime. */
  tempDir: string;
  assertCurrentAuthority?: () => Promise<void>;
  readFile(params: {
    filePath: string;
    cwd?: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<Buffer>;
};

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
      if (candidate.startsWith("/tmp/")) {
        // /tmp belongs to the selected runtime. Never resolve it through the
        // Gateway host. Export retains its own descriptor and byte-limit checks.
        if (filePath.split("/").includes("..") || cwd?.split("/").includes("..")) {
          throw new Error(
            "Outbound temp paths cannot contain parent traversal; use an absolute path.",
          );
        }
        const relative = candidate.slice("/tmp/".length);
        const result = await params.backend.runShellCommand({
          script: OUTBOUND_FILE_SCRIPT,
          args: [
            "read-own",
            "/tmp",
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
