import { readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";

const SEARCH_PATH = "/platformclaw/internal/memory/organization/search";
const GET_PATH = "/platformclaw/internal/memory/organization/get";
const MAX_RESPONSE_BYTES = 256 * 1024;

export type OrganizationMemoryClient = {
  search(params: { agentId: string; query: string; maxResults?: number }): Promise<unknown>;
  get(params: {
    agentId: string;
    path: string;
    fromLine?: number;
    lineCount?: number;
  }): Promise<unknown>;
};

function handoffAddress(brokerAddress: string): string {
  return process.platform === "win32"
    ? `${brokerAddress}-execution`
    : path.join(path.dirname(brokerAddress), "execution.sock");
}

async function call(socketPath: string, token: string, route: string, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  return await new Promise<unknown>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: route,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
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
            req.destroy(new Error("organization memory response too large"));
          } else {
            chunks.push(chunk);
          }
        });
        res.once("end", () => {
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error(`organization memory request failed (${res.statusCode ?? 500})`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("organization memory response is invalid"));
          }
        });
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("organization memory request timed out")));
    req.once("error", reject);
    req.end(payload);
  });
}

export function createOrganizationMemoryClient(
  env: NodeJS.ProcessEnv,
): OrganizationMemoryClient | null {
  const broker = env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS?.trim();
  const tokenFile = env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE?.trim();
  if (!broker || !tokenFile) {
    return null;
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) {
    throw new Error("organization memory service token is empty");
  }
  const socketPath = handoffAddress(broker);
  return {
    search: async (params) => await call(socketPath, token, SEARCH_PATH, params),
    get: async (params) => await call(socketPath, token, GET_PATH, params),
  };
}
