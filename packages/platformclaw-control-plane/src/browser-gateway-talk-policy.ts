export const PLATFORMCLAW_WEB_TALK_METHODS = [
  "agent.wait",
  "talk.catalog",
  "talk.config",
  "talk.client.create",
  "talk.client.toolCall",
  "talk.client.transcript",
  "talk.client.close",
  "talk.client.steer",
  "talk.session.create",
  "talk.session.appendAudio",
  "talk.session.acknowledgeMark",
  "talk.session.cancelOutput",
  "talk.session.cancelTurn",
  "talk.session.submitToolResult",
  "talk.session.steer",
  "talk.session.close",
] as const;

const LAUNCH_FIELDS = [
  "sessionKey",
  "provider",
  "model",
  "voice",
  "vadThreshold",
  "silenceDurationMs",
  "prefixPaddingMs",
  "reasoningEffort",
  "mode",
  "transport",
  "brain",
];

/** Browser input excludes the service-owned clientOwnerId and every secret-bearing config field. */
export const PLATFORMCLAW_WEB_TALK_PARAMS = new Map<string, ReadonlySet<string>>([
  ["agent.wait", new Set(["runId", "timeoutMs"])],
  ["talk.catalog", new Set()],
  ["talk.config", new Set()],
  ["talk.client.create", new Set([...LAUNCH_FIELDS, "voiceSessionId", "capabilities"])],
  [
    "talk.client.toolCall",
    new Set(["sessionKey", "voiceSessionId", "relaySessionId", "callId", "name", "args"]),
  ],
  [
    "talk.client.transcript",
    new Set(["sessionKey", "voiceSessionId", "entryId", "role", "text", "timestamp"]),
  ],
  ["talk.client.close", new Set(["sessionKey", "voiceSessionId"])],
  ["talk.client.steer", new Set(["sessionKey", "text", "mode"])],
  ["talk.session.create", new Set([...LAUNCH_FIELDS, "language"])],
  ["talk.session.appendAudio", new Set(["sessionId", "audioBase64", "timestamp"])],
  ["talk.session.acknowledgeMark", new Set(["sessionId", "markName"])],
  ["talk.session.cancelOutput", new Set(["sessionId", "turnId", "reason"])],
  ["talk.session.cancelTurn", new Set(["sessionId", "turnId", "reason"])],
  ["talk.session.submitToolResult", new Set(["sessionId", "callId", "result", "options"])],
  ["talk.session.steer", new Set(["sessionId", "sessionKey", "text", "mode"])],
  ["talk.session.close", new Set(["sessionId"])],
]);

export const PLATFORMCLAW_TALK_OFFER_PREFIX = "/platformclaw/api/talk/offer/";
// The Gateway-owned browser transport exposes this exact public plugin contract.
// Never turn a returned or browser-selected arbitrary URL into an authenticated relay.
export const PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH = "/plugins/openai/realtime/calls";
