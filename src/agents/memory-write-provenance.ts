import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { logWarn } from "../logger.js";
import type { MemoryFlushPlan } from "../plugins/memory-state.js";

export type MemoryWriteProvenanceObserver = {
  classifies: (absolutePath: string) => boolean;
  write: (params: {
    absolutePath: string;
    contentBefore: string;
    contentAfter: string;
    commit: () => Promise<void>;
  }) => Promise<void>;
  clearAfterDelete: (absolutePath: string) => Promise<void>;
};

type ProvenanceWriteOperations = {
  readFile: (absolutePath: string) => Promise<Buffer | string>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  remove?: (absolutePath: string) => Promise<void>;
};

function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "not-found" || String(error).includes("(path not found)");
}

export function withMemoryWriteProvenance<T extends ProvenanceWriteOperations>(
  operations: T,
  observer: MemoryWriteProvenanceObserver | undefined,
): T {
  if (!observer) {
    return operations;
  }
  const remove = operations.remove;
  return {
    ...operations,
    writeFile: async (absolutePath: string, content: string) => {
      if (!observer.classifies(absolutePath)) {
        await operations.writeFile(absolutePath, content);
        return;
      }
      const contentBefore = await operations
        .readFile(absolutePath)
        .then((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value))
        .catch((error: unknown) => {
          if (!isMissingFileError(error)) {
            throw error;
          }
          return "";
        });
      await observer.write({
        absolutePath,
        contentBefore,
        contentAfter: content,
        commit: () => operations.writeFile(absolutePath, content),
      });
    },
    ...(remove
      ? {
          remove: async (absolutePath: string) => {
            const isMemoryFile = observer.classifies(absolutePath);
            await remove(absolutePath);
            if (isMemoryFile) {
              await observer.clearAfterDelete(absolutePath);
            }
          },
        }
      : {}),
  } as T;
}

function resolveMemoryRelativePath(root: string, absolutePath: string): string | undefined {
  const relativePath = path.relative(
    resolvePathViaExistingAncestorSync(root),
    resolvePathViaExistingAncestorSync(absolutePath),
  );
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  const normalized = relativePath.replaceAll(path.sep, "/");
  if (["MEMORY.md", "memory.md", "USER.md"].includes(normalized)) {
    return normalized;
  }
  return normalized.startsWith("memory/") && normalized.endsWith(".md") ? normalized : undefined;
}

export function createMemoryWriteProvenanceObserver(params: {
  mutationRoot: string;
  workspaceDir: string;
  /** Map backend paths to the host filesystem that owns memory provenance. */
  resolveMutationPath?: (absolutePath: string) => string | undefined;
  plan: Pick<MemoryFlushPlan, "recordWriteProvenance" | "clearWriteProvenance">;
  resolveOriginClass: () => "agent" | "untrusted";
  now?: () => number;
}): MemoryWriteProvenanceObserver | undefined {
  if (!params.plan.recordWriteProvenance) {
    return undefined;
  }
  const now = params.now ?? Date.now;
  const resolveRelativePath = (absolutePath: string) => {
    const mutationPath = params.resolveMutationPath
      ? params.resolveMutationPath(absolutePath)
      : absolutePath;
    // Remote-only paths cannot be safely classified with host realpath or a
    // lexical relative path; keep provenance fail-closed until the backend owns it.
    if (!mutationPath) {
      throw new Error("Memory write provenance requires a host-backed workspace.");
    }
    return resolveMemoryRelativePath(params.mutationRoot, mutationPath);
  };
  return {
    classifies: (absolutePath) => resolveRelativePath(absolutePath) !== undefined,
    write: async ({ absolutePath, contentBefore, contentAfter, commit }) => {
      const relativePath = resolveRelativePath(absolutePath);
      if (!relativePath) {
        await commit();
        return;
      }
      const rollback = await params.plan.recordWriteProvenance?.({
        workspaceDir: params.workspaceDir,
        relativePath,
        contentBefore,
        contentAfter,
        originClass: params.resolveOriginClass(),
        observedAt: now(),
      });
      try {
        await commit();
      } catch (error) {
        try {
          await rollback?.();
        } catch (rollbackError) {
          throw new Error(
            `File write failed and memory provenance rollback also failed: ${String(error)}`,
            { cause: rollbackError },
          );
        }
        throw error;
      }
    },
    clearAfterDelete: async (absolutePath) => {
      const relativePath = resolveRelativePath(absolutePath);
      if (!relativePath) {
        return;
      }
      try {
        await params.plan.clearWriteProvenance?.({
          workspaceDir: params.workspaceDir,
          relativePath,
        });
      } catch (error) {
        // The file is already gone. Retaining stale quarantine is safer than
        // reporting the filesystem mutation as failed after it committed.
        logWarn(`memory provenance cleanup failed for ${relativePath}: ${String(error)}`);
      }
    },
  };
}
