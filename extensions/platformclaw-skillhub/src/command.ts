import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
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

export function registerPlatformClawSkillHubCommand(api: OpenClawPluginApi): void {
  let endpoint: { token: string; url: string } | undefined;
  api.registerCommand({
    name: "skillhub",
    description: "Browse and manage company SkillHub skills.",
    descriptionLocalizations: { ko: "사내 SkillHub 스킬을 조회하고 관리합니다." },
    channels: ["knox"],
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const target = /^(dm|room):(.+)$/u.exec(ctx.to ?? "");
      if (!target || ctx.from !== ctx.to || !ctx.accountId || !ctx.agentId || !ctx.sessionKey) {
        return {
          text: "대화방 정보를 확인할 수 없습니다. 해당 대화에서 다시 시도해 주세요.",
          isError: true,
        };
      }
      const senderId = ctx.senderId?.trim();
      if (!senderId) {
        return {
          text: "직원 계정을 확인할 수 없습니다. 웹에서 로그인한 뒤 다시 시도해 주세요.",
          isError: true,
        };
      }
      let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
      try {
        // Deployment credentials are process-stable. Resolve once on first use
        // without making an unused optional integration fail Gateway startup.
        endpoint ??= {
          token: readServiceToken(process.env),
          url: resolveControlPlaneUrl(process.env),
        };
        guarded = await fetchWithSsrFGuard({
          url: endpoint.url,
          init: {
            method: "POST",
            headers: {
              Authorization: `Bearer ${endpoint.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              accountId: senderId,
              args: ctx.args ?? "",
              locale: "ko",
              context: {
                accountId: ctx.accountId,
                conversationType: target[1],
                conversationId: target[2],
                agentId: ctx.agentId,
                sessionKey: ctx.sessionKey,
              },
            }),
          },
          maxRedirects: 0,
          timeoutMs: 120_000,
          policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(endpoint.url),
          auditContext: "platformclaw.skillhub_command",
        });
      } catch (error) {
        api.logger.warn(`SkillHub command failed: ${String(error)}`);
        return {
          text: "Skill Hub에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          isError: true,
        };
      }
      try {
        let body: Record<string, unknown>;
        try {
          body = await readResponse(guarded.response);
        } catch (error) {
          api.logger.warn(`SkillHub response failed: ${String(error)}`);
          return {
            text: "Skill Hub 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
            isError: true,
          };
        }
        if (!guarded.response.ok) {
          const candidates =
            body.details && typeof body.details === "object" && !Array.isArray(body.details)
              ? (body.details as Record<string, unknown>).candidates
              : undefined;
          const suffix = Array.isArray(candidates)
            ? `\n\n${candidates.map((candidate) => `- \`${String(candidate)}\``).join("\n")}`
            : "";
          return {
            text: `${typeof body.error === "string" ? body.error : "SkillHub command failed."}${suffix}`,
            isError: true,
          };
        }
        return typeof body.text === "string"
          ? { text: body.text, ...(body.isError === true ? { isError: true } : {}) }
          : {
              text: "Skill Hub 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
              isError: true,
            };
      } finally {
        await guarded.release();
      }
    },
  });
}
