import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveConfigDir } from "../utils.js";

const agentMediaContext = new AsyncLocalStorage<
  Readonly<{ agentId: string; mediaDir: string; sharedRoots: readonly string[] }>
>();

/** Pins the producer's canonical Agent owner across asynchronous media work. */
export function withAgentMediaContext<T>(agentId: string, callback: () => T): T {
  if (!isValidAgentId(agentId)) {
    throw new Error("Media requires a valid Agent owner.");
  }
  const canonicalAgentId = normalizeAgentId(agentId);
  if (agentMediaContext.getStore()?.agentId === canonicalAgentId) {
    return callback();
  }
  const mediaDir = path.join(resolveConfigDir(), "media");
  const sharedRoots = [resolveConfigDir(), resolveStateDir()].flatMap((base) => [
    path.resolve(base, "media"),
    resolvePathViaExistingAncestorSync(path.resolve(base, "media")),
  ]);
  return agentMediaContext.run(
    Object.freeze({ agentId: canonicalAgentId, mediaDir, sharedRoots: Object.freeze(sharedRoots) }),
    callback,
  );
}

export function getCurrentAgentMediaId(): string | undefined {
  return agentMediaContext.getStore()?.agentId;
}

/** Unscoped channel ingestion retains its shared store; Agent runs never inherit it. */
export function getAgentMediaDir(agentId = getCurrentAgentMediaId()): string {
  const mediaDir = agentMediaContext.getStore()?.mediaDir ?? path.join(resolveConfigDir(), "media");
  if (agentId === undefined) {
    return mediaDir;
  }
  if (!isValidAgentId(agentId)) {
    throw new Error("Media requires a valid Agent owner.");
  }
  return path.join(mediaDir, "agents", normalizeAgentId(agentId));
}

/** Existing shared files and another Agent's store are never new ownership proof. */
export function assertAgentMediaSourceOwner(filePath: string): void {
  const context = agentMediaContext.getStore();
  if (!context) {
    return;
  }
  const candidate = path.resolve(filePath);
  for (const sharedRoot of context.sharedRoots) {
    if (
      isPathInside(sharedRoot, candidate) &&
      !isPathInside(path.join(sharedRoot, "agents", context.agentId), candidate)
    ) {
      throw new Error(
        "This file belongs to another or unscoped attachment store. Upload it in this chat or create a new attachment from your current workspace.",
      );
    }
  }
}
