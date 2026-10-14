import { readFileSync } from "node:fs";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";

const DEFAULT_CONTROL_PLANE_URL =
  "http://control.platformclaw.local:19001/platformclaw/internal/knox/skillhub";
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 16 * 1024;

function resolveControlPlaneUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.PLATFORMCLAW_KNOX_CONTROL_PLANE_URL?.trim();
  const url = new URL(raw || DEFAULT_CONTROL_PLANE_URL);
  if (url.pathname.endsWith("/route")) {
    url.pathname = `${url.pathname.slice(0, -"/route".length)}/skillhub`;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/skillhub")
  ) {
    throw new Error("SkillHub control-plane URL is invalid");
  }
  return url.toString();
}

function readServiceToken(env: NodeJS.ProcessEnv): string {
  const file = env.PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE?.trim();
  if (!file) {
    throw new Error("Knox service token file is not configured");
  }
  const bytes = readFileSync(file);
  if (bytes.byteLength > MAX_SECRET_BYTES) {
    throw new Error("Knox service token file is too large");
  }
  const token = bytes.toString("utf8").trim();
  if (Buffer.byteLength(token, "utf8") < 32 || Buffer.byteLength(token, "utf8") > 512) {
    throw new Error("Knox service token file is invalid");
  }
  return token;
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) {
    throw new Error("SkillHub command response is empty");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error("SkillHub command response exceeded size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SkillHub command response is invalid");
  }
  return value as Record<string, unknown>;
}

export type SkillHubConversation = {
  accountId: string;
  conversationType: "dm" | "room";
  conversationId: string;
  agentId: string;
  sessionKey: string;
};

export type SkillHubClientRequest = {
  accountId: string;
  context: SkillHubConversation;
} & (
  | { args: string; locale: "ko" }
  | {
      action: "search" | "status" | "install" | "delete";
      input: {
        query?: string;
        slug?: string;
        namespace?: string;
        version?: string;
        confirm?: boolean;
      };
    }
);

export function createPlatformClawSkillHubClient() {
  let endpoint: { token: string; url: string } | undefined;
  return {
    async request(request: SkillHubClientRequest) {
      // Deployment credentials stay process-stable across commands and tool turns.
      endpoint ??= {
        token: readServiceToken(process.env),
        url: resolveControlPlaneUrl(process.env),
      };
      const guarded = await fetchWithSsrFGuard({
        url: endpoint.url,
        init: {
          method: "POST",
          headers: {
            Authorization: `Bearer ${endpoint.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        },
        maxRedirects: 0,
        timeoutMs: 120_000,
        policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(endpoint.url),
        auditContext: "platformclaw.skillhub",
      });
      try {
        return { status: guarded.response.status, body: await readResponse(guarded.response) };
      } finally {
        await guarded.release();
      }
    },
  };
}

export type PlatformClawSkillHubClient = ReturnType<typeof createPlatformClawSkillHubClient>;
