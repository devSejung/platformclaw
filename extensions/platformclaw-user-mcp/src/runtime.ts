import { readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";

const MCP_CONNECTION_PATH = "/platformclaw/internal/mcp/connection";
const MAX_RESPONSE_BYTES = 64 * 1024;

function requireSingleLine(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("\r") ||
    normalized.includes("\n")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function executionHandoffAddress(credentialBrokerAddress: string): string {
  return process.platform === "win32"
    ? `${credentialBrokerAddress}-execution`
    : path.join(path.dirname(credentialBrokerAddress), "execution.sock");
}

type UserMcpConnectionRuntime = {
  resolve(
    agentId: string,
    serverName: string,
    serverUrl: string,
  ): Promise<{ headers: Record<string, string>; expiresAt?: number } | null>;
};

export function createUserMcpConnectionRuntime(
  env: NodeJS.ProcessEnv = process.env,
): UserMcpConnectionRuntime {
  const brokerAddress = requireSingleLine(
    env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS ?? "",
    "credential broker address",
  );
  const tokenFile = requireSingleLine(
    env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE ?? "",
    "execution token file",
  );
  const serviceToken = requireSingleLine(readFileSync(tokenFile, "utf8"), "execution token");
  const socketPath = executionHandoffAddress(brokerAddress);
  return {
    resolve: async (agentId, serverName, serverUrl) => {
      const payload = Buffer.from(JSON.stringify({ agentId, serverName, serverUrl }));
      return await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };
        const req = request(
          {
            socketPath,
            path: MCP_CONNECTION_PATH,
            method: "POST",
            headers: {
              authorization: `Bearer ${serviceToken}`,
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
                const error = new Error("MCP credential response exceeded limit");
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
              if (status === 404) {
                settled = true;
                resolve(null);
                return;
              }
              if (status < 200 || status >= 300) {
                fail(new Error(`MCP credential request failed (${status})`));
                return;
              }
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                  headers?: unknown;
                  expiresAt?: unknown;
                };
                if (!parsed.headers || typeof parsed.headers !== "object") {
                  throw new Error("MCP credential response is invalid");
                }
                const expiresAt =
                  typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt)
                    ? parsed.expiresAt
                    : undefined;
                settled = true;
                resolve({
                  headers: parsed.headers as Record<string, string>,
                  ...(expiresAt === undefined ? {} : { expiresAt }),
                });
              } catch (error) {
                fail(error instanceof Error ? error : new Error("MCP credential response invalid"));
              }
            });
            res.once("aborted", () => fail(new Error("MCP credential response aborted")));
            res.once("error", fail);
          },
        );
        req.setTimeout(5_000, () => req.destroy(new Error("MCP credential request timed out")));
        req.once("error", fail);
        req.end(payload);
      });
    },
  };
}
