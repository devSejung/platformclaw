import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { loadSessionEntryReadOnly } from "../session-utils.js";

export function isSessionFilePathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** File browsing and mutations share the same existing session workspace authority. */
export function loadSessionFileRoot(params: { sessionKey: string; agentId?: string }) {
  const loaded = loadSessionEntryReadOnly(params.sessionKey, { agentId: params.agentId });
  if (!loaded.entry?.sessionId) {
    return { ...loaded, agentId: undefined, root: undefined, fileRoot: undefined };
  }
  const agentId = normalizeAgentId(
    parseAgentSessionKey(loaded.canonicalKey)?.agentId ??
      params.agentId ??
      parseAgentSessionKey(params.sessionKey)?.agentId ??
      resolveDefaultAgentId(loaded.cfg),
  );
  const spawnedCwd = normalizeOptionalString(loaded.entry.spawnedCwd);
  const spawnedWorkspaceDir = normalizeOptionalString(loaded.entry.spawnedWorkspaceDir);
  const configuredWorkspaceDir =
    spawnedCwd || spawnedWorkspaceDir
      ? undefined
      : normalizeOptionalString(resolveAgentWorkspaceDir(loaded.cfg, agentId));
  // Keep this cwd precedence aligned with sessions.diff so the advertised
  // checkout state cannot disagree with the panel's fallback result.
  const diffCwd = spawnedCwd ?? spawnedWorkspaceDir ?? configuredWorkspaceDir;
  const root = spawnedWorkspaceDir ?? spawnedCwd ?? configuredWorkspaceDir;
  const fileRoot =
    root && spawnedCwd && isSessionFilePathInsideRoot(path.resolve(root), path.resolve(spawnedCwd))
      ? spawnedCwd
      : root;
  return { ...loaded, agentId, root, fileRoot, diffCwd };
}
