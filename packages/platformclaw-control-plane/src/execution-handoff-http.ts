import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type { ExecutionHandoffService } from "./execution-handoff-service.js";

export const PLATFORMCLAW_EXECUTION_TARGET_PATH = "/platformclaw/internal/execution/target";
export const PLATFORMCLAW_EXECUTION_GRANT_PATH = "/platformclaw/internal/execution/grant";

const MAX_REQUEST_BYTES = 4 * 1024;

type InternalListenOptions = { host: string; port: number };
type ExecutionHandoffHandler = Pick<
  ExecutionHandoffService,
  "resolveTarget" | "issueCredentialGrant"
>;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | null {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token && token === token.trim() ? token : null;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error("request too large");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid request body");
  }
  return value as Record<string, unknown>;
}

function requestAgentId(body: Record<string, unknown>): string {
  const agentId = typeof body.agentId === "string" ? body.agentId : "";
  if (!isValidAgentId(agentId) || agentId !== agentId.toLowerCase()) {
    throw new Error("invalid agent id");
  }
  return agentId;
}

export class PlatformClawExecutionHandoffServer {
  private readonly expectedTokenDigest: Buffer;
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { error: "internal execution handoff failed" });
    });
  });
  private started = false;

  constructor(
    serviceToken: string,
    private readonly service: ExecutionHandoffHandler,
  ) {
    this.expectedTokenDigest = tokenDigest(serviceToken);
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 5_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.maxHeadersCount = 32;
  }

  async listen(options: InternalListenOptions): Promise<void> {
    if (this.started) {
      throw new Error("PlatformClaw execution handoff is already listening");
    }
    this.started = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.server.off("error", onError);
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(options.port, options.host);
      });
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  address(): ReturnType<typeof this.server.address> {
    return this.server.address();
  }

  async close(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    await new Promise<void>((resolve, reject) => {
      // The internal listener must not keep Control shutdown blocked on a stale client.
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const supplied = bearerToken(req);
    return supplied ? timingSafeEqual(tokenDigest(supplied), this.expectedTokenDigest) : false;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    try {
      const pathname = new URL(req.url ?? "/", "http://platformclaw.internal").pathname;
      if (
        pathname !== PLATFORMCLAW_EXECUTION_TARGET_PATH &&
        pathname !== PLATFORMCLAW_EXECUTION_GRANT_PATH
      ) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const body = objectBody(await readJson(req));
      const agentId = requestAgentId(body);
      if (pathname === PLATFORMCLAW_EXECUTION_TARGET_PATH) {
        sendJson(res, 200, await this.service.resolveTarget(agentId));
        return;
      }
      if (pathname === PLATFORMCLAW_EXECUTION_GRANT_PATH) {
        const allocationId = typeof body.allocationId === "string" ? body.allocationId : "";
        const targetRevision = body.targetRevision;
        if (
          !allocationId ||
          typeof targetRevision !== "number" ||
          !Number.isSafeInteger(targetRevision) ||
          targetRevision < 0
        ) {
          throw new Error("invalid credential grant target");
        }
        sendJson(
          res,
          200,
          await this.service.issueCredentialGrant({
            agentId,
            allocationId,
            targetRevision,
          }),
        );
      }
    } catch {
      sendJson(res, 409, { error: "execution target unavailable" });
    }
  }
}
