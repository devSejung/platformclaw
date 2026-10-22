type KnoxSelfSpaceFailure =
  | "login-required"
  | "room-disabled"
  | "space-unavailable"
  | "permission-denied"
  | "agent-unavailable"
  | "request-revoked"
  | "request-conflict"
  | "target-changed"
  | "request-settled";

export type KnoxSelfSpaceIdentity = {
  accountId: string;
  conversationType: "room";
  conversationId: string;
  knoxUserId: string;
  executionMode: "self_in_space";
  requestId: string;
  requestFingerprint: string;
  operation?: "reserve" | "validate" | "settle";
  admissionId?: string;
  outcome?: "finished" | "failed";
  phase?: "execute" | "publish";
};

export type KnoxSelfSpaceRoute = {
  status: "resolved";
  agentId: string;
  sessionKey: string;
  senderLinked: true;
  executionTarget: "platform_server" | "assigned_vm";
  selfInSpace: {
    admissionId: string;
    requestId: string;
    userId: string;
    spaceId: string;
    pageId: string;
    bindingId: string;
    bindingGeneration: number;
    conversationId: string;
    targetRevision: number;
    senderAttribution: { id: string; name: string; profileId: string; agentId: string };
  };
};

export type KnoxSelfSpaceResolution =
  | KnoxSelfSpaceRoute
  | { status: KnoxSelfSpaceFailure; admissionId: string };

export type KnoxSpaceBinding = {
  id: string;
  accountId: string;
  roomId: string;
  spaceId: string;
  pageId: string;
  generation: number;
  state: "active" | "disabled";
};
