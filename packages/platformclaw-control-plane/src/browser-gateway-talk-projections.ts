import { validateTalkClientCreateResult } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";

type JsonObject = Record<string, unknown>;

export function browserTalkObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new BrowserGatewayProxyError(
      "upstream-result-denied",
      `Gateway returned invalid ${label}`,
    );
  }
  return value;
}

export function projectBrowserTalkFields(value: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
}

export function projectBrowserTalkCatalog(value: unknown): JsonObject {
  const source = browserTalkObject(value, "Talk catalog");
  const groups = Object.fromEntries(
    ["speech", "transcription", "realtime"].map((key) => {
      const group = browserTalkObject(source[key], `Talk ${key} catalog`);
      const providers = Array.isArray(group.providers) ? group.providers : [];
      return [
        key,
        {
          ...projectBrowserTalkFields(group, ["activeProvider", "ready"]),
          providers: providers.map((provider) =>
            projectBrowserTalkFields(browserTalkObject(provider, "Talk provider"), [
              "id",
              "label",
              "configured",
              "aliases",
              "models",
              "voices",
              "defaultModel",
              "modes",
              "transports",
              "brains",
              "inputAudioFormats",
              "outputAudioFormats",
              "supportsBrowserSession",
              "supportsBargeIn",
              "supportsToolCalls",
              "supportsVideoFrames",
              "supportsSessionResumption",
            ]),
          ),
        },
      ];
    }),
  );
  return { ...projectBrowserTalkFields(source, ["modes", "transports", "brains"]), ...groups };
}

export function projectBrowserTalkConfig(value: unknown): JsonObject {
  const source = browserTalkObject(value, "Talk config");
  const config = browserTalkObject(source.config, "Talk config body");
  const talk = isRecord(config.talk) ? config.talk : {};
  const realtime = isRecord(talk.realtime) ? talk.realtime : {};
  return { config: { talk: { realtime: projectBrowserTalkFields(realtime, ["transport"]) } } };
}

export function projectBrowserTalkClientSession(value: unknown): JsonObject {
  const source = browserTalkObject(value, "Talk client session");
  const result = projectBrowserTalkFields(source, [
    "provider",
    "transport",
    "voiceSessionId",
    "clientSecret",
    "offerUrl",
    "offerHeaders",
    "protocol",
    "websocketUrl",
    "audio",
    "initialMessage",
    "model",
    "voice",
    "expiresAt",
  ]);
  if (
    !validateTalkClientCreateResult(result) ||
    (result.transport !== "webrtc" && result.transport !== "provider-websocket")
  ) {
    throw new BrowserGatewayProxyError(
      "upstream-result-denied",
      "Gateway returned an invalid browser Talk transport",
    );
  }
  const target = result.transport === "webrtc" ? result.offerUrl : result.websocketUrl;
  const isLocalOffer =
    result.transport === "webrtc" && typeof target === "string" && target.startsWith("/");
  if (
    !(result.transport === "webrtc" && target === undefined) &&
    (typeof target !== "string" ||
      (!isLocalOffer &&
        !isSecureTransportUrl(target, result.transport === "webrtc" ? "https:" : "wss:")))
  ) {
    throw new BrowserGatewayProxyError(
      "upstream-result-denied",
      "Gateway returned an invalid browser Talk endpoint",
    );
  }
  return result;
}

function isSecureTransportUrl(value: string, protocol: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === protocol && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

export function projectBrowserTalkRelaySession(value: unknown): JsonObject {
  const source = browserTalkObject(value, "Talk relay session");
  if (
    source.transport !== "gateway-relay" ||
    typeof source.sessionId !== "string" ||
    !source.sessionId
  ) {
    throw new BrowserGatewayProxyError(
      "upstream-result-denied",
      "Gateway returned an invalid Talk relay",
    );
  }
  return projectBrowserTalkFields(source, [
    "provider",
    "mode",
    "transport",
    "brain",
    "sessionId",
    "voiceSessionId",
    "relaySessionId",
    "transcriptionSessionId",
    "audio",
    "model",
    "voice",
    "expiresAt",
  ]);
}

export function projectBrowserTalkEventPayload(value: JsonObject): JsonObject {
  const result = projectBrowserTalkFields(value, [
    "relaySessionId",
    "transcriptionSessionId",
    "type",
    "audioBase64",
    "itemId",
    "responseId",
    "byteLength",
    "markName",
    "role",
    "text",
    "final",
    "callId",
    "name",
    "args",
    "forced",
    "result",
    "message",
    "code",
    "provider",
    "model",
    "transport",
    "phase",
    "reason",
  ]);
  if (isRecord(value.talkEvent)) {
    result.talkEvent = projectBrowserTalkFields(value.talkEvent, [
      "id",
      "type",
      "sessionId",
      "turnId",
      "captureId",
      "seq",
      "timestamp",
      "mode",
      "transport",
      "brain",
      "provider",
      "final",
      "callId",
      "itemId",
      "parentId",
      "payload",
    ]);
  }
  return result;
}
