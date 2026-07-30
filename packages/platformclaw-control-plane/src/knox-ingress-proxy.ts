import type { IncomingMessage, ServerResponse } from "node:http";

export const PLATFORMCLAW_KNOX_INBOUND_PATH = "/api/v1/platformclaw/knox/inbound";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 35_000;
const BODY_TIMEOUT_MS = 5_000;

class RequestBodyError extends Error {
  readonly kind: "too_large" | "timeout";

  constructor(kind: "too_large" | "timeout") {
    super(kind);
    this.kind = kind;
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        fail(new RequestBodyError("too_large"));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    const onError = (error: Error) => fail(error);
    const timer = setTimeout(() => fail(new RequestBodyError("timeout")), BODY_TIMEOUT_MS);
    timer.unref?.();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

/** Relays the one signed Knox route without exposing the private Gateway listener. */
export async function handlePlatformClawKnoxIngressProxy(
  req: IncomingMessage,
  res: ServerResponse,
  options: { targetUrl: string; fetchImpl?: typeof globalThis.fetch },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== PLATFORMCLAW_KNOX_INBOUND_PATH) {
    return false;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (error) {
    const timedOut = error instanceof RequestBodyError && error.kind === "timeout";
    sendJson(res, timedOut ? 408 : 413, {
      ok: false,
      error: timedOut ? "request_timeout" : "request_too_large",
    });
    return true;
  }
  const contentType = req.headers["content-type"];
  const timestamp = req.headers["x-platformclaw-timestamp"];
  const signature = req.headers["x-platformclaw-signature"];
  try {
    const upstream = await (options.fetchImpl ?? globalThis.fetch)(options.targetUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        ...(typeof contentType === "string" ? { "Content-Type": contentType } : {}),
        ...(typeof timestamp === "string" ? { "x-platformclaw-timestamp": timestamp } : {}),
        ...(typeof signature === "string" ? { "x-platformclaw-signature": signature } : {}),
      },
      body: Uint8Array.from(body).buffer,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const declaredLength = Number(upstream.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("response_too_large");
    }
    const responseBody = await readResponse(upstream);
    const forwardedStatus = new Set([200, 202, 400, 401, 405, 413, 415, 503]).has(upstream.status)
      ? upstream.status
      : 503;
    res.statusCode = forwardedStatus;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    res.end(
      forwardedStatus === upstream.status
        ? responseBody
        : Buffer.from('{"ok":false,"error":"knox_gateway_unavailable"}'),
    );
  } catch {
    sendJson(res, 503, { ok: false, error: "knox_gateway_unavailable" });
  }
  return true;
}

async function readResponse(response: Response): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, bytes);
    }
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
}
