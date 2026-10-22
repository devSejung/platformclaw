export type KnoxConversationType = "dm" | "room";

type KnoxInboundEnvelope = {
  eventId: string;
  messageId: string;
  occurredAt: string;
  sender: { knoxUserId: string; displayName: string };
  message: { type: "text"; text: string };
};

type KnoxInboundConversation = {
  type: KnoxConversationType;
  providerType: "SINGLE" | "GROUP";
  conversationId: string;
  displayName?: string;
};

export type KnoxInboundMessage = KnoxInboundEnvelope &
  (
    | { schemaVersion: 1; executionMode?: never; conversation: KnoxInboundConversation }
    | {
        schemaVersion: 2;
        executionMode: "self_in_space";
        conversation: KnoxInboundConversation & { type: "room"; providerType: "GROUP" };
      }
  );

export type KnoxChannelConfig = {
  enabled?: boolean;
  selfInSpaceEnabled?: boolean;
  accountId?: string;
  webhookSecret?: string;
  webhookSecretFile?: string;
  outboundUrl?: string;
  serviceToken?: string;
  serviceTokenFile?: string;
  controlPlaneUrl?: string;
  progressDelayMs?: number;
  accounts?: Record<string, KnoxChannelConfig>;
};

export type ResolvedKnoxAccount = {
  accountId: string;
  enabled: boolean;
  selfInSpaceEnabled: boolean;
  configured: boolean;
  webhookPath: string;
  webhookSecret: string;
  outboundUrl: string;
  serviceToken: string;
  controlPlaneUrl: string;
  progressDelayMs: number;
};
