import { createHash } from "node:crypto";
import { normalizeKnoxInbound } from "./normalize.js";
import type { KnoxInboundMessage } from "./types.js";

type KnoxSelfInSpaceRoute = {
  admissionId: string;
  requestId: string;
  userId: string;
  spaceId: string;
  pageId: string;
  bindingId: string;
  bindingGeneration: number;
  conversationId: string;
  targetRevision: number;
  senderAttribution: { id: string; name?: string; profileId: string; agentId: string };
};

export type KnoxRouteResolution =
  | {
      status: "resolved";
      agentId: string;
      sessionKey: string;
      senderLinked: boolean;
      executionTarget: "platform_server" | "assigned_vm" | null;
      selfInSpace?: KnoxSelfInSpaceRoute;
    }
  | { status: "login-required"; admissionId?: string }
  | { status: "room-disabled"; admissionId?: string }
  | { status: "agent-unavailable"; admissionId?: string }
  | {
      status:
        | "space-unavailable"
        | "permission-denied"
        | "request-revoked"
        | "request-conflict"
        | "target-changed"
        | "request-settled";
      admissionId: string;
    };

export function knoxRequestFingerprint(message: KnoxInboundMessage): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeKnoxInbound(message)))
    .digest("hex");
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Calls the control-plane-owned identity and room binding boundary. */
export class KnoxRoutingClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(
    options: { url: string; token: string; timeoutMs?: number },
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    const url = new URL(options.url);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Knox routing URL must be a credential-free HTTP(S) URL");
    }
    this.url = url.toString();
    this.token = options.token.trim();
    if (!this.token) {
      throw new Error("Knox routing service token is required");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async resolve(params: {
    accountId: string;
    conversationType: "dm" | "room";
    conversationId: string;
    knoxUserId: string;
    executionMode?: "self_in_space";
    requestId?: string;
    requestFingerprint?: string;
    operation?: "reserve" | "validate" | "settle";
    phase?: "execute" | "publish";
    admissionId?: string;
    outcome?: "finished" | "failed";
  }): Promise<KnoxRouteResolution> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error("Knox routing service unavailable", { cause: error });
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("Knox routing service response exceeded size limit");
    }
    const text = await readBoundedResponse(response);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new Error("Knox routing service returned invalid JSON", { cause: error });
    }
    if (!response.ok && response.status !== 503) {
      throw new Error(`Knox routing service rejected request (${response.status})`);
    }
    const route = parseKnoxRoute(body);
    if (
      !route ||
      (params.executionMode === "self_in_space" &&
        (route.status === "resolved"
          ? !route.selfInSpace || route.selfInSpace.requestId !== params.requestId
          : !route.admissionId?.trim()))
    ) {
      throw new Error("Knox routing service returned invalid response");
    }
    return route;
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Knox routing service response exceeded size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export function parseKnoxRoute(value: unknown): KnoxRouteResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    body.status === "login-required" ||
    body.status === "room-disabled" ||
    body.status === "agent-unavailable"
  ) {
    return {
      status: body.status,
      ...(typeof body.admissionId === "string" ? { admissionId: body.admissionId } : {}),
    };
  }
  if (
    [
      "space-unavailable",
      "permission-denied",
      "request-revoked",
      "request-conflict",
      "target-changed",
      "request-settled",
    ].includes(String(body.status)) &&
    typeof body.admissionId === "string"
  ) {
    return { status: body.status, admissionId: body.admissionId } as KnoxRouteResolution;
  }
  if (
    body.status === "resolved" &&
    typeof body.agentId === "string" &&
    typeof body.sessionKey === "string" &&
    typeof body.senderLinked === "boolean" &&
    (body.executionTarget === null ||
      body.executionTarget === "platform_server" ||
      body.executionTarget === "assigned_vm")
  ) {
    const self = body.selfInSpace;
    if (self !== undefined && !isSelfInSpaceRoute(self)) {
      return null;
    }
    return {
      status: "resolved",
      agentId: body.agentId,
      sessionKey: body.sessionKey,
      senderLinked: body.senderLinked,
      executionTarget: body.executionTarget,
      ...(self ? { selfInSpace: self } : {}),
    };
  }
  return null;
}

function isSelfInSpaceRoute(value: unknown): value is KnoxSelfInSpaceRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const route = value as Record<string, unknown>;
  const sender = route.senderAttribution as Record<string, unknown> | undefined;
  return (
    [
      "admissionId",
      "requestId",
      "userId",
      "spaceId",
      "pageId",
      "bindingId",
      "conversationId",
    ].every((key) => typeof route[key] === "string" && Boolean(route[key])) &&
    Number.isSafeInteger(route.bindingGeneration) &&
    Number.isSafeInteger(route.targetRevision) &&
    Boolean(
      sender &&
      typeof sender.id === "string" &&
      typeof sender.profileId === "string" &&
      typeof sender.agentId === "string" &&
      sender.profileId === route.userId,
    )
  );
}
