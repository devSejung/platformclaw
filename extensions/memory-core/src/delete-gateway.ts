import { createHash } from "node:crypto";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import {
  listAgentIds,
  type MemoryPluginRuntime,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { FsSafeError, root } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Match the operator workspace preview cap: deletion never confirms a truncated file.
const MAX_MEMORY_BYTES = 256 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
class InvalidMemoryDeleteRequestError extends Error {}

function parseMemoryDeleteRequest(value: unknown): {
  agentId: string;
  path: string;
  expectedContentHash: string;
} {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["agentId", "path", "expectedContentHash"].includes(key))
  ) {
    throw new InvalidMemoryDeleteRequestError(
      "memory.delete requires agentId, path, and expectedContentHash only",
    );
  }
  const { agentId, path, expectedContentHash } = value;
  if (
    typeof agentId !== "string" ||
    !agentId.trim() ||
    typeof path !== "string" ||
    path.length > 1024 ||
    (path !== "MEMORY.md" && !(path.startsWith("memory/") && path.endsWith(".md"))) ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || /[\\\x00-\x1f:]/u.test(part)) ||
    typeof expectedContentHash !== "string" ||
    !HASH.test(expectedContentHash)
  ) {
    throw new InvalidMemoryDeleteRequestError(
      "Select a personal memory Markdown file and reload its current content before deleting",
    );
  }
  return { agentId, path, expectedContentHash };
}

/** Remove the source artifact; safe-root rejects links and paths outside the workspace. */
async function deletePersonalMemoryFile(params: {
  workspaceDir: string;
  path: string;
  expectedContentHash: string;
}): Promise<void> {
  const workspace = await root(params.workspaceDir);
  try {
    const content = await workspace.readBytes(params.path, { maxBytes: MAX_MEMORY_BYTES });
    // Hash the same strict UTF-8 projection shown in the browser, including BOM handling.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    if (createHash("sha256").update(text).digest("hex") !== params.expectedContentHash) {
      throw new InvalidMemoryDeleteRequestError(
        "Memory changed since it was opened. Reload it before deleting",
      );
    }
    await workspace.remove(params.path);
  } catch (error) {
    // A retry after a lost response must still refresh indexes without deleting a new file.
    if (!(error instanceof FsSafeError && error.code === "not-found")) {
      throw error;
    }
  }
}

export function registerMemoryDeleteGatewayMethod(
  api: OpenClawPluginApi,
  runtime: MemoryPluginRuntime,
): void {
  api.registerGatewayMethod(
    "memory.delete",
    async ({ params, respond, context }) => {
      const cfg = context.getRuntimeConfig();
      let request: ReturnType<typeof parseMemoryDeleteRequest>;
      try {
        request = parseMemoryDeleteRequest(params);
        if (!listAgentIds(cfg).includes(request.agentId)) {
          throw new InvalidMemoryDeleteRequestError("Unknown agent id");
        }
        await deletePersonalMemoryFile({
          workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(cfg, request.agentId),
          path: request.path,
          expectedContentHash: request.expectedContentHash,
        });
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            error instanceof InvalidMemoryDeleteRequestError
              ? ErrorCodes.INVALID_REQUEST
              : ErrorCodes.UNAVAILABLE,
            error instanceof InvalidMemoryDeleteRequestError
              ? error.message
              : "Memory deletion could not be completed. Reload the memory and try again.",
          ),
        );
        return;
      }
      let indexesRefreshed = false;
      let manager: Awaited<ReturnType<MemoryPluginRuntime["getMemorySearchManager"]>>["manager"] =
        null;
      try {
        ({ manager } = await runtime.getMemorySearchManager({
          cfg,
          agentId: request.agentId,
          purpose: "cli",
        }));
        if (manager?.sync) {
          await manager.sync({ reason: "memory-delete", force: true });
          indexesRefreshed = true;
        }
      } catch {
        // Deletion has committed. Report refresh separately so operators never mistake it for rollback.
      } finally {
        await manager?.close?.().catch(() => {});
      }
      respond(true, {
        agentId: request.agentId,
        path: request.path,
        deleted: true,
        indexesRefreshed,
      });
    },
    { scope: "operator.write" },
  );
}
