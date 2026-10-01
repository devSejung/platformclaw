import { readFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const SEARCH_PATH = "/platformclaw/internal/memory/vaults/search";
const GET_PATH = "/platformclaw/internal/memory/vaults/get";
const WIKI_PATH = "/platformclaw/internal/memory/vaults/wiki";
const SCOPE_PATH = "/platformclaw/internal/memory/vaults/scope";
const MAX_RESPONSE_BYTES = 256 * 1024;

export type VaultTurnScope = { revision: number; vaultIds: string[]; personalEnabled: boolean };

export type WikiHubMemoryClient = {
  spaceRead(params: {
    agentId: string;
    operation: string;
    query?: string;
    spaceId?: string;
    pageId?: string;
    sessionKey?: string;
    runId?: string;
    messageId?: string;
  }): Promise<unknown>;
  wiki(
    params: import("openclaw/plugin-sdk/memory-core-host-runtime-core").MemoryWikiOperation & {
      agentId: string;
      turnScope?: VaultTurnScope;
    },
  ): Promise<unknown>;
  captureScope(params: { agentId: string }): Promise<unknown>;
  search(params: {
    agentId: string;
    query: string;
    maxResults?: number;
    vaultId?: string;
    vaultName?: string;
    turnScope?: VaultTurnScope;
  }): Promise<unknown>;
  get(params: {
    agentId: string;
    path: string;
    fromLine?: number;
    lineCount?: number;
  }): Promise<unknown>;
};

export function vaultServiceUnavailable(status?: number): Error {
  const error = `Wiki Hub service is unavailable${status ? ` (${status})` : ""}`;
  return Object.assign(new Error(error), {
    memoryCorpusFailure: {
      error,
      action:
        "Retry the search. If it keeps failing, ask an administrator to check the Wiki Hub service.",
    },
  });
}

function responseError(status: number, body: string): Error {
  let value: Record<string, unknown> | undefined;
  try {
    value = asOptionalRecord(JSON.parse(body));
  } catch {
    return vaultServiceUnavailable(status);
  }
  if (
    value?.code !== "wiki-invalid" &&
    value?.code !== "wiki-conflict" &&
    value?.code !== "wiki-forbidden" &&
    value?.code !== "vault-name-ambiguous" &&
    value?.code !== "vault-name-not-found" &&
    value?.code !== "vault-query-invalid"
  ) {
    return vaultServiceUnavailable(status);
  }
  if (typeof value.error !== "string" || typeof value.action !== "string") {
    return vaultServiceUnavailable(status);
  }
  const choices = Array.isArray(value.vaultChoices)
    ? value.vaultChoices.slice(0, 5).flatMap((entry) => {
        const choice = asOptionalRecord(entry);
        return choice &&
          typeof choice.vaultId === "string" &&
          choice.vaultId.length <= 512 &&
          typeof choice.vaultName === "string" &&
          choice.vaultName.length <= 240 &&
          choice.vaultType === "shared"
          ? [{ vaultId: choice.vaultId, vaultName: choice.vaultName, vaultType: choice.vaultType }]
          : [];
      })
    : [];
  const failure = {
    error: value.error.slice(0, 500),
    code: value.code,
    action: value.action.slice(0, 500),
    vaultChoices: choices,
  };
  return Object.assign(new Error(failure.error), { memoryCorpusFailure: failure });
}

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
        res.once("aborted", () => reject(new Error("Wiki Hub response interrupted")));
        res.once("error", reject);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Wiki Hub response too large"));
          } else {
            chunks.push(chunk);
          }
        });
        res.once("end", () => {
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(responseError(res.statusCode ?? 500, Buffer.concat(chunks).toString("utf8")));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Wiki Hub response is invalid"));
          }
        });
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("Wiki Hub request timed out")));
    req.once("error", reject);
    req.end(payload);
  });
}

export function createWikiHubMemoryClient(env: NodeJS.ProcessEnv): WikiHubMemoryClient | null {
  const broker = env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS?.trim();
  const tokenFile = env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE?.trim();
  if (!broker || !tokenFile) {
    return null;
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) {
    throw new Error("Wiki Hub service token is empty");
  }
  const socketPath = handoffAddress(broker);
  return {
    spaceRead: async (params) =>
      await call(socketPath, token, "/platformclaw/internal/spaces/read", params),
    wiki: async (params) => await call(socketPath, token, WIKI_PATH, params),
    captureScope: async (params) => await call(socketPath, token, SCOPE_PATH, params),
    search: async (params) => await call(socketPath, token, SEARCH_PATH, params),
    get: async (params) => await call(socketPath, token, GET_PATH, params),
  };
}
