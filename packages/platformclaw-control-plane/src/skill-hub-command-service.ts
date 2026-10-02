import type { PlatformUser } from "./contracts.js";
import {
  resolveKnoxSkillHubWorkspace,
  type KnoxSkillHubCommandContext,
} from "./skill-hub-command-workspace.js";
import { SkillHubPublicationService } from "./skill-hub-service-publication.js";
import {
  compareSemVer,
  safeName,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  type AuthenticatedWorkspace,
  type SkillHubAudience,
} from "./skill-hub-service-support.js";

export abstract class SkillHubCommandService extends SkillHubPublicationService {
  async knoxCommand(
    senderAccountId: string,
    args: string,
    locale: "en" | "ko",
    context: KnoxSkillHubCommandContext,
  ) {
    const actor = await resolveKnoxSkillHubWorkspace({
      store: this.options.store,
      workspaceRoot: this.workspaceRoot,
      senderAccountId,
      context,
      buildAgentMainSessionKey: this.options.buildAgentMainSessionKey,
    });
    return await this.commandForWorkspace(actor, args, locale);
  }

  async command(
    accountId: string,
    rawArgs: string | undefined,
    locale?: "en" | "ko",
  ): Promise<{ text: string; isError?: boolean }> {
    const actor = await this.authenticateAccount(accountId);
    if (!actor) {
      throw new SkillHubServiceError("linked active employee account required", 401);
    }
    return locale
      ? await this.commandForWorkspace(actor, rawArgs ?? "", locale)
      : await this.executeCommand(actor, rawArgs);
  }

  async commandForWorkspace(
    actor: AuthenticatedWorkspace,
    rawArgs: string,
    locale: "en" | "ko",
  ): Promise<{ text: string; isError?: boolean }> {
    const [action = "help", ...tail] = rawArgs.trim().split(/\s+/u).filter(Boolean);
    if (action === "help") {
      const korean = tail[0] === "ko" || (tail[0] !== "en" && locale === "ko");
      return { text: korean ? skillHubHelpKo() : skillHubHelpEn() };
    }
    try {
      if ((action === "list" && tail.length > 1) || (action === "installed" && tail.length > 0)) {
        throw new SkillHubServiceError("invalid command arguments", 400);
      }
      return await this.executeCommand(actor, rawArgs, locale);
    } catch (error) {
      if (!(error instanceof SkillHubServiceError)) {
        throw error;
      }
      if (error.details?.code === "legacy-list-category") {
        return {
          text:
            locale === "ko"
              ? "이전 카테고리(knowledge/automation/utility/other)는 현재 Skill Hub에서 제공하지 않습니다. /skillhub list [페이지] 또는 /skillhub list all로 권한이 있는 스킬을 확인해 주세요."
              : "Legacy categories (knowledge/automation/utility/other) are unavailable in the current Skill Hub. Use /skillhub list [page] or /skillhub list all to browse accessible skills.",
          isError: true,
        };
      }
      if (error.details?.code === "incomplete-search") {
        return {
          text:
            locale === "ko"
              ? "검색 결과가 많아 스킬을 확정할 수 없습니다. namespace/slug로 지정해 주세요."
              : "The search is incomplete. Specify the skill using namespace/slug.",
          isError: true,
        };
      }
      const candidates = error.details?.candidates;
      if (Array.isArray(candidates)) {
        return {
          text: [
            locale === "ko"
              ? "같은 이름의 스킬이 있습니다. namespace/slug로 지정해 주세요:"
              : "Choose a skill using namespace/slug:",
            ...candidates.map((candidate) => `- ${String(candidate)}`),
          ].join("\n"),
          isError: true,
        };
      }
      const messages: Record<number, string> = {
        400: "명령어 인자를 확인해 주세요. /skillhub help로 사용법을 볼 수 있습니다.",
        401: "직원 계정을 확인할 수 없습니다. 다시 로그인한 뒤 시도해 주세요.",
        403: "이 스킬을 조회하거나 설치할 권한이 없습니다.",
        404: "설치할 수 있는 스킬을 찾지 못했습니다. /skillhub list로 확인해 주세요.",
        409: "현재 설치 상태 또는 실행 대상을 확인해야 합니다. Skill Hub 화면에서 확인 후 설치해 주세요.",
      };
      return {
        text:
          locale === "ko"
            ? (messages[error.statusCode] ??
              "Skill Hub 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.")
            : `${error.message} Use the Skill Hub page for details.`,
        isError: true,
      };
    }
  }

  async commandCatalog(
    user: PlatformUser,
    page: number,
    audience: SkillHubAudience = "employee",
    pageSize = 20,
  ) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 25) {
      throw new SkillHubServiceError("page must be between 1 and 25", 400);
    }
    const fetchLimit = page * pageSize;
    const result = await this.adapterCall(() => this.options.adapter.search("", fetchLimit));
    // Page offsets belong to the registry result, not the filtered projection.
    // Applying them after ACL filtering can skip every visible item on later pages.
    const pageItems = result.items.slice((page - 1) * pageSize, page * pageSize);
    const visible = (
      await Promise.all(
        pageItems.map(async (item) => ({
          item,
          allowed:
            this.namespaces.has(item.namespace.toLowerCase()) &&
            (await this.canAccessSkill(
              user,
              item.namespace.toLowerCase(),
              item.slug,
              item.visibility,
              item.latestVersion,
              audience,
            )),
        })),
      )
    )
      .filter((entry) => entry.allowed)
      .map((entry) => entry.item);
    return {
      items: visible,
      page,
      pageSize,
      hasNext: result.total > fetchLimit,
      registryTotal: result.total,
    };
  }

  async resolveCommandSkill(
    user: PlatformUser,
    raw: string,
    audience: SkillHubAudience = "employee",
  ) {
    const value = raw.trim().toLowerCase();
    if (!value) {
      throw new SkillHubServiceError("skill slug is required", 400);
    }
    const separator = value.indexOf("/");
    if (separator >= 0) {
      const namespace = this.authorizeNamespace(value.slice(0, separator));
      const slug = safeName(value.slice(separator + 1), "skill slug", SKILL_KEY_PATTERN);
      const detail = await this.detail(user, namespace, slug, audience);
      const version = detail.versions.find((candidate) => candidate.downloadAvailable)?.version;
      if (!version) {
        throw new SkillHubServiceError("skill has no downloadable version", 409);
      }
      return { namespace, slug, version };
    }
    const slug = safeName(value, "skill slug", SKILL_KEY_PATTERN);
    const result = await this.search(user, slug, 50, audience, { requireComplete: true });
    const matches = result.items.filter((item) => item.slug.toLowerCase() === slug);
    if (matches.length === 0) {
      throw new SkillHubServiceError(`skill not found: ${slug}`, 404);
    }
    if (matches.length > 1) {
      throw new SkillHubServiceError("skill slug is ambiguous", 409, {
        candidates: matches.map((item) => `${item.namespace}/${item.slug}`),
      });
    }
    const match = matches[0]!;
    return { namespace: match.namespace, slug: match.slug, version: match.latestVersion };
  }

  async commandInstalled(actor: AuthenticatedWorkspace) {
    const execution = await this.resolveExecutionTarget(actor.agentId);
    const workspace = await this.workspaceSkills(actor, execution.activeTarget);
    return { target: workspace.source, items: workspace.items };
  }

  private async executeCommand(
    actor: AuthenticatedWorkspace,
    rawArgs: string | undefined,
    locale: "en" | "ko" = "en",
  ): Promise<{ text: string }> {
    const ko = locale === "ko";
    const [action = "help", ...tail] = (rawArgs ?? "").trim().split(/\s+/u).filter(Boolean);
    if (action === "help") {
      return { text: tail[0]?.toLowerCase() === "ko" ? skillHubHelpKo() : skillHubHelpEn() };
    }
    if (action === "list") {
      if (["knowledge", "automation", "utility", "other"].includes(tail[0] ?? "")) {
        throw new SkillHubServiceError(
          "Legacy categories are unavailable. Use /skillhub list [page] or /skillhub list all.",
          400,
          { code: "legacy-list-category" },
        );
      }
      const page = tail[0] === undefined || tail[0] === "all" ? 1 : Number(tail[0]);
      const result = await this.commandCatalog(
        actor.user,
        page,
        actor.roomBinding ? "room" : "employee",
      );
      const lines = [
        ko
          ? `## 다운로드 가능한 스킬 · ${result.page}페이지`
          : `## Downloadable skills — page ${result.page}`,
        "",
        ko ? "| 스킬 | 네임스페이스 | 최신 버전 |" : "| Skill | Namespace | Latest |",
        "|---|---|---|",
        ...result.items.map(
          (item) => `| \`${item.slug}\` | \`${item.namespace}\` | \`${item.latestVersion}\` |`,
        ),
      ];
      if (result.items.length === 0) {
        lines.splice(
          2,
          lines.length - 2,
          ko
            ? "이 페이지에는 다운로드 가능한 스킬이 없습니다."
            : "No downloadable skills on this page.",
        );
      }
      if (result.hasNext) {
        lines.push("", `${ko ? "다음" : "Next"}: \`/skillhub list ${result.page + 1}\``);
      }
      return { text: lines.join("\n") };
    }
    if (action === "installed") {
      const result = await this.commandInstalled(actor);
      const target = actor.roomBinding
        ? ko
          ? "그룹방 작업공간"
          : "Group room workspace"
        : result.target === "assigned_vm"
          ? ko
            ? "내 VM 작업공간"
            : "My VM workspace"
          : ko
            ? "기본 작업공간"
            : "Basic workspace";
      const title = ko ? "설치된 스킬" : "Installed skills";
      const targetLabel = ko ? "설치 대상" : "Target";
      if (result.items.length === 0) {
        return {
          text: `## ${title}\n\n${targetLabel}: **${target}**\n\n${ko ? "설치된 스킬이 없습니다." : "No skills installed."}`,
        };
      }
      return {
        text: [
          `## ${title}`,
          "",
          `${targetLabel}: **${target}**`,
          "",
          ko ? "| 스킬 | 버전 |" : "| Skill | Version |",
          "|---|---|",
          ...result.items.map(
            (item) => `| \`${item.skillKey ?? "unknown"}\` | \`${item.version ?? "unknown"}\` |`,
          ),
        ].join("\n"),
      };
    }
    if (action === "publish") {
      if (tail.length !== 1) {
        throw new SkillHubServiceError("usage: /skillhub publish <slug>", 400);
      }
      const slug = safeName(tail[0]!, "skill slug", SKILL_KEY_PATTERN);
      const execution = await this.resolveExecutionTarget(actor.agentId);
      const workspace = await this.workspaceSkills(actor, execution.activeTarget);
      const skill = workspace.items.find((item) => item.skillKey === slug);
      if (!skill) {
        throw new SkillHubServiceError(`skill is not installed on the active target: ${slug}`, 404);
      }
      const config = await this.config(actor);
      const namespace = config.namespaces[0];
      if (!namespace) {
        throw new SkillHubServiceError("no authorized publishing namespace is available", 403);
      }
      const binding = await this.options.store.getSkillHubNamespaceBinding(namespace);
      const visibility = binding?.visibilityCeiling === "PRIVATE" ? "PRIVATE" : "NAMESPACE_ONLY";
      const version = skill.version ?? "0.1.0";
      const result = await this.publish(actor, {
        skill: slug,
        source: execution.activeTarget,
        namespace,
        version,
        visibility,
      });
      return {
        text: `## ${ko ? "게시 완료" : "Published"}\n\n- ${ko ? "스킬" : "Skill"}: \`${result.namespace}/${result.slug}\`\n- ${ko ? "버전" : "Version"}: \`${result.version}\`\n- ${ko ? "출처" : "Source"}: \`${execution.activeTarget}\`\n- ${ko ? "공개 범위" : "Visibility"}: \`${visibility}\``,
      };
    }
    if (action === "install" || action === "update") {
      if (tail.length !== 1) {
        throw new SkillHubServiceError(`usage: /skillhub ${action} <slug|namespace/slug>`, 400);
      }
      const skill = await this.resolveCommandSkill(
        actor.user,
        tail[0]!,
        actor.roomBinding ? "room" : "employee",
      );
      const execution = await this.resolveExecutionTarget(actor.agentId);
      let currentVersion: string | undefined;
      let currentRevision: string | undefined;
      if (action === "update") {
        const installed = await this.commandInstalled(actor);
        const current = installed.items.find((item) => item.skillKey === skill.slug);
        currentVersion = current?.version;
        currentRevision = current?.revision;
        if (!currentVersion || !currentRevision) {
          throw new SkillHubServiceError(
            `installed skill identity is unavailable on the active target: ${skill.slug}`,
            409,
          );
        }
        if (compareSemVer(skill.version, currentVersion) < 0) {
          throw new SkillHubServiceError(
            `latest registry version ${skill.version} is older than installed version ${currentVersion}`,
            409,
          );
        }
      }
      await this.install(actor, {
        ...skill,
        destination: execution.activeTarget,
        ...(currentRevision ? { acknowledgedReplacement: true, currentRevision } : {}),
      });
      const verb =
        action === "update" ? (ko ? "업데이트 완료" : "Updated") : ko ? "설치 완료" : "Installed";
      return {
        text: `## ${verb}\n\n- ${ko ? "스킬" : "Skill"}: \`${skill.namespace}/${skill.slug}\`\n- ${ko ? "버전" : "Version"}: \`${skill.version}\`\n- ${ko ? "설치 대상" : "Target"}: ${actor.roomBinding ? (ko ? "그룹방 작업공간" : "Group room workspace") : ko ? (execution.activeTarget === "assigned_vm" ? "내 VM 작업공간" : "기본 작업공간") : execution.activeTarget}`,
      };
    }
    if (action === "delete") {
      const refs = tail.filter((value) => value !== "--confirm");
      if (!tail.includes("--confirm") || refs.length !== 1 || refs.length === tail.length) {
        throw new SkillHubServiceError("usage: /skillhub delete <slug> --confirm", 400);
      }
      const reference = refs[0]!.trim().toLowerCase();
      if (reference.includes("/")) {
        throw new SkillHubServiceError("delete accepts an installed skill slug only", 400);
      }
      const slug = safeName(reference, "skill slug", SKILL_KEY_PATTERN);
      const result = await this.uninstall(actor, slug);
      return {
        text: `## ${ko ? "설치 제거 완료" : "Deleted"}\n\n- ${ko ? "스킬" : "Skill"}: \`${slug}\`\n- ${ko ? "버전" : "Version"}: \`${result.version ?? "unknown"}\`\n- ${ko ? "설치 대상" : "Target"}: \`${result.target}\``,
      };
    }
    throw new SkillHubServiceError(`unknown SkillHub command: ${action}`, 400);
  }
}

function skillHubHelpEn(): string {
  return [
    "## SkillHub commands",
    "",
    "DM commands target your personal workspace; room commands target that room and browse/install only public skills.",
    "- `/skillhub help [ko|en]`",
    "- `/skillhub list [page|all]`: browse accessible skills (legacy categories are unavailable)",
    "- `/skillhub installed`",
    "- `/skillhub publish <slug>`",
    "- `/skillhub install <slug|namespace/slug>`",
    "- `/skillhub update <slug|namespace/slug>`",
    "- `/skillhub delete <slug> --confirm`",
  ].join("\n");
}

function skillHubHelpKo(): string {
  return [
    "## SkillHub 명령어",
    "",
    "개인 대화는 내 작업공간, 그룹방은 해당 방 작업공간을 사용합니다. 그룹방 조회·설치는 공개 스킬만 지원합니다.",
    "- `/skillhub help [ko|en]`: 도움말",
    "- `/skillhub list [페이지|all]`: 다운로드 가능한 스킬 (이전 카테고리 분류는 제공하지 않음)",
    "- `/skillhub installed`: 현재 설치된 스킬",
    "- `/skillhub publish <slug>`: 현재 작업공간의 스킬 게시 (내 게시 권한 적용)",
    "- `/skillhub install <slug|namespace/slug>`: 설치",
    "- `/skillhub update <slug|namespace/slug>`: 업데이트",
    "- `/skillhub delete <slug> --confirm`: 현재 실행 대상에서 제거",
  ].join("\n");
}
