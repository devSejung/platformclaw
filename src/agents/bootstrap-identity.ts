import path from "node:path";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
} from "../commands/agents.config.js";
import { mutateConfigFileWithRetry } from "../config/config.js";
import type { IdentityConfig } from "../config/types.base.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveDefaultAgentId } from "./agent-scope.js";
import { loadAgentIdentityFromFile, sanitizeAgentIdentityLine } from "./identity-file.js";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace.js";

/** Persist the canonical Agent workspace identity into Gateway config. */
export async function syncAgentIdentityFromWorkspace(params: {
  agentId: string;
  workspaceDir: string;
}): Promise<void> {
  const identity = await loadAgentIdentityFromFile(
    path.join(params.workspaceDir, DEFAULT_IDENTITY_FILENAME),
  );
  if (!identity) {
    throw new Error("IDENTITY.md has no completed identity fields");
  }

  const theme = identity.theme ?? identity.creature ?? identity.vibe;
  const incomingIdentity: IdentityConfig = {
    ...(identity.name ? { name: sanitizeAgentIdentityLine(identity.name) } : {}),
    ...(identity.emoji ? { emoji: sanitizeAgentIdentityLine(identity.emoji) } : {}),
    ...(theme ? { theme: sanitizeAgentIdentityLine(theme) } : {}),
    ...(identity.avatar ? { avatar: sanitizeAgentIdentityLine(identity.avatar) } : {}),
  };
  const agentId = normalizeAgentId(params.agentId);

  await mutateConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    mutate: (draft) => {
      const entries = listAgentEntries(draft);
      const configured = findAgentEntryIndex(entries, agentId) >= 0;
      const implicitDefault =
        entries.length === 0 && agentId === normalizeAgentId(resolveDefaultAgentId(draft));
      if (!configured && !implicitDefault) {
        throw new Error(`agent "${agentId}" not found`);
      }
      Object.assign(draft, applyAgentConfig(draft, { agentId, identity: incomingIdentity }));
    },
  });
}
