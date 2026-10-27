import path from "node:path";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { logWarn } from "../logger.js";
import type { MemoryFlushPlan } from "../plugins/memory-state.js";

export type MemoryWriteProvenanceObserver = {
  classifies: (absolutePath: string) => Promise<boolean>;
  write: (params: {
    absolutePath: string;
    contentBefore: string;
    contentAfter: string;
    commit: () => Promise<void>;
  }) => Promise<void>;
  remove: (params: { absolutePath: string; commit: () => Promise<void> }) => Promise<void>;
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
      if (!(await observer.classifies(absolutePath))) {
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
          remove: (absolutePath: string) =>
            observer.remove({ absolutePath, commit: () => remove(absolutePath) }),
        }
      : {}),
  } as T;
}

export function resolveHostProvenanceRelativePath(
  root: string,
  absolutePath: string,
  operation: "write" | "remove" = "write",
): string | undefined {
  const mutationPath =
    operation === "remove"
      ? path.join(
          resolvePathViaExistingAncestorSync(path.dirname(absolutePath)),
          path.basename(absolutePath),
        )
      : resolvePathViaExistingAncestorSync(absolutePath);
  const relativePath = path.relative(resolvePathViaExistingAncestorSync(root), mutationPath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  return relativePath.replaceAll(path.sep, "/");
}

function classifyMemoryRelativePath(relativePath: string | undefined): string | undefined {
  if (!relativePath) {
    return undefined;
  }
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (["MEMORY.md", "memory.md", "USER.md"].includes(normalized)) {
    return normalized;
  }
  return normalized.startsWith("memory/") && normalized.endsWith(".md") ? normalized : undefined;
}

export function createMemoryWriteProvenanceObserver(params: {
  mutationRoot: string;
  workspaceDir: string;
  /** Resolve mutation entries in the filesystem owner's canonical workspace. */
  resolveRelativePath?: (
    absolutePath: string,
    operation: "write" | "remove",
  ) => Promise<string | undefined>;
  plan: Pick<MemoryFlushPlan, "recordWriteProvenance" | "clearWriteProvenance">;
  resolveOriginClass: () => "agent" | "untrusted";
  now?: () => number;
}): MemoryWriteProvenanceObserver | undefined {
  if (!params.plan.recordWriteProvenance) {
    return undefined;
  }
  const now = params.now ?? Date.now;
  const resolveRelativePath = async (
    absolutePath: string,
    operation: "write" | "remove" = "write",
  ) => {
    const relativePath = params.resolveRelativePath
      ? await params.resolveRelativePath(absolutePath, operation)
      : resolveHostProvenanceRelativePath(params.mutationRoot, absolutePath, operation);
    return classifyMemoryRelativePath(relativePath);
  };
  return {
    classifies: async (absolutePath) => (await resolveRelativePath(absolutePath)) !== undefined,
    write: async ({ absolutePath, contentBefore, contentAfter, commit }) => {
      const relativePath = await resolveRelativePath(absolutePath);
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
    remove: async ({ absolutePath, commit }) => {
      // Pin provenance identity before deletion. Cleanup must not resolve an
      // already-deleted entry or fail after the filesystem effect succeeded.
      const relativePath = await resolveRelativePath(absolutePath, "remove");
      await commit();
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
