import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import lockfile from "proper-lockfile";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type { ExecutionHandoffService } from "./execution-handoff-service.js";
import {
  KnowledgeVaultSearchError,
  type KnowledgeVaultTurnScope,
} from "./knowledge-vault-contracts.js";
import type { KnowledgeVaultWikiOperation } from "./knowledge-vault-operations.js";
import type { KnowledgeVaultService } from "./knowledge-vault-service.js";
import type { SpaceService } from "./space-service.js";

export const PLATFORMCLAW_EXECUTION_TARGET_PATH = "/platformclaw/internal/execution/target";
export const PLATFORMCLAW_EXECUTION_GRANT_PATH = "/platformclaw/internal/execution/grant";
export const PLATFORMCLAW_EXECUTION_CONNECTION_TARGET_PATH =
  "/platformclaw/internal/execution/connection-target";
export const PLATFORMCLAW_EXECUTION_CHANGE_TARGET_PATH =
  "/platformclaw/internal/execution/change-target";
export const PLATFORMCLAW_MCP_CONNECTION_PATH = "/platformclaw/internal/mcp/connection";
export const PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH =
  "/platformclaw/internal/execution/credentials";
export const PLATFORMCLAW_VAULT_SEARCH_PATH = "/platformclaw/internal/memory/vaults/search";
export const PLATFORMCLAW_VAULT_GET_PATH = "/platformclaw/internal/memory/vaults/get";
export const PLATFORMCLAW_VAULT_SCOPE_PATH = "/platformclaw/internal/memory/vaults/scope";

export const PLATFORMCLAW_VAULT_WIKI_PATH = "/platformclaw/internal/memory/vaults/wiki";

const SPACE_READ_PATH = "/platformclaw/internal/spaces/read";
export function parseSpaceReadRequest(
  body: Record<string, unknown>,
  agentId: string,
): Parameters<SpaceService["agentRead"]>[0] {
  const allowed = new Set([
    "agentId",
    "operation",
    "query",
    "spaceId",
    "pageId",
    "sessionKey",
    "runId",
    "messageId",
  ]);
  if (
    !["search", "get", "context"].includes(String(body.operation)) ||
    Object.keys(body).some((key) => !allowed.has(key)) ||
    ["query", "spaceId", "pageId", "sessionKey", "runId", "messageId"].some(
      (key) =>
        body[key] !== undefined &&
        (typeof body[key] !== "string" || (body[key] as string).length > 1000),
    )
  ) {
    throw new ControlPlaneStateError("Invalid Space read");
  }
  return {
    agentId,
    operation: body.operation as string,
    ...(body.query === undefined ? {} : { query: body.query as string }),
    ...(body.spaceId === undefined ? {} : { spaceId: body.spaceId as string }),
    ...(body.pageId === undefined ? {} : { pageId: body.pageId as string }),
    ...(body.sessionKey === undefined ? {} : { sessionKey: body.sessionKey as string }),
    ...(body.runId === undefined ? {} : { runId: body.runId as string }),
    ...(body.messageId === undefined ? {} : { messageId: body.messageId as string }),
  };
}

const MAX_REQUEST_BYTES = 4 * 1024;
// Turn selections travel between trusted services, never in the model's tool schema.
const MAX_VAULT_SEARCH_BYTES = 144 * 1024;

type ExecutionHandoffHandler = Pick<
  ExecutionHandoffService,
  "resolveTarget" | "resolveConnectionTarget" | "changeTarget" | "issueCredentialGrant"
> & {
  spaceService?: Pick<SpaceService, "agentRead">;
  vaultService?: Pick<KnowledgeVaultService, "search" | "get" | "captureScope" | "wiki">;
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

async function readJson(req: IncomingMessage, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > maxBytes) {
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

function readVaultTurnScope(value: unknown): KnowledgeVaultTurnScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  const scope = objectBody(value);
  if (
    typeof scope.personalEnabled !== "boolean" ||
    !Number.isSafeInteger(scope.revision) ||
    (scope.revision as number) < 0 ||
    !Array.isArray(scope.vaultIds) ||
    scope.vaultIds.length > 256 ||
    scope.vaultIds.some(
      (id) => typeof id !== "string" || id.length > 512 || !/^[a-zA-Z0-9:._-]+$/u.test(id),
    ) ||
    new Set(scope.vaultIds).size !== scope.vaultIds.length
  ) {
    throw new Error("Invalid vault turn scope");
  }
  return {
    revision: scope.revision as number,
    vaultIds: scope.vaultIds as string[],
    personalEnabled: scope.personalEnabled,
  };
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
        pathname !== SPACE_READ_PATH &&
        pathname !== PLATFORMCLAW_EXECUTION_TARGET_PATH &&
        pathname !== PLATFORMCLAW_EXECUTION_GRANT_PATH &&
        pathname !== PLATFORMCLAW_EXECUTION_CONNECTION_TARGET_PATH &&
        pathname !== PLATFORMCLAW_EXECUTION_CHANGE_TARGET_PATH &&
        pathname !== PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH &&
        pathname !== PLATFORMCLAW_MCP_CONNECTION_PATH &&
        pathname !== PLATFORMCLAW_VAULT_SEARCH_PATH &&
        pathname !== PLATFORMCLAW_VAULT_GET_PATH &&
        pathname !== PLATFORMCLAW_VAULT_SCOPE_PATH &&
        pathname !== PLATFORMCLAW_VAULT_WIKI_PATH
      ) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const body = objectBody(
        await readJson(
          req,
          pathname === PLATFORMCLAW_VAULT_WIKI_PATH
            ? 2 * 1024 * 1024
            : pathname === PLATFORMCLAW_VAULT_SEARCH_PATH
              ? MAX_VAULT_SEARCH_BYTES
              : MAX_REQUEST_BYTES,
        ),
      );
      const agentId = requestAgentId(body);
      if (pathname === SPACE_READ_PATH) {
        if (!this.service.spaceService) {
          sendJson(res, 503, { error: "Spaces unavailable" });
          return;
        }
        const result = await this.service.spaceService.agentRead(
          parseSpaceReadRequest(body, agentId),
        );
        sendJson(res, 200, result);
        return;
      }
      if (
        pathname === PLATFORMCLAW_VAULT_SEARCH_PATH ||
        pathname === PLATFORMCLAW_VAULT_GET_PATH ||
        pathname === PLATFORMCLAW_VAULT_SCOPE_PATH ||
        pathname === PLATFORMCLAW_VAULT_WIKI_PATH
      ) {
        if (!this.service.vaultService) {
          sendJson(res, 503, { error: "Wiki Hub unavailable" });
          return;
        }
        if (pathname === PLATFORMCLAW_VAULT_WIKI_PATH) {
          const turnScope = readVaultTurnScope(body.turnScope);
          if (
            (body.operation !== "status" &&
              body.operation !== "lint" &&
              body.operation !== "apply") ||
            (body.vaultId !== undefined &&
              (typeof body.vaultId !== "string" || !body.vaultId || body.vaultId.length > 512)) ||
            (body.vaultName !== undefined &&
              (typeof body.vaultName !== "string" ||
                !body.vaultName.trim() ||
                body.vaultName.length > 240))
          ) {
            throw new ControlPlaneStateError("Invalid Wiki operation or target");
          }
          const mutation = body.mutation === undefined ? undefined : objectBody(body.mutation);
          if (
            mutation &&
            ((mutation.op !== "create" && mutation.op !== "update" && mutation.op !== "refresh") ||
              ["title", "body", "lookup", "expectedRevision"].some(
                (key) => mutation[key] !== undefined && typeof mutation[key] !== "string",
              ) ||
              (typeof mutation.title === "string" && mutation.title.length > 240) ||
              (typeof mutation.lookup === "string" && mutation.lookup.length > 1024) ||
              (typeof mutation.expectedRevision === "string" &&
                mutation.expectedRevision.length > 64))
          ) {
            throw new ControlPlaneStateError("Invalid Wiki mutation");
          }
          sendJson(
            res,
            200,
            this.service.vaultService.wiki({
              agentId,
              operation: body.operation,
              vaultId: body.vaultId as string | undefined,
              vaultName: body.vaultName as string | undefined,
              turnScope,
              mutation: mutation as KnowledgeVaultWikiOperation["mutation"],
            }),
          );
        } else if (pathname === PLATFORMCLAW_VAULT_SEARCH_PATH) {
          let turnScope: KnowledgeVaultTurnScope | undefined;
          try {
            turnScope = readVaultTurnScope(body.turnScope);
          } catch {
            sendJson(res, 400, { error: "Invalid vault turn scope" });
            return;
          }
          if (
            typeof body.query !== "string" ||
            !body.query.trim() ||
            body.query.length > 1000 ||
            (body.vaultId !== undefined &&
              (typeof body.vaultId !== "string" || !body.vaultId || body.vaultId.length > 256)) ||
            (body.vaultName !== undefined &&
              (typeof body.vaultName !== "string" ||
                !body.vaultName.trim() ||
                body.vaultName.length > 240)) ||
            (body.vaultId !== undefined && body.vaultName !== undefined) ||
            (body.maxResults !== undefined &&
              (!Number.isSafeInteger(body.maxResults) ||
                (body.maxResults as number) < 1 ||
                (body.maxResults as number) > 50))
          ) {
            sendJson(res, 400, { error: "Invalid vault search" });
            return;
          }
          sendJson(
            res,
            200,
            await this.service.vaultService.search({
              agentId,
              query: body.query,
              ...(body.vaultId === undefined ? {} : { vaultId: body.vaultId as string }),
              ...(body.vaultName === undefined ? {} : { vaultName: body.vaultName as string }),
              ...(body.maxResults === undefined ? {} : { maxResults: body.maxResults as number }),
              ...(turnScope === undefined ? {} : { turnScope }),
            }),
          );
        } else if (pathname === PLATFORMCLAW_VAULT_SCOPE_PATH) {
          sendJson(res, 200, this.service.vaultService.captureScope({ agentId }));
        } else {
          if (
            typeof body.path !== "string" ||
            body.path.length > 1024 ||
            (body.fromLine !== undefined &&
              (!Number.isSafeInteger(body.fromLine) || (body.fromLine as number) < 1)) ||
            (body.lineCount !== undefined &&
              (!Number.isSafeInteger(body.lineCount) ||
                (body.lineCount as number) < 1 ||
                (body.lineCount as number) > 200))
          ) {
            sendJson(res, 400, { error: "Invalid vault document request" });
            return;
          }
          const result = await this.service.vaultService.get({
            agentId,
            path: body.path,
            ...(body.fromLine === undefined ? {} : { fromLine: body.fromLine as number }),
            ...(body.lineCount === undefined ? {} : { lineCount: body.lineCount as number }),
          });
          sendJson(res, result ? 200 : 404, result ?? { error: "Vault document unavailable" });
        }
        return;
      }
      if (pathname === PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH) {
        if (!this.service.resolveExecCredentials) {
          sendJson(res, 503, { error: "exec credentials unavailable" });
          return;
        }
        sendJson(res, 200, await this.service.resolveExecCredentials(agentId));
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
    } catch (error) {
      if (error instanceof KnowledgeVaultSearchError) {
        // Only the Vault owner may expose authorized disambiguation choices.
        // Other failures retain the generic response instead of leaking internal errors.
        sendJson(res, 409, {
          error: error.message.slice(0, 500),
          code: error.code,
          action: error.action.slice(0, 500),
          vaultChoices: error.vaultChoices.slice(0, 5),
        });
        return;
      }
      if (
        req.url?.split("?")[0] === PLATFORMCLAW_VAULT_WIKI_PATH &&
        (error instanceof ControlPlaneStateError ||
          error instanceof ControlPlaneConflictError ||
          error instanceof ControlPlaneAuthorizationError)
      ) {
        sendJson(res, 409, {
          error: error.message.slice(0, 500),
          code:
            error instanceof ControlPlaneAuthorizationError
              ? "wiki-forbidden"
              : error instanceof ControlPlaneConflictError
                ? "wiki-conflict"
                : "wiki-invalid",
          action: "Check Wiki access and read the current document before retrying a write.",
        });
        return;
      }
      sendJson(res, 409, { error: "execution target unavailable" });
    }
  }
}
