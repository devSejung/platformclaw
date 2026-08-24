import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import lockfile from "proper-lockfile";
import type { OrganizationMemoryDocument, OrganizationMemorySearchHit } from "./contracts.js";
import type { ExecutionHandoffService } from "./execution-handoff-service.js";

export const PLATFORMCLAW_EXECUTION_TARGET_PATH = "/platformclaw/internal/execution/target";
export const PLATFORMCLAW_EXECUTION_GRANT_PATH = "/platformclaw/internal/execution/grant";
export const PLATFORMCLAW_EXECUTION_CONNECTION_TARGET_PATH =
  "/platformclaw/internal/execution/connection-target";
export const PLATFORMCLAW_EXECUTION_CHANGE_TARGET_PATH =
  "/platformclaw/internal/execution/change-target";
export const PLATFORMCLAW_MCP_CONNECTION_PATH = "/platformclaw/internal/mcp/connection";
export const PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH =
  "/platformclaw/internal/execution/credentials";
export const PLATFORMCLAW_ORGANIZATION_MEMORY_SEARCH_PATH =
  "/platformclaw/internal/memory/organization/search";
export const PLATFORMCLAW_ORGANIZATION_MEMORY_GET_PATH =
  "/platformclaw/internal/memory/organization/get";

const MAX_REQUEST_BYTES = 4 * 1024;

type ExecutionHandoffHandler = Pick<
  ExecutionHandoffService,
  "resolveTarget" | "resolveConnectionTarget" | "changeTarget" | "issueCredentialGrant"
> & {
  resolveMcpConnection?: (
    agentId: string,
    serverName: string,
    serverUrl: string,
  ) => Promise<{
    headers: Record<string, string>;
    revision: number;
    expiresAt?: number;
  } | null>;
  resolveExecCredentials?: (agentId: string) => Promise<Record<string, string>>;
  searchOrganizationMemory?: (params: {
    agentId: string;
    query: string;
    maxResults?: number;
  }) => Promise<OrganizationMemorySearchHit[]>;
  getOrganizationMemory?: (params: {
    agentId: string;
    path: string;
    fromLine?: number;
    lineCount?: number;
  }) => Promise<OrganizationMemoryDocument | null>;
};

export function deriveExecutionHandoffAddress(credentialBrokerAddress: string): string {
  if (process.platform === "win32") {
    if (!credentialBrokerAddress.startsWith("\\\\.\\pipe\\")) {
      throw new Error("Windows credential broker address must be a named pipe");
    }
    return `${credentialBrokerAddress}-execution`;
  }
  if (!isAbsolute(credentialBrokerAddress)) {
    throw new Error("credential broker socket path must be absolute");
  }
  return join(dirname(credentialBrokerAddress), "execution.sock");
}

async function existingSocket(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

type SocketIdentity = {
  dev: number | bigint;
  ino: number | bigint;
};

function socketIdentity(stats: Awaited<ReturnType<typeof lstat>>): SocketIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameSocket(stats: Awaited<ReturnType<typeof lstat>>, identity: SocketIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
  });
}

async function removeSocketIfUnchanged(path: string, identity: SocketIdentity): Promise<void> {
  const current = await existingSocket(path);
  if (current && sameSocket(current, identity)) {
    await rm(path);
  }
}

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
  private ownedSocket: SocketIdentity | undefined;

  constructor(
    serviceToken: string,
    private readonly service: ExecutionHandoffHandler,
    private readonly socketPath: string,
  ) {
    this.expectedTokenDigest = tokenDigest(serviceToken);
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 5_000;
    this.server.keepAliveTimeout = 1_000;
    this.server.maxHeadersCount = 32;
  }

  async listen(): Promise<void> {
    if (this.started) {
      throw new Error("PlatformClaw execution handoff is already listening");
    }
    this.started = true;
    let ownedSocket: SocketIdentity | undefined;
    let releaseStartupLock: (() => Promise<void>) | undefined;
    try {
      if (process.platform !== "win32") {
        // Serializes stale-socket recovery and bind so concurrent Control starts
        // cannot unlink a successor's newly bound handoff endpoint.
        releaseStartupLock = await lockfile.lock(this.socketPath, {
          realpath: false,
          retries: {
            retries: 120,
            factor: 1,
            minTimeout: 100,
            maxTimeout: 100,
            randomize: true,
          },
          stale: 10_000,
        });
        const existing = await existingSocket(this.socketPath);
        if (existing) {
          if (!existing.isSocket() || existing.uid !== process.getuid?.()) {
            throw new Error("execution handoff path is not an owner-owned socket");
          }
          const identity = socketIdentity(existing);
          if (await socketAcceptsConnections(this.socketPath)) {
            throw new Error("execution handoff socket is already active");
          }
          const current = await existingSocket(this.socketPath);
          if (!current || !sameSocket(current, identity)) {
            throw new Error("execution handoff socket changed during startup");
          }
          await rm(this.socketPath);
        }
      }
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
        this.server.listen(this.socketPath);
      });
      if (process.platform !== "win32") {
        const created = await lstat(this.socketPath);
        ownedSocket = socketIdentity(created);
        this.ownedSocket = ownedSocket;
        await chmod(this.socketPath, 0o600);
      }
    } catch (error) {
      if (this.server.listening) {
        await new Promise<void>((resolve) => {
          this.server.close(() => resolve());
          this.server.closeAllConnections();
        });
      }
      if (ownedSocket && process.platform !== "win32") {
        await removeSocketIfUnchanged(this.socketPath, ownedSocket);
      }
      this.ownedSocket = undefined;
      this.started = false;
      throw error;
    } finally {
      await releaseStartupLock?.();
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
    if (process.platform !== "win32") {
      if (this.ownedSocket) {
        await removeSocketIfUnchanged(this.socketPath, this.ownedSocket);
      }
      this.ownedSocket = undefined;
    }
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
        pathname !== PLATFORMCLAW_EXECUTION_GRANT_PATH &&
        pathname !== PLATFORMCLAW_EXECUTION_CONNECTION_TARGET_PATH &&
        pathname !== PLATFORMCLAW_EXECUTION_CHANGE_TARGET_PATH &&
        pathname !== PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH &&
        pathname !== PLATFORMCLAW_MCP_CONNECTION_PATH &&
        pathname !== PLATFORMCLAW_ORGANIZATION_MEMORY_SEARCH_PATH &&
        pathname !== PLATFORMCLAW_ORGANIZATION_MEMORY_GET_PATH
      ) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const body = objectBody(await readJson(req));
      const agentId = requestAgentId(body);
      if (pathname === PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH) {
        if (!this.service.resolveExecCredentials) {
          sendJson(res, 503, { error: "exec credentials unavailable" });
          return;
        }
        sendJson(res, 200, await this.service.resolveExecCredentials(agentId));
        return;
      }
      if (pathname === PLATFORMCLAW_ORGANIZATION_MEMORY_SEARCH_PATH) {
        const query = typeof body.query === "string" ? body.query.trim() : "";
        const maxResults = body.maxResults;
        if (
          !query ||
          query.length > 1_000 ||
          (maxResults !== undefined &&
            (typeof maxResults !== "number" ||
              !Number.isSafeInteger(maxResults) ||
              maxResults < 1 ||
              maxResults > 50))
        ) {
          sendJson(res, 400, { error: "invalid organization memory search" });
          return;
        }
        if (!this.service.searchOrganizationMemory) {
          sendJson(res, 503, { error: "organization memory unavailable" });
          return;
        }
        sendJson(
          res,
          200,
          await this.service.searchOrganizationMemory({
            agentId,
            query,
            ...(typeof maxResults === "number" ? { maxResults } : {}),
          }),
        );
        return;
      }
      if (pathname === PLATFORMCLAW_ORGANIZATION_MEMORY_GET_PATH) {
        const path = typeof body.path === "string" ? body.path : "";
        const fromLine = body.fromLine;
        const lineCount = body.lineCount;
        if (
          !/^organization\/(global|team|group|part)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(path)
        ) {
          sendJson(res, 400, { error: "invalid organization memory path" });
          return;
        }
        if (
          (fromLine !== undefined &&
            (typeof fromLine !== "number" || !Number.isSafeInteger(fromLine) || fromLine < 1)) ||
          (lineCount !== undefined &&
            (typeof lineCount !== "number" ||
              !Number.isSafeInteger(lineCount) ||
              lineCount < 1 ||
              lineCount > 200))
        ) {
          sendJson(res, 400, { error: "invalid organization memory range" });
          return;
        }
        if (!this.service.getOrganizationMemory) {
          sendJson(res, 503, { error: "organization memory unavailable" });
          return;
        }
        const result = await this.service.getOrganizationMemory({
          agentId,
          path,
          ...(typeof fromLine === "number" ? { fromLine } : {}),
          ...(typeof lineCount === "number" ? { lineCount } : {}),
        });
        if (!result) {
          sendJson(res, 404, { error: "organization memory not found" });
          return;
        }
        sendJson(res, 200, result);
        return;
      }
      if (pathname === PLATFORMCLAW_MCP_CONNECTION_PATH) {
        const serverName = typeof body.serverName === "string" ? body.serverName.trim() : "";
        if (
          !serverName ||
          serverName.length > 128 ||
          serverName.includes("\0") ||
          serverName.includes("\r") ||
          serverName.includes("\n")
        ) {
          throw new Error("invalid MCP server name");
        }
        const rawServerUrl = typeof body.serverUrl === "string" ? body.serverUrl : "";
        let serverUrl: string;
        try {
          const parsed = new URL(rawServerUrl);
          if (
            (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
            parsed.username ||
            parsed.password ||
            parsed.hash
          ) {
            throw new Error("unsafe URL");
          }
          serverUrl = parsed.toString();
        } catch {
          throw new Error("invalid MCP server URL");
        }
        const connection = await this.service.resolveMcpConnection?.(
          agentId,
          serverName,
          serverUrl,
        );
        if (!connection) {
          sendJson(res, 404, { error: "MCP credential unavailable" });
          return;
        }
        sendJson(res, 200, connection);
        return;
      }
      if (pathname === PLATFORMCLAW_EXECUTION_TARGET_PATH) {
        const target = body.target;
        if (target !== undefined && target !== "platform_server" && target !== "assigned_vm") {
          throw new Error("invalid requested execution target");
        }
        sendJson(
          res,
          200,
          target
            ? await this.service.resolveTarget(agentId, target)
            : await this.service.resolveTarget(agentId),
        );
        return;
      }
      if (pathname === PLATFORMCLAW_EXECUTION_CONNECTION_TARGET_PATH) {
        sendJson(res, 200, await this.service.resolveConnectionTarget(agentId));
        return;
      }
      if (pathname === PLATFORMCLAW_EXECUTION_CHANGE_TARGET_PATH) {
        const target = body.target;
        const expectedRevision = body.expectedRevision;
        if (
          (target !== "platform_server" && target !== "assigned_vm") ||
          typeof expectedRevision !== "number"
        ) {
          throw new Error("invalid execution target change");
        }
        sendJson(
          res,
          200,
          await this.service.changeTarget({
            agentId,
            target,
            expectedRevision,
            changedAt: Date.now(),
          }),
        );
        return;
      }
      if (pathname === PLATFORMCLAW_EXECUTION_GRANT_PATH) {
        const allocationId = typeof body.allocationId === "string" ? body.allocationId : "";
        const targetRevision = body.targetRevision;
        const credentialRevision = body.credentialRevision;
        if (
          !allocationId ||
          typeof targetRevision !== "number" ||
          !Number.isSafeInteger(targetRevision) ||
          targetRevision < 0 ||
          typeof credentialRevision !== "number" ||
          !Number.isSafeInteger(credentialRevision) ||
          credentialRevision < 1
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
            credentialRevision,
          }),
        );
      }
    } catch {
      sendJson(res, 409, { error: "execution target unavailable" });
    }
  }
}
