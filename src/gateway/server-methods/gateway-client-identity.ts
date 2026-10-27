// Projects prepared connection identity into user-turn attribution fields.
import type { ChatSenderAttribution } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayClient } from "./shared-types.js";

type GatewayClientSender = ChatSenderAttribution;

/** Normalize wire attribution before any send scope or session lifecycle is acquired. */
export function normalizeRequestedGatewaySenderAttribution(
  sender: GatewayClientSender | undefined,
): { ok: true; value: GatewayClientSender | undefined } | { ok: false; error: string } {
  if (!sender) {
    return { ok: true, value: undefined };
  }
  const id = sender.id.trim();
  if (!id) {
    return { ok: false, error: "sender attribution id must not be blank" };
  }
  return {
    ok: true,
    value: {
      id,
      ...(sender.name?.trim() ? { name: sender.name.trim() } : {}),
      ...(sender.profileId?.trim() ? { profileId: sender.profileId.trim() } : {}),
      ...(sender.agentId?.trim() ? { agentId: sender.agentId.trim() } : {}),
      ...(sender.isOwner === false ? { isOwner: false } : {}),
    },
  };
}

/** Request identity may override attribution; either source's explicit denial remains. */
export function resolveGatewaySenderAttribution(
  client: GatewayClient | null,
  requestSender?: GatewayClientSender,
): GatewayClientSender | undefined {
  const internalSender = client?.internal?.senderAttribution;
  const sender = requestSender ?? internalSender;
  return sender && (requestSender?.isOwner === false || internalSender?.isOwner === false)
    ? { ...sender, isOwner: false }
    : sender;
}

/** The proxy's credential authorizes dispatch; the attributed human owns the run's authority. */
export function gatewayClientSenderIsOwner(
  client: GatewayClient | null,
  requestSender?: GatewayClientSender,
): boolean | undefined {
  const sender = resolveGatewaySenderAttribution(client, requestSender);
  if (sender?.isOwner === false) {
    return false;
  }
  const scopes = client?.connect?.scopes;
  // Legacy non-admin clients may resolve ownership from their sender identity
  // later. Absence is not an explicit ingress denial.
  return Array.isArray(scopes) && scopes.includes(ADMIN_SCOPE) ? true : undefined;
}

export function gatewayClientSenderFields(
  client: GatewayClient | null,
  requestSender?: GatewayClientSender,
): {
  sender?: GatewayClientSender;
} {
  const sender = resolveGatewaySenderAttribution(client, requestSender);
  if (sender) {
    return { sender };
  }
  const profile = client?.authenticatedUserProfile;
  if (profile) {
    return {
      sender: {
        id: profile.profileId,
        ...(profile.displayName ? { name: profile.displayName } : {}),
      },
    };
  }
  return client?.authenticatedUserId ? { sender: { id: client.authenticatedUserId } } : {};
}

/** Returns the same durable human profile identity used for session creation attribution. */
export function gatewayClientSessionCreator(client: GatewayClient | null) {
  const profile = client?.authenticatedUserProfile;
  return profile
    ? {
        type: "human" as const,
        id: profile.profileId,
        ...(profile.displayName ? { label: profile.displayName } : {}),
      }
    : undefined;
}
