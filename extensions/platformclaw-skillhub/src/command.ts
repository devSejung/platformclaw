import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createPlatformClawSkillHubClient, type PlatformClawSkillHubClient } from "./client.js";

export function registerPlatformClawSkillHubCommand(
  api: OpenClawPluginApi,
  client: PlatformClawSkillHubClient = createPlatformClawSkillHubClient(),
): void {
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
      try {
        const { status, body } = await client.request({
          accountId: senderId,
          args: ctx.args ?? "",
          locale: "ko",
          context: {
            accountId: ctx.accountId,
            conversationType: target[1] as "dm" | "room",
            conversationId: target[2]!,
            agentId: ctx.agentId,
            sessionKey: ctx.sessionKey,
          },
        });
        if (status < 200 || status >= 300) {
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
      } catch (error) {
        api.logger.warn(`SkillHub command failed: ${String(error)}`);
        return {
          text: "Skill Hub에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.",
          isError: true,
        };
      }
    },
  });
}
