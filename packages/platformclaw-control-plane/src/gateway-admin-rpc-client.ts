import { randomUUID } from "node:crypto";

const DEFAULT_GATEWAY_ADMIN_RPC_TIMEOUT_MS = 15_000;
const MAX_ABORT_SIGNAL_TIMEOUT_MS = 2 ** 32 - 1;
const MAX_GATEWAY_ADMIN_RPC_RESPONSE_BYTES = 1024 * 1024;

export type GatewayAdminRpcClientConfig = {
  rpcUrl: string;
  bearerToken: string;
  timeoutMs?: number;
};

export interface GatewayAdminRpc {
  call<T>(method: string, params: unknown): Promise<T>;
}

type RpcErrorBody = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export class GatewayAdminRpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus?: number,
    readonly details?: unknown,
    readonly retryable?: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GatewayAdminRpcError";
  }
}

function normalizeRpcUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway Admin RPC URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Gateway Admin RPC URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Gateway Admin RPC URL must not contain query or fragment data");
  }
  return url.toString();
}

function parseError(value: unknown): RpcErrorBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") {
    return null;
  }
  return {
    code: record.code,
    message: record.message,
    ...(Object.hasOwn(record, "details") ? { details: record.details } : {}),
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    ...(typeof record.retryAfterMs === "number" ? { retryAfterMs: record.retryAfterMs } : {}),
  };
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_GATEWAY_ADMIN_RPC_RESPONSE_BYTES
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new GatewayAdminRpcError(
      "Gateway Admin RPC response exceeded the size limit",
      "INVALID_RESPONSE",
      response.status,
    );
  }
  if (!response.body) {
    throw new GatewayAdminRpcError(
      "Gateway Admin RPC returned an empty response",
      "INVALID_RESPONSE",
      response.status,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_GATEWAY_ADMIN_RPC_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new GatewayAdminRpcError(
          "Gateway Admin RPC response exceeded the size limit",
          "INVALID_RESPONSE",
          response.status,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof GatewayAdminRpcError) {
      throw error;
    }
    throw new GatewayAdminRpcError(
      "Gateway Admin RPC returned invalid JSON",
      "INVALID_RESPONSE",
      response.status,
    );
  }
}

export class HttpGatewayAdminRpcClient implements GatewayAdminRpc {
  private readonly config: Required<GatewayAdminRpcClientConfig>;

  constructor(
    config: GatewayAdminRpcClientConfig,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    const bearerToken = config.bearerToken.trim();
    if (!bearerToken) {
      throw new Error("Gateway Admin RPC bearer token is required");
    }
    const timeoutMs = config.timeoutMs ?? DEFAULT_GATEWAY_ADMIN_RPC_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_ABORT_SIGNAL_TIMEOUT_MS) {
      throw new Error("Gateway Admin RPC timeout must be an integer from 1 to 4294967295");
    }
    this.config = { rpcUrl: normalizeRpcUrl(config.rpcUrl), bearerToken, timeoutMs };
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const normalizedMethod = method.trim();
    if (!normalizedMethod) {
      throw new Error("Gateway Admin RPC method is required");
    }
    const id = randomUUID();
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.rpcUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.config.bearerToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        body: JSON.stringify({ id, method: normalizedMethod, params }),
      });
    } catch {
      throw new GatewayAdminRpcError("Gateway Admin RPC unavailable", "UNAVAILABLE");
    }

    const body = await readBoundedJsonResponse(response);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new GatewayAdminRpcError(
        "Gateway Admin RPC returned an invalid response",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    const record = body as Record<string, unknown>;
    if (record.id !== id) {
      throw new GatewayAdminRpcError(
        "Gateway Admin RPC response id did not match the request",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    if (record.ok === true && Object.hasOwn(record, "payload")) {
      return record.payload as T;
    }
    const error = record.ok === false ? parseError(record.error) : null;
    if (!error) {
      throw new GatewayAdminRpcError(
        "Gateway Admin RPC returned an invalid response",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    throw new GatewayAdminRpcError(
      error.message,
      error.code,
      response.status,
      error.details,
      error.retryable,
      error.retryAfterMs,
    );
  }
}
