import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import {
  resolveUiDefaultAgentId,
  resolveUiSelectedSessionAgentId,
  uiSessionRowMatchesSelectedChat,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";

type SnapshotHost = UiSessionDefaultsHost & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionEpoch: number;
  sessionKey: string;
  sessions?: Partial<Pick<SessionCapability, "canonicalListRequestRevision">>;
  chatSelectedSessionSnapshot?: ChatSelectedSessionSnapshot;
  requestUpdate?: () => void;
};

export type ChatSelectedSessionSnapshot = {
  client: GatewayBrowserClient;
  connectionEpoch: number;
  sessionKey: string;
  agentId: string;
  row?: GatewaySessionRow | null;
  readKey?: string;
  generation: number;
  listRevision: number;
  listRequestFence: number;
  requestedRevision: number;
  missingFromList: boolean;
  pending: boolean;
};

type SnapshotRequest = { owner: ChatSelectedSessionSnapshot; generation: number };

function selectedAgentId(host: SnapshotHost): string {
  return resolveUiSelectedSessionAgentId(host) ?? resolveUiDefaultAgentId(host);
}

function ownsSnapshot(host: SnapshotHost, owner: ChatSelectedSessionSnapshot): boolean {
  return (
    host.chatSelectedSessionSnapshot === owner &&
    host.connected &&
    host.client === owner.client &&
    host.connectionEpoch === owner.connectionEpoch &&
    host.sessionKey === owner.sessionKey &&
    selectedAgentId(host) === owner.agentId
  );
}

function snapshotOwner(host: SnapshotHost): ChatSelectedSessionSnapshot | undefined {
  const current = host.chatSelectedSessionSnapshot;
  if (current && ownsSnapshot(host, current)) {
    return current;
  }
  host.chatSelectedSessionSnapshot = undefined;
  if (!host.connected || !host.client) {
    return undefined;
  }
  return (host.chatSelectedSessionSnapshot = {
    client: host.client,
    connectionEpoch: host.connectionEpoch,
    sessionKey: host.sessionKey,
    agentId: selectedAgentId(host),
    generation: 0,
    listRevision: -1,
    listRequestFence: -1,
    requestedRevision: -1,
    missingFromList: false,
    pending: false,
  });
}

export function captureChatSelectedSessionRequest(host: SnapshotHost): SnapshotRequest | undefined {
  const owner = snapshotOwner(host);
  if (!owner) {
    return undefined;
  }
  owner.listRequestFence = host.sessions?.canonicalListRequestRevision ?? owner.listRequestFence;
  return { owner, generation: ++owner.generation };
}

function storeSnapshotRow(
  owner: ChatSelectedSessionSnapshot,
  row: GatewaySessionRow | null | undefined,
): void {
  owner.generation += 1;
  owner.row = row ?? null;
  if (row) {
    owner.readKey = row.key;
  }
}

export function applyChatSelectedSessionSnapshot(
  host: SnapshotHost,
  row: GatewaySessionRow | null | undefined,
  request?: SnapshotRequest,
): void {
  const owner = request?.owner ?? snapshotOwner(host);
  if (
    !owner ||
    !ownsSnapshot(host, owner) ||
    (request && request.generation !== owner.generation) ||
    (row && !uiSessionRowMatchesSelectedChat(host, row.key, host.sessionKey))
  ) {
    return;
  }
  if (!request && owner.row === row) {
    return;
  }
  if (!request) {
    owner.listRequestFence = host.sessions?.canonicalListRequestRevision ?? owner.listRequestFence;
  }
  storeSnapshotRow(owner, row);
}

export function clearChatSelectedSessionSnapshot(host: SnapshotHost): void {
  host.chatSelectedSessionSnapshot = undefined;
}

export function readChatSelectedSessionSnapshot(host: SnapshotHost): GatewaySessionRow | undefined {
  const owner = host.chatSelectedSessionSnapshot;
  return owner && ownsSnapshot(host, owner) ? (owner.row ?? undefined) : undefined;
}

async function refreshMissingSelectedSession(
  host: SnapshotHost,
  owner: ChatSelectedSessionSnapshot,
): Promise<void> {
  if (owner.pending || !owner.readKey) {
    return;
  }
  owner.pending = true;
  try {
    // One targeted request follows each coalesced canonical refresh. A newer
    // refresh queues only one trailing read; no timer or child-row inference.
    while (
      ownsSnapshot(host, owner) &&
      owner.missingFromList &&
      owner.requestedRevision !== owner.listRevision
    ) {
      const revision = owner.listRevision;
      owner.requestedRevision = revision;
      const request = captureChatSelectedSessionRequest(host);
      try {
        const result = await owner.client.request<{ sessionInfo?: GatewaySessionRow }>(
          "chat.history",
          {
            sessionKey: owner.sessionKey,
            agentId: owner.agentId,
            limit: 1,
            maxChars: 1,
          },
        );
        if (owner.listRevision === revision) {
          // This request owns metadata only. Its deliberately tiny transcript
          // must never replace the pane's messages, pagination, or live run.
          applyChatSelectedSessionSnapshot(host, result?.sessionInfo, request);
        }
      } catch {
        // A missing or denied snapshot is unknown, never evidence that the
        // previously observed child is still running.
        if (owner.listRevision === revision) {
          applyChatSelectedSessionSnapshot(host, null, request);
        }
      }
      if (ownsSnapshot(host, owner)) {
        host.requestUpdate?.();
      }
    }
  } finally {
    owner.pending = false;
  }
}

export function syncChatSelectedSessionSnapshot(
  host: SnapshotHost,
  row: GatewaySessionRow | undefined,
  canonicalListRevision: number,
): void {
  const owner = snapshotOwner(host);
  if (!owner) {
    return;
  }
  const advanced = owner.listRevision !== canonicalListRevision;
  // Local history reconciliation republishes the same roster revision. It
  // must not replace newer selected-session metadata or retire its request.
  if (!advanced) {
    return;
  }
  owner.listRevision = canonicalListRevision;
  owner.missingFromList = row === undefined;
  if (row) {
    // Precise pane reads and accepted pushes retire already-started lists.
    // Parent updatedAt does not advance when only child activity changes.
    const requestRevision = host.sessions?.canonicalListRequestRevision;
    if (
      uiSessionRowMatchesSelectedChat(host, row.key, host.sessionKey) &&
      (requestRevision === undefined || requestRevision > owner.listRequestFence)
    ) {
      storeSnapshotRow(owner, row);
    }
    owner.requestedRevision = canonicalListRevision;
  } else if (canonicalListRevision > 0 && owner.readKey) {
    void refreshMissingSelectedSession(host, owner);
  }
}
