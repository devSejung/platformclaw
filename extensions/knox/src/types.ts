export type KnoxConversationType = "dm" | "room";

export type KnoxInboundMessage = {
  schemaVersion: 1;
  eventId: string;
  messageId: string;
  occurredAt: string;
  sender: { knoxUserId: string; displayName: string };
  conversation: {
    type: KnoxConversationType;
    providerType: "SINGLE" | "GROUP";
    conversationId: string;
    displayName?: string;
  };
  message: { type: "text"; text: string };
};

export type KnoxChannelConfig = {
  enabled?: boolean;
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
  configured: boolean;
  webhookPath: string;
  webhookSecret: string;
  outboundUrl: string;
  serviceToken: string;
  controlPlaneUrl: string;
  progressDelayMs: number;
};
