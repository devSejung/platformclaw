import { ControlPlaneStateError } from "./contracts.js";
import { fetchWithSsrFGuard } from "./openclaw-runtime-network.js";

const MCP_OAUTH_FETCH_TIMEOUT_MS = 15_000;
const MCP_OAUTH_MAX_RESPONSE_BYTES = 1024 * 1024;

async function readBoundedBody(response: Response): Promise<ArrayBuffer | null> {
  if (!response.body) {
    return null;
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MCP_OAUTH_MAX_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new ControlPlaneStateError("MCP OAuth response is too large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > MCP_OAUTH_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ControlPlaneStateError("MCP OAuth response is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export function createMcpOAuthFetch(fetchImpl?: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const requestInit =
      input instanceof Request
        ? {
            method: input.method,
            headers: input.headers,
            body:
              input.method === "GET" || input.method === "HEAD" ? undefined : await input.blob(),
            signal: input.signal,
            ...init,
          }
        : init;
    const guarded = await fetchWithSsrFGuard({
      url,
      init: requestInit,
      fetchImpl,
      requireHttps: true,
      maxRedirects: 3,
      timeoutMs: MCP_OAUTH_FETCH_TIMEOUT_MS,
      auditContext: "platformclaw-mcp-oauth",
    });
    try {
      const body = await readBoundedBody(guarded.response);
      return new Response(body, {
        status: guarded.response.status,
        statusText: guarded.response.statusText,
        headers: guarded.response.headers,
      });
    } finally {
      await guarded.release();
    }
  };
}
