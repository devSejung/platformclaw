import type { SpaceConversation } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import type { ApplicationContext } from "../app/context.ts";
import { platformClawT } from "./i18n.ts";
import type { SpaceSnapshot } from "./spaces-view.ts";

/** A response must still belong to the connected browser identity that requested it. */
export async function requestSpaceGateway<T>(
  context: () => ApplicationContext,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const gateway = context().gateway.snapshot;
  if (gateway.phase !== "connected" || !gateway.client) {
    throw new Error(platformClawT("platformClaw.spaces.disconnected"));
  }
  const client = gateway.client;
  const result = await client.request<T>("platformclaw.spaces." + method, params);
  if (
    client !== context().gateway.snapshot.client ||
    context().gateway.snapshot.phase !== "connected"
  ) {
    throw new Error(platformClawT("platformClaw.spaces.disconnected"));
  }
  return result;
}

export function spaceGatewayErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : platformClawT("platformClaw.spaces.failed");
}

/** Narrow server snapshots before rendering user-specific tabs or management actions. */
export function normalizeSpaceSnapshot(snapshot: SpaceSnapshot): SpaceSnapshot {
  const conversations: SpaceConversation[] = [];
  for (const conversation of snapshot.conversations ?? []) {
    if (conversation.ownerId === snapshot.currentUserId) {
      conversations.push({
        ...conversation,
        canWrite: conversation.canWrite && snapshot.space.role !== "viewer",
      });
    }
  }
  return { ...snapshot, conversations };
}

export function upsertSpaceConversation(
  snapshot: SpaceSnapshot,
  conversation: SpaceConversation,
): SpaceSnapshot {
  const existing = snapshot.conversations.some((item) => item.id === conversation.id);
  return {
    ...snapshot,
    conversations: existing
      ? snapshot.conversations.map((item) => (item.id === conversation.id ? conversation : item))
      : [...snapshot.conversations, conversation],
  };
}
