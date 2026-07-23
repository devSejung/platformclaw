import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { ControlPlaneStateError } from "./contracts.js";
import { OneShotCredentialGrantStore } from "./credential-broker-grants.js";
import type { ResolvedUserSshCredential } from "./ssh-credential-vault.js";

const REQUEST_HEADER_BYTES = 2;
const RESPONSE_HEADER_BYTES = 13;
const MAX_TOKEN_BYTES = 256;
const MAX_PASSWORD_BYTES = 8 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 64;

const RESPONSE_OK = 0;
const RESPONSE_ERROR = 1;

export type LocalCredentialBrokerOptions = {
  address: string;
  grants: OneShotCredentialGrantStore;
  idleTimeoutMs?: number;
  maxConnections?: number;
};

function validateAddress(address: string): void {
  if (process.platform === "win32") {
    if (!address.startsWith("\\\\.\\pipe\\")) {
      throw new ControlPlaneStateError("Windows credential broker address must be a named pipe");
    }
    return;
  }
  if (!isAbsolute(address)) {
    throw new ControlPlaneStateError("credential broker socket path must be absolute");
  }
}

function encodeRequest(token: string): Buffer {
  const tokenBytes = Buffer.from(token, "utf8");
  if (tokenBytes.length === 0 || tokenBytes.length > MAX_TOKEN_BYTES) {
    throw new ControlPlaneStateError("credential broker token length is invalid");
  }
  const frame = Buffer.allocUnsafe(REQUEST_HEADER_BYTES + tokenBytes.length);
  frame.writeUInt16BE(tokenBytes.length, 0);
  tokenBytes.copy(frame, REQUEST_HEADER_BYTES);
  tokenBytes.fill(0);
  return frame;
}

function encodeResponse(status: number, revision: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(RESPONSE_HEADER_BYTES + payload.length);
  frame.writeUInt8(status, 0);
  frame.writeBigUInt64BE(BigInt(revision), 1);
  frame.writeUInt32BE(payload.length, 9);
  payload.copy(frame, RESPONSE_HEADER_BYTES);
  return frame;
}

function genericErrorFrame(): Buffer {
  return encodeResponse(RESPONSE_ERROR, 0, Buffer.from("credential_unavailable", "ascii"));
}

async function prepareUnixSocket(address: string): Promise<void> {
  const parent = dirname(address);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  const processUid = process.getuid?.();
  if (
    processUid === undefined ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o777) !== 0o700 ||
    parentStat.uid !== processUid
  ) {
    throw new ControlPlaneStateError(
      "credential broker parent must be an owner-only directory owned by this process",
    );
  }
  try {
    await lstat(address);
    // Never guess that an existing socket is stale: unlinking could strand a live broker.
    throw new ControlPlaneStateError("credential broker path already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function readRequest(frame: Buffer): string {
  if (frame.length < REQUEST_HEADER_BYTES) {
    throw new ControlPlaneStateError("credential broker request is incomplete");
  }
  const tokenLength = frame.readUInt16BE(0);
  if (
    tokenLength === 0 ||
    tokenLength > MAX_TOKEN_BYTES ||
    frame.length !== REQUEST_HEADER_BYTES + tokenLength
  ) {
    throw new ControlPlaneStateError("credential broker request framing is invalid");
  }
  return frame.subarray(REQUEST_HEADER_BYTES).toString("utf8");
}

function validateRuntimeLimits(options: LocalCredentialBrokerOptions): {
  idleTimeoutMs: number;
  maxConnections: number;
} {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 60_000) {
    throw new ControlPlaneStateError("credential broker idle timeout must be 100 to 60000 ms");
  }
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 1_024) {
    throw new ControlPlaneStateError("credential broker max connections must be 1 to 1024");
  }
  return { idleTimeoutMs, maxConnections };
}

export class LocalCredentialBrokerServer {
  private readonly address: string;
  private readonly grants: OneShotCredentialGrantStore;
  private readonly idleTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private serverFailure: Error | undefined;

  constructor(options: LocalCredentialBrokerOptions) {
    validateAddress(options.address);
    const limits = validateRuntimeLimits(options);
    this.address = options.address;
    this.grants = options.grants;
    this.idleTimeoutMs = limits.idleTimeoutMs;
    this.maxConnections = limits.maxConnections;
  }

  async listen(): Promise<void> {
    if (this.server) {
      throw new ControlPlaneStateError("credential broker is already listening");
    }
    if (process.platform !== "win32") {
      await prepareUnixSocket(this.address);
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket));
    this.server = server;
    this.serverFailure = undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.address, () => {
          server.off("error", reject);
          server.on("error", (error) => this.failClosed(server, error));
          resolve();
        });
      });
      if (process.platform !== "win32") {
        await chmod(this.address, 0o600);
      }
    } catch (error) {
      this.server = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.grants.clear();
    if (process.platform !== "win32") {
      await rm(this.address, { force: true });
    }
  }

  assertAvailable(): void {
    if (!this.server?.listening || this.serverFailure) {
      throw new ControlPlaneStateError("credential broker is unavailable");
    }
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= this.maxConnections) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setTimeout(this.idleTimeoutMs, () => socket.destroy());
    const requestBuffer = Buffer.alloc(REQUEST_HEADER_BYTES + MAX_TOKEN_BYTES);
    let receivedBytes = 0;
    let expectedBytes: number | undefined;
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) {
        socket.destroy();
        return;
      }
      receivedBytes += chunk.length;
      if (receivedBytes > REQUEST_HEADER_BYTES + MAX_TOKEN_BYTES) {
        requestBuffer.fill(0);
        socket.destroy();
        return;
      }
      chunk.copy(requestBuffer, receivedBytes - chunk.length);
      if (expectedBytes === undefined && receivedBytes >= REQUEST_HEADER_BYTES) {
        const tokenLength = requestBuffer.readUInt16BE(0);
        if (tokenLength === 0 || tokenLength > MAX_TOKEN_BYTES) {
          handled = true;
          void this.respond(socket, requestBuffer.subarray(0, receivedBytes));
          return;
        }
        expectedBytes = REQUEST_HEADER_BYTES + tokenLength;
      }
      if (expectedBytes !== undefined && receivedBytes >= expectedBytes) {
        handled = true;
        socket.pause();
        if (receivedBytes !== expectedBytes) {
          requestBuffer.fill(0);
          socket.destroy();
          return;
        }
        void this.respond(socket, requestBuffer.subarray(0, receivedBytes));
      }
    });
    socket.once("close", () => {
      requestBuffer.fill(0);
      this.sockets.delete(socket);
    });
    socket.once("error", () => this.sockets.delete(socket));
  }

  private async respond(socket: Socket, request: Buffer): Promise<void> {
    let password: Buffer | undefined;
    let response: Buffer | undefined;
    try {
      const token = readRequest(request);
      const resolved = await this.grants.redeem(token);
      password = resolved.password;
      if (password.length > MAX_PASSWORD_BYTES) {
        throw new ControlPlaneStateError("credential broker password exceeds the limit");
      }
      response = encodeResponse(RESPONSE_OK, resolved.revision, password);
    } catch {
      response = genericErrorFrame();
    } finally {
      request.fill(0);
      password?.fill(0);
    }
    const wipeResponse = (): void => {
      response?.fill(0);
    };
    socket.once("close", wipeResponse);
    socket.end(response, () => {
      wipeResponse();
      socket.destroy();
    });
  }

  private failClosed(server: Server, error: Error): void {
    if (this.server !== server) {
      return;
    }
    this.serverFailure = error;
    this.server = undefined;
    this.grants.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    server.close(() => {
      if (process.platform !== "win32") {
        void rm(this.address, { force: true }).catch(() => undefined);
      }
    });
  }
}

export async function redeemLocalCredentialGrant(options: {
  address: string;
  token: string;
  timeoutMs?: number;
}): Promise<ResolvedUserSshCredential> {
  validateAddress(options.address);
  const timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new ControlPlaneStateError("credential broker timeout must be 100 to 60000 ms");
  }
  const request = encodeRequest(options.token);
  return await new Promise<ResolvedUserSshCredential>((resolve, reject) => {
    const socket = createConnection(options.address);
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      request.fill(0);
      for (const chunk of chunks) {
        chunk.fill(0);
      }
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error("credential broker request timed out")));
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > RESPONSE_HEADER_BYTES + MAX_PASSWORD_BYTES) {
        fail(new Error("credential broker response exceeded the limit"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("error", fail);
    socket.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      request.fill(0);
      const response = Buffer.concat(chunks);
      try {
        if (response.length < RESPONSE_HEADER_BYTES) {
          throw new Error("credential broker response is incomplete");
        }
        const status = response.readUInt8(0);
        const revision = response.readBigUInt64BE(1);
        const payloadLength = response.readUInt32BE(9);
        if (response.length !== RESPONSE_HEADER_BYTES + payloadLength) {
          throw new Error("credential broker response framing is invalid");
        }
        if (status !== RESPONSE_OK) {
          throw new Error("credential broker rejected the grant");
        }
        if (payloadLength === 0 || payloadLength > MAX_PASSWORD_BYTES) {
          throw new Error("credential broker password length is invalid");
        }
        if (revision === 0n || revision > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("credential broker revision is invalid");
        }
        resolve({
          password: Buffer.from(response.subarray(RESPONSE_HEADER_BYTES)),
          revision: Number(revision),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("credential broker response failed"));
      } finally {
        response.fill(0);
        for (const chunk of chunks) {
          chunk.fill(0);
        }
      }
    });
    socket.once("close", () => {
      if (!settled) {
        fail(new Error("credential broker closed without a response"));
      }
    });
  });
}
