export type KnoxRouteResolution =
  | { status: "resolved"; agentId: string; sessionKey: string; senderLinked: boolean }
  | { status: "login-required" }
  | { status: "room-disabled" }
  | { status: "agent-unavailable" };

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
    const route = parseRoute(body);
    if (!route) {
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

function parseRoute(value: unknown): KnoxRouteResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    body.status === "login-required" ||
    body.status === "room-disabled" ||
    body.status === "agent-unavailable"
  ) {
    return { status: body.status };
  }
  if (
    body.status === "resolved" &&
    typeof body.agentId === "string" &&
    typeof body.sessionKey === "string" &&
    typeof body.senderLinked === "boolean"
  ) {
    return {
      status: "resolved",
      agentId: body.agentId,
      sessionKey: body.sessionKey,
      senderLinked: body.senderLinked,
    };
  }
  return null;
}
