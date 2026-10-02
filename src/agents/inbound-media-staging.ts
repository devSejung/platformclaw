import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "../infra/fs-safe.js";
import type { MediaFact } from "../media/media-facts.js";
import { getMediaDir, MEDIA_MAX_BYTES } from "../media/store.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
import type { SandboxContext } from "./sandbox/types.js";

const INBOUND_MEDIA_PREFIX = "media/inbound/";

function isUnstagedManagedAttachment(fact: MediaFact): boolean {
  const filePath = fact.path;
  if (!filePath || fact.workspaceDir) {
    return false;
  }
  const mime = fact.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  // Managed PDFs retain their existing host-side document-tool fallback; they
  // must not be advertised as VM files unless workspace staging actually lands.
  if (mime === "application/pdf" || mime?.endsWith("+pdf") || /\.pdf$/i.test(filePath)) {
    return false;
  }
  if (filePath.startsWith("media://inbound/")) {
    return true;
  }
  if (!path.isAbsolute(filePath)) {
    return false;
  }
  const relative = path.relative(path.join(getMediaDir(), "inbound"), filePath);
  return (
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

type InboundMediaSandboxStageSkipReason = "missing-path" | "missing-workspace-dir";

type InboundMediaSandboxStageResult = {
  staged: Array<{ index: number; path: string; status: "created" | "reused" }>;
  skipped: Array<{ index: number; path?: string; reason: InboundMediaSandboxStageSkipReason }>;
};

function resolveStagedInboundPath(params: {
  filePath: string;
  declaredWorkspace: string;
}): string | null {
  const { filePath, declaredWorkspace } = params;
  if (filePath.includes("\0")) {
    return null;
  }
  let workspaceRelativePath = filePath;
  if (path.isAbsolute(filePath)) {
    const relative = path.relative(path.resolve(declaredWorkspace), path.resolve(filePath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    workspaceRelativePath = relative;
  } else if (path.win32.isAbsolute(filePath)) {
    // A foreign Windows absolute path cannot be proven to belong to a non-Windows
    // Gateway workspace. Treat it as malformed claimed staging metadata.
    return null;
  }
  const posixPath = workspaceRelativePath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(posixPath);
  if (
    normalized !== posixPath ||
    !normalized.startsWith(INBOUND_MEDIA_PREFIX) ||
    normalized.length === INBOUND_MEDIA_PREFIX.length
  ) {
    return null;
  }
  return normalized;
}

function sameCanonicalPath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

type BoundWorkspace = {
  sourceRoot: string;
  bridgeCwd: string;
};

type InboundMediaSandboxTarget = Pick<SandboxContext, "workspaceDir" | "fsBridge"> &
  Partial<Pick<SandboxContext, "agentWorkspaceDir">>;

async function resolveAllowedWorkspaceBindings(
  sandbox: InboundMediaSandboxTarget,
): Promise<Array<{ canonicalRoot: string; bridgeCwd: string }>> {
  const roots = [sandbox.workspaceDir, sandbox.agentWorkspaceDir].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index,
  );
  const bindings: Array<{ canonicalRoot: string; bridgeCwd: string }> = [];
  for (const bridgeCwd of roots) {
    try {
      bindings.push({
        canonicalRoot: await fs.realpath(path.resolve(bridgeCwd)),
        bridgeCwd,
      });
    } catch (error) {
      const isOptionalAgentRoot =
        bridgeCwd === sandbox.agentWorkspaceDir && bridgeCwd !== sandbox.workspaceDir;
      if (isOptionalAgentRoot && (error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return bindings;
}

async function bindClaimedWorkspace(params: {
  declaredWorkspace: string;
  allowed: Array<{ canonicalRoot: string; bridgeCwd: string }>;
}): Promise<BoundWorkspace> {
  if (!path.isAbsolute(params.declaredWorkspace)) {
    throw new Error("Staged attachment workspace must be an absolute local workspace path.");
  }
  const sourceRoot = await fs.realpath(path.resolve(params.declaredWorkspace));
  const binding = params.allowed.find((candidate) =>
    sameCanonicalPath(candidate.canonicalRoot, sourceRoot),
  );
  if (!binding) {
    throw new Error("Staged attachment workspace does not match an active sandbox workspace.");
  }
  return { sourceRoot, bridgeCwd: binding.bridgeCwd };
}

function requireExclusiveCreate(bridge: SandboxFsBridge) {
  const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
  if (!createFileExclusive) {
    throw new Error(
      "Sandbox filesystem bridge does not support atomic file creation for inbound media staging.",
    );
  }
  return createFileExclusive;
}

async function assertReusableRemoteFile(params: {
  bridge: SandboxFsBridge;
  filePath: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const existing = await params.bridge.stat({
    filePath: params.filePath,
    cwd: params.cwd,
    signal: params.signal,
  });
  if (!existing) {
    return false;
  }
  if (existing.type !== "file") {
    throw new Error(
      `Sandbox inbound media destination is not a regular file: ${params.filePath} (${existing.type})`,
    );
  }
  return true;
}

/**
 * Projects already-staged Gateway inbound facts into a backend-owned sandbox filesystem.
 * The fact path remains the stable identity; retries preserve an existing regular VM file.
 */
export async function stageInboundMediaForSandbox(params: {
  sandbox?: InboundMediaSandboxTarget | null;
  media: readonly MediaFact[] | null | undefined;
  maxBytes?: number;
  signal?: AbortSignal;
}): Promise<InboundMediaSandboxStageResult> {
  const sandbox = params.sandbox;
  if (!sandbox || !params.media?.length) {
    return { staged: [], skipped: [] };
  }
  const bridge = sandbox.fsBridge;
  if (!bridge) {
    if (
      params.media.some(
        (fact) => fact.workspaceDir || fact.staged === true || isUnstagedManagedAttachment(fact),
      )
    ) {
      throw new Error("Staged attachments require a sandbox filesystem bridge.");
    }
    return { staged: [], skipped: [] };
  }

  const result: InboundMediaSandboxStageResult = { staged: [], skipped: [] };
  const sourceRoots = new Map<string, Awaited<ReturnType<typeof fsRoot>>>();
  const maxBytes = params.maxBytes ?? MEDIA_MAX_BYTES;
  let allowedWorkspacesPromise:
    | Promise<Array<{ canonicalRoot: string; bridgeCwd: string }>>
    | undefined;
  const getAllowedWorkspaces = () =>
    (allowedWorkspacesPromise ??= resolveAllowedWorkspaceBindings(sandbox));

  for (const [index, fact] of params.media.entries()) {
    params.signal?.throwIfAborted();
    if (!fact.path) {
      if (fact.workspaceDir || fact.staged === true) {
        throw new Error(`Staged attachment at media index ${index} is missing its path.`);
      }
      result.skipped.push({ index, reason: "missing-path" });
      continue;
    }
    if (!fact.workspaceDir) {
      if (isUnstagedManagedAttachment(fact)) {
        throw new Error(
          `Inbound attachment was not staged into the execution workspace at media index ${index}; retry the upload.`,
        );
      }
      if (fact.staged === true) {
        throw new Error(
          `Staged attachment at media index ${index} is missing its owning workspace.`,
        );
      }
      result.skipped.push({ index, path: fact.path, reason: "missing-workspace-dir" });
      continue;
    }
    if (!path.isAbsolute(fact.workspaceDir)) {
      throw new Error(
        `Staged attachment workspace must be absolute at media index ${index}: ${fact.workspaceDir}`,
      );
    }
    const boundWorkspace = await bindClaimedWorkspace({
      declaredWorkspace: fact.workspaceDir,
      allowed: await getAllowedWorkspaces(),
    });
    const relativePath = resolveStagedInboundPath({
      filePath: fact.path,
      declaredWorkspace: fact.workspaceDir,
    });
    if (!relativePath) {
      throw new Error(
        `Staged attachment path is not a managed media/inbound path at media index ${index}: ${fact.path}`,
      );
    }

    if (
      await assertReusableRemoteFile({
        bridge,
        filePath: relativePath,
        cwd: boundWorkspace.bridgeCwd,
        signal: params.signal,
      })
    ) {
      result.staged.push({ index, path: relativePath, status: "reused" });
      continue;
    }

    const createFileExclusive = requireExclusiveCreate(bridge);
    let sourceRoot = sourceRoots.get(boundWorkspace.sourceRoot);
    if (!sourceRoot) {
      sourceRoot = await fsRoot(boundWorkspace.sourceRoot);
      sourceRoots.set(boundWorkspace.sourceRoot, sourceRoot);
    }
    const hostRelativePath = relativePath.split("/").join(path.sep);
    const source = await sourceRoot.read(hostRelativePath, {
      hardlinks: "reject",
      maxBytes,
      nonBlockingRead: true,
      symlinks: "reject",
    });
    params.signal?.throwIfAborted();
    const publication = await createFileExclusive({
      filePath: relativePath,
      cwd: boundWorkspace.bridgeCwd,
      data: source.buffer,
      mkdir: true,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    if (publication === "created") {
      result.staged.push({ index, path: relativePath, status: "created" });
      continue;
    }

    if (
      !(await assertReusableRemoteFile({
        bridge,
        filePath: relativePath,
        cwd: boundWorkspace.bridgeCwd,
        signal: params.signal,
      }))
    ) {
      throw new Error(
        `Sandbox inbound media destination disappeared after an exclusive-create collision: ${relativePath}`,
      );
    }
    result.staged.push({ index, path: relativePath, status: "reused" });
  }

  return result;
}
