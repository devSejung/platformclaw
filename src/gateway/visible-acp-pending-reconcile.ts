import fs from "node:fs";
import path from "node:path";
import { deleteAcpSessionMetaExactLifecycle } from "../acp/runtime/session-meta.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  listSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { handleSessionStateSessionDeleted } from "../sessions/session-state-events.js";
import { listGatewayAgentsBasic } from "./agent-list.js";
import { isVisibleAcpPendingSessionEntry } from "./visible-acp-session-initialization.js";

type VisibleAcpPendingReconcileResult = {
  checked: number;
  removed: number;
  skipped: number;
};

function sameLifecycle(left: SessionEntry | undefined, right: SessionEntry): boolean {
  return left?.sessionId === right.sessionId && left?.lifecycleRevision === right.lifecycleRevision;
}

function listReconciliationAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set(
    listGatewayAgentsBasic(cfg).agents.map((agent) => normalizeAgentId(agent.id)),
  );
  const agentsDir = path.join(resolveStateDir(), "agents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        ids.add(normalizeAgentId(entry.name));
      }
    }
  } catch {
    // No persisted per-agent state yet.
  }
  return [...ids].filter(Boolean).toSorted((left, right) => left.localeCompare(right));
}

/**
 * Remove only crash-orphaned visible ACP creation fences. Plugin/harness-owned
 * pending rows do not carry the core owner marker and remain recoverable.
 * This path intentionally never asks the ACP manager to ensure a runtime.
 */
export async function reconcileVisibleAcpPendingSessions(params: {
  cfg: OpenClawConfig;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<VisibleAcpPendingReconcileResult> {
  let checked = 0;
  let removed = 0;
  let skipped = 0;

  for (const agentId of listReconciliationAgentIds(params.cfg)) {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    let candidates: ReturnType<typeof listSessionEntriesReadOnly>;
    try {
      candidates = listSessionEntriesReadOnly({ agentId, storePath }).filter(({ entry }) =>
        isVisibleAcpPendingSessionEntry(entry),
      );
    } catch (error) {
      skipped += 1;
      params.log?.warn?.(`visible ACP pending scan failed for ${agentId}: ${String(error)}`);
      continue;
    }
    for (const candidate of candidates) {
      try {
        checked += 1;
        const snapshot = candidate.entry;
        const lifecycleRevision = snapshot.lifecycleRevision?.trim();
        const sessionId = snapshot.sessionId?.trim();
        if (!lifecycleRevision || !sessionId) {
          skipped += 1;
          params.log?.warn?.(
            `skipped visible ACP pending session without exact lifecycle identity: ${candidate.sessionKey}`,
          );
          continue;
        }
        const result = await runExclusiveSessionLifecycleMutation({
          scope: storePath,
          identities: [candidate.sessionKey, sessionId],
          run: async () => {
            const current = listSessionEntriesReadOnly({ agentId, storePath }).find(
              ({ sessionKey }) => sessionKey === candidate.sessionKey,
            )?.entry;
            if (!sameLifecycle(current, snapshot) || !isVisibleAcpPendingSessionEntry(current)) {
              return false;
            }
            // Remove the exact sidecar first. If row deletion later fails, the
            // still-visible pending row remains retryable on the next startup.
            deleteAcpSessionMetaExactLifecycle({
              sessionKey: candidate.sessionKey,
              lifecycleRevision,
            });
            const deletion = await deleteSessionEntryLifecycle({
              agentId,
              archiveTranscript: false,
              deleteTranscriptWithoutArchive: true,
              expectedEntry: current,
              expectedLifecycleRevision: lifecycleRevision,
              expectedSessionId: sessionId,
              storePath,
              target: {
                canonicalKey: candidate.sessionKey,
                storeKeys: [candidate.sessionKey],
              },
            });
            if (!deletion.deleted) {
              return false;
            }
            handleSessionStateSessionDeleted(candidate.sessionKey, agentId);
            return true;
          },
        });
        if (result) {
          removed += 1;
          params.log?.info?.(`removed crash-orphaned visible ACP session ${candidate.sessionKey}`);
        } else {
          skipped += 1;
        }
      } catch (error) {
        skipped += 1;
        params.log?.warn?.(
          `visible ACP pending reconciliation failed for ${candidate.sessionKey}: ${String(error)}`,
        );
      }
    }
  }

  return { checked, removed, skipped };
}
