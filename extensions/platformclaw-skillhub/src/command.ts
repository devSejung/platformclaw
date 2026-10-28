import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createPlatformClawSkillHubClient, type PlatformClawSkillHubClient } from "./client.js";

function commandLanguage(raw: string): { args: string; locale: "en" | "ko"; error?: string } {
  const trimmed = raw.trimStart();
  const first = trimmed.split(/\s/u, 1)[0] ?? "";
  if (first !== "--lang" && !first.startsWith("--lang=")) {
    return { args: raw, locale: "ko" };
  }
  const locale = first === "--lang=en" ? "en" : "ko";
  const args = trimmed.slice(first.length).trimStart();
  const next = args.split(/\s/u, 1)[0] ?? "";
  if (
    (first !== "--lang=en" && first !== "--lang=ko") ||
    next === "--lang" ||
    next.startsWith("--lang=")
  ) {
    return {
      args,
      locale,
      error:
        "명령어 맨 앞에 --lang=en 또는 --lang=ko를 한 번만 입력해 주세요.\nUse --lang=en or --lang=ko once before the command.",
    };
  }
  return { args, locale };
}

export function registerPlatformClawSkillHubCommand(
  api: OpenClawPluginApi,
  client: Pick<PlatformClawSkillHubClient, "request"> = createPlatformClawSkillHubClient(),
): void {
  api.registerCommand({
    name: "skillhub",
    description: "Browse, publish, and manage company skills.",
    descriptionLocalizations: { ko: "사내 SkillHub 스킬을 조회하고 관리합니다." },
    channels: ["knox"],
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      const { args, locale, error: languageError } = commandLanguage(ctx.args ?? "");
      if (languageError) {
        return { text: languageError, isError: true };
      }
      const ko = locale === "ko";
      const target = /^(dm|room):(.+)$/u.exec(ctx.to ?? "");
      if (!target || ctx.from !== ctx.to || !ctx.accountId || !ctx.agentId || !ctx.sessionKey) {
        return {
          text: ko
            ? "대화방 정보를 확인할 수 없습니다. 해당 대화에서 다시 시도해 주세요."
            : "The conversation could not be verified. Retry in the intended conversation.",
          isError: true,
        };
      }
      const senderId = ctx.senderId?.trim();
      if (!senderId) {
        return {
          text: ko
            ? "직원 계정을 확인할 수 없습니다. 웹에서 로그인한 뒤 다시 시도해 주세요."
            : "Your employee account could not be verified. Sign in on the web, then retry.",
          isError: true,
        };
      }
      try {
        const { status, body } = await client.request({
          accountId: senderId,
          args,
          locale,
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
            text: `${typeof body.error === "string" ? body.error : ko ? "Skill Hub 명령을 완료할 수 없습니다. 현재 상태를 확인한 뒤 다시 시도해 주세요." : "SkillHub command failed."}${suffix}`,
            isError: true,
          };
        }
        return typeof body.text === "string"
          ? { text: body.text, ...(body.isError === true ? { isError: true } : {}) }
          : {
              text: ko
                ? "Skill Hub 응답을 확인할 수 없습니다. 현재 처리 결과를 확인한 뒤 다시 시도해 주세요."
                : "The Skill Hub response could not be verified. Check the current outcome before retrying.",
              isError: true,
            };
      } catch (error) {
        api.logger.warn(`SkillHub command failed: ${String(error)}`);
        return {
          text: ko
            ? "Skill Hub에 연결할 수 없습니다. 현재 처리 결과를 확인한 뒤 다시 시도해 주세요."
            : "Could not connect to Skill Hub. Check the current outcome before retrying.",
          isError: true,
        };
      }
    },
  });
}
