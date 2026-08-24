import { request } from "node:http";
import { isAbsolute } from "node:path";
import {
  PLATFORMCLAW_EXECUTION_CHANGE_TARGET_PATH,
  PLATFORMCLAW_EXECUTION_CONNECTION_TARGET_PATH,
  PLATFORMCLAW_EXECUTION_GRANT_PATH,
  PLATFORMCLAW_EXECUTION_TARGET_PATH,
  PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH,
  PLATFORMCLAW_MCP_CONNECTION_PATH,
} from "./execution-handoff-http.js";
import type {
  ExecutionCredentialGrant,
  ExecutionTargetSnapshot,
} from "./execution-handoff-service.js";

const MAX_RESPONSE_BYTES = 512 * 1024;

function validateSocketPath(socketPath: string): string {
  const normalized = socketPath.trim();
  const valid =
    process.platform === "win32" ? normalized.startsWith("\\\\.\\pipe\\") : isAbsolute(normalized);
  if (!valid) {
    throw new Error("execution handoff requires a local socket path");
  }
  return normalized;
}

export class ExecutionHandoffClient {
  private readonly socketPath: string;

  constructor(
    socketPath: string,
    private readonly serviceToken: string,
  ) {
    this.socketPath = validateSocketPath(socketPath);
    if (!serviceToken.trim()) {
      throw new Error("execution handoff service token is required");
    }
  }

  async resolveTarget(
    agentId: string,
    target?: "platform_server" | "assigned_vm",
  ): Promise<ExecutionTargetSnapshot> {
    return (await this.post(PLATFORMCLAW_EXECUTION_TARGET_PATH, {
      agentId,
      ...(target ? { target } : {}),
    })) as ExecutionTargetSnapshot;
  }

  async resolveConnectionTarget(agentId: string): Promise<ExecutionTargetSnapshot> {
    return (await this.post(PLATFORMCLAW_EXECUTION_CONNECTION_TARGET_PATH, {
      agentId,
    })) as ExecutionTargetSnapshot;
  }

  async changeTarget(params: {
    agentId: string;
    target: "platform_server" | "assigned_vm";
    expectedRevision: number;
  }): Promise<ExecutionTargetSnapshot> {
    return (await this.post(
      PLATFORMCLAW_EXECUTION_CHANGE_TARGET_PATH,
      params,
    )) as ExecutionTargetSnapshot;
  }

  async issueCredentialGrant(params: {
    agentId: string;
    allocationId: string;
    targetRevision: number;
    credentialRevision: number;
  }): Promise<ExecutionCredentialGrant> {
    return (await this.post(PLATFORMCLAW_EXECUTION_GRANT_PATH, params)) as ExecutionCredentialGrant;
  }

  async resolveMcpConnection(
    agentId: string,
    serverName: string,
    serverUrl: string,
  ): Promise<{
    headers: Record<string, string>;
    revision: number;
    expiresAt?: number;
  }> {
    return (await this.post(PLATFORMCLAW_MCP_CONNECTION_PATH, {
      agentId,
      serverName,
      serverUrl,
    })) as { headers: Record<string, string>; revision: number; expiresAt?: number };
  }

  async resolveExecCredentials(agentId: string): Promise<Record<string, string>> {
    return (await this.post(PLATFORMCLAW_EXEC_CREDENTIALS_INTERNAL_PATH, { agentId })) as Record<
      string,
      string
    >;
  }

  private async post(pathname: string, body: unknown): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(body));
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const req = request(
        {
          socketPath: this.socketPath,
          path: pathname,
          method: "POST",
          headers: {
            authorization: `Bearer ${this.serviceToken}`,
            "content-type": "application/json",
            "content-length": payload.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              const error = new Error("execution handoff response exceeded the limit");
              fail(error);
              req.destroy(error);
              return;
            }
            chunks.push(chunk);
          });
          res.once("end", () => {
            if (settled) {
              return;
            }
            const status = res.statusCode ?? 500;
            if (status < 200 || status >= 300) {
              fail(new Error(`execution handoff request failed (${status})`));
              return;
            }
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              settled = true;
              resolve(parsed);
            } catch {
              fail(new Error("execution handoff returned invalid JSON"));
            }
          });
          res.once("aborted", () => fail(new Error("execution handoff response was aborted")));
          res.once("error", fail);
        },
      );
      req.setTimeout(5_000, () => req.destroy(new Error("execution handoff request timed out")));
      req.once("error", fail);
      req.end(payload);
    });
  }
}
