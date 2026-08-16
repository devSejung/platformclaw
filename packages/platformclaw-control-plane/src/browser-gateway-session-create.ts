import type { BrowserGatewayAccess, BrowserGatewayRpc } from "./browser-gateway-contracts.js";

type JsonObject = Record<string, unknown>;

/** Creates a browser-owned session and relays its optional first turn. */
export async function createBrowserGatewaySession(params: {
  access: BrowserGatewayAccess;
  prepared: JsonObject;
  suppressCommandInterpretation: boolean;
  gateway: BrowserGatewayRpc;
  asObject(value: unknown, label: string): JsonObject;
  project(request: JsonObject, result: unknown): unknown;
  prepareChatSend(raw: JsonObject): JsonObject;
  createId(): string;
  fail(code: "invalid-params" | "upstream-result-denied", message: string): never;
}): Promise<unknown> {
  const message =
    typeof params.prepared.message === "string" && params.prepared.message.trim()
      ? params.prepared.message
      : undefined;
  const attachments = params.prepared.attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    params.fail("invalid-params", "sessions.create attachments must be an array");
  }
  const createParams = { ...params.prepared };
  delete createParams.message;
  delete createParams.attachments;
  const hasInitialTurn = Boolean(message || attachments?.length);
  if (hasInitialTurn && createParams.key === undefined && createParams.catalogId === undefined) {
    createParams.key = `agent:${params.access.binding.agentId}:dashboard:${params.createId()}`;
  }
  const rawCreated = await params.gateway.request("sessions.create", createParams);
  const created = params.asObject(
    params.project(createParams, rawCreated),
    "sessions.create result",
  );
  if (!hasInitialTurn || created.ok === false) {
    return created;
  }
  const key = typeof created.key === "string" ? created.key.trim() : "";
  if (!key) {
    params.fail("upstream-result-denied", "Gateway returned an invalid browser-created session");
  }
  try {
    const sendParams = params.prepareChatSend({
      sessionKey: key,
      message: message ?? "",
      ...(attachments?.length ? { attachments } : {}),
      idempotencyKey: params.createId(),
    });
    sendParams.suppressCommandInterpretation = params.suppressCommandInterpretation;
    const run = params.asObject(
      await params.gateway.request("chat.send", sendParams),
      "chat.send result",
    );
    return { ...created, runStarted: run.status === "started" };
  } catch (error) {
    return {
      ...created,
      runStarted: false,
      runError: {
        message:
          error instanceof Error && error.message.trim()
            ? error.message
            : "The session was created, but its first message could not be sent.",
      },
    };
  }
}
