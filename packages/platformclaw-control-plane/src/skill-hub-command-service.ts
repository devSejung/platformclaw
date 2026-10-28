import { randomUUID } from "node:crypto";
import type { PlatformUser } from "./contracts.js";
import { localizeSkillHubCommandError } from "./skill-hub-command-errors.js";
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
  async knoxTool(
    senderAccountId: string,
    action: "search" | "status" | "install" | "delete",
    input: { query?: string; id?: string; slug?: string; version?: string; confirm?: boolean },
    context: KnoxSkillHubCommandContext,
  ) {
    const actor = await resolveKnoxSkillHubWorkspace({
      store: this.options.store,
      workspaceRoot: this.workspaceRoot,
      senderAccountId,
      context,
      buildAgentMainSessionKey: this.options.buildAgentMainSessionKey,
    });
    await this.initializeCatalog();
    const audience = actor.roomBinding ? "room" : "employee";
    if (action === "delete") {
      if (input.confirm !== true) {
        throw new SkillHubServiceError("Confirm removal of the installed skill", 400);
      }
      return await this.uninstall(actor, input.slug ?? "");
    }
    if (action === "search") {
      const result = await this.search(actor.user, input.query ?? "", 5, audience);
      const items = [];
      for (const item of result.items) {
        try {
          const selected = await this.resolveCommandSkill(actor.user, item.id, audience);
          items.push({
            ...item,
            latestVersion: selected.version,
            summary: item.summary.slice(0, 160),
          });
        } catch (error) {
          if (
            !(error instanceof SkillHubServiceError) ||
            (error.statusCode !== 404 && error.statusCode !== 409)
          ) {
            throw error;
          }
        }
      }
      return {
        ...result,
        items,
        target: (await this.resolveExecutionTarget(actor.agentId)).activeTarget,
        agentId: actor.agentId,
        audience,
      };
    }
    const installed = await this.commandInstalled(actor);
    if (action === "status") {
      const items = input.slug
        ? installed.items.filter((item) => item.skillKey === input.slug)
        : installed.items;
      return {
        target: installed.target,
        items: items
          .slice(0, 10)
          .map((item) =>
            Object.assign(
              {},
              item,
              item.description ? { description: item.description.slice(0, 160) } : {},
            ),
          ),
        total: items.length,
        truncated: items.length > 10,
      };
    }
    const selected = await this.resolveCommandSkill(
      actor.user,
      input.id ?? input.slug ?? "",
      audience,
    );
    const currentTarget = await this.authorizeInstallTarget(actor.agentId, installed.target);
    if (
      currentTarget.targetId !== installed.targetId ||
      currentTarget.targetRevision !== installed.targetRevision
    ) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
      );
    }
    if (input.version && input.version !== selected.version) {
      throw new SkillHubServiceError("Recommendation changed; search again", 409);
    }
    const current = installed.items.find((item) => item.skillKey === selected.slug);
    if (current?.hubSkillId === selected.id && current.hubVersion === selected.version) {
      return {
        ok: true,
        noOp: true,
        slug: selected.slug,
        version: current.version ?? null,
        target: installed.target,
        readiness: current,
      };
    }
    return await this.install(actor, {
      id: selected.id,
      version: selected.version,
      destination: installed.target,
      expectedTargetId: installed.targetId,
      expectedTargetRevision: installed.targetRevision,
    });
  }

  async knoxCommand(
    senderAccountId: string,
    args: string,
    locale: "en" | "ko",
    context: KnoxSkillHubCommandContext,
  ) {
    try {
      const actor = await resolveKnoxSkillHubWorkspace({
        store: this.options.store,
        workspaceRoot: this.workspaceRoot,
        senderAccountId,
        context,
        buildAgentMainSessionKey: this.options.buildAgentMainSessionKey,
      });
      return await this.commandForWorkspace(actor, args, locale);
    } catch (error) {
      throw error instanceof SkillHubServiceError
        ? localizeSkillHubCommandError(error, locale)
        : error;
    }
  }

  async command(accountId: string, rawArgs: string | undefined, locale: "en" | "ko" = "en") {
    try {
      const actor = await this.authenticateAccount(accountId);
      if (!actor) {
        throw new SkillHubServiceError("Linked active employee account required", 401);
      }
      return await this.commandForWorkspace(actor, rawArgs ?? "", locale);
    } catch (error) {
      throw error instanceof SkillHubServiceError
        ? localizeSkillHubCommandError(error, locale)
        : error;
    }
  }

  async commandForWorkspace(actor: AuthenticatedWorkspace, rawArgs: string, locale: "en" | "ko") {
    await this.initializeCatalog();
    const ko = locale === "ko";
    const [action = "help", ...tail] = rawArgs.trim().split(/\s+/u).filter(Boolean);
    if (action === "help") {
      return { text: help(tail[0] === "ko" || (tail[0] !== "en" && ko)) };
    }
    try {
      if (action === "list") {
        const page = tail[0] === undefined || tail[0] === "all" ? 1 : Number(tail[0]);
        const result = await this.commandCatalog(
          actor.user,
          page,
          actor.roomBinding ? "room" : "employee",
        );
        return {
          text: [
            ko ? "스킬 목록" : "Skill Hub skills",
            ...result.items.map(
              (item) => `${item.displayName} · ${item.latestVersion} · ${item.id}`,
            ),
            ...(result.hasNext ? [`/skillhub ${ko ? "" : "--lang=en "}list ${page + 1}`] : []),
          ].join("\n"),
        };
      }
      if (action === "installed") {
        const result = await this.commandInstalled(actor);
        return {
          text: [
            ko ? "설치된 스킬" : "Installed skills",
            ...result.items.map(
              (item) => `${item.skillKey} · ${item.version ?? (ko ? "버전 정보 없음" : "unknown")}`,
            ),
          ].join("\n"),
        };
      }
      if (action === "publish") {
        if (actor.roomBinding) {
          throw new SkillHubServiceError("Publish from your personal Skill Hub workspace", 403, {
            code: "skill-hub-command-room-publish",
          });
        }
        if (tail.length !== 1) {
          throw new SkillHubServiceError("Usage: /skillhub publish <workspace-skill>", 400, {
            code: "skill-hub-command-usage",
          });
        }
        const slug = safeName(tail[0]!, "skill", SKILL_KEY_PATTERN);
        const pending = (
          await this.options.store.skillHubCatalog.listRecoverablePublications(actor.user.id)
        ).find(
          (publication) =>
            publication.ownerUserId === actor.user.id &&
            publication.actorUserId === actor.user.id &&
            publication.slug === slug,
        );
        if (pending) {
          throw new SkillHubServiceError(
            `Publication of ${slug}@${pending.version} is unconfirmed (${pending.operationId}). Recover or cancel the original request in the web Skill Hub pending publications before publishing again.`,
            409,
            { code: "skill-hub-publication-pending" },
          );
        }
        const workspace = await this.commandInstalled(actor);
        const skill = workspace.items.find((item) => item.skillKey === slug);
        if (!skill) {
          throw new SkillHubServiceError("Workspace skill not found", 404, {
            code: "skill-hub-workspace-skill-not-found",
          });
        }
        const result = await this.publish(actor, {
          operationId: randomUUID(),
          skill: slug,
          source: workspace.target,
          expectedTargetId: workspace.targetId,
          version: skill.version ?? "1.0.0",
        });
        return {
          text: `${ko ? "전체공개 게시 완료" : "Published for everyone"}: ${result.slug}@${result.version} (${result.id})`,
        };
      }
      if (action === "install" || action === "update") {
        if (tail.length !== 1) {
          throw new SkillHubServiceError(`Usage: /skillhub ${action} <skill-id|name>`, 400, {
            code: "skill-hub-command-usage",
          });
        }
        const skill = await this.resolveCommandSkill(
          actor.user,
          tail[0]!,
          actor.roomBinding ? "room" : "employee",
        );
        const installed = await this.commandInstalled(actor);
        const current = installed.items.find((item) => item.skillKey === skill.slug);
        if (
          action === "update" &&
          (!current?.version ||
            !current.revision ||
            compareSemVer(skill.version, current.version) < 0)
        ) {
          throw new SkillHubServiceError(
            "Check the installed version in Skill Hub before updating",
            409,
            { code: "skill-hub-command-update" },
          );
        }
        await this.install(actor, {
          id: skill.id,
          version: skill.version,
          destination: installed.target,
          expectedTargetId: installed.targetId,
          expectedTargetRevision: installed.targetRevision,
          ...(action === "update" && current?.revision
            ? { acknowledgedReplacement: true, currentRevision: current.revision }
            : {}),
        });
        return { text: `${ko ? "설치 완료" : "Installed"}: ${skill.slug}@${skill.version}` };
      }
      if (action === "delete") {
        if (tail.length !== 2 || tail[1] !== "--confirm") {
          throw new SkillHubServiceError(
            "Usage: /skillhub delete <installed-skill> --confirm",
            400,
            { code: "skill-hub-command-usage" },
          );
        }
        const result = await this.uninstall(actor, tail[0]!);
        return { text: `${ko ? "설치 제거 완료" : "Removed"}: ${result.slug}` };
      }
      throw new SkillHubServiceError("Unknown command; use /skillhub help", 400, {
        code: "skill-hub-command-unknown",
      });
    } catch (error) {
      if (!(error instanceof SkillHubServiceError)) {
        throw error;
      }
      return {
        text: `${localizeSkillHubCommandError(error, locale).message}${Array.isArray(error.details?.candidates) ? `\n${error.details.candidates.join("\n")}` : ""}`,
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
      throw new SkillHubServiceError("Page must be 1 to 25", 400, {
        code: "skill-hub-command-page",
      });
    }
    const result = await this.search(user, "", 500, audience);
    return {
      items: result.items.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      hasNext: result.total > page * pageSize,
      registryTotal: result.total,
    };
  }

  async resolveCommandSkill(
    user: PlatformUser,
    raw: string,
    audience: SkillHubAudience = "employee",
  ) {
    const value = raw.trim();
    const direct = await this.options.store.skillHubCatalog.get(value);
    let id = direct?.id;
    if (!id && value.includes("/")) {
      const [namespace, slug] = value.split("/");
      id = (await this.options.store.skillHubCatalog.getByCoordinate(namespace!, slug!))?.id;
    }
    if (!id) {
      const result = await this.search(user, value, 500, audience);
      const matches = result.items.filter(
        (item) => item.slug === value || item.displayName === value,
      );
      const ambiguous = result.total > result.items.length || matches.length > 1;
      if (ambiguous || matches.length === 0) {
        throw new SkillHubServiceError(
          ambiguous ? "Choose a skill ID" : "Skill not found",
          ambiguous ? 409 : 404,
          {
            ...(ambiguous ? { code: "skill-hub-command-ambiguous" } : {}),
            candidates: matches.map((item) => `${item.displayName} · ${item.id}`),
          },
        );
      }
      id = matches[0]!.id;
    }
    const detail = await this.detailById(user, id, audience);
    const version = detail.versions.find((candidate) => candidate.downloadAvailable)?.version;
    if (!version) {
      throw new SkillHubServiceError("No downloadable version", 409, {
        code: "skill-hub-command-no-download",
      });
    }
    return { id, slug: detail.skill.slug, version };
  }

  async commandInstalled(actor: AuthenticatedWorkspace) {
    const execution = await this.resolveExecutionTarget(actor.agentId);
    const workspace = await this.workspaceSkills(actor, execution.activeTarget);
    if (workspace.targetRevision !== execution.targetRevision) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
      );
    }
    return {
      target: workspace.source,
      targetId: workspace.targetId,
      targetRevision: workspace.targetRevision,
      items: workspace.items,
    };
  }
}

function help(ko: boolean) {
  return [
    ko ? "## SkillHub 명령어" : "## SkillHub commands",
    ko
      ? "개인 대화는 내 작업 공간, 공유방은 해당 방 작업 공간을 사용합니다. 공유방은 전체공개 스킬만 사용합니다."
      : "DM commands use your workspace. Room commands use the room workspace and public skills only.",
    "/skillhub help [ko|en]",
    ko
      ? "영어로 실행: /skillhub --lang=en <명령어> (한국어: --lang=ko)"
      : "Choose a reply language: /skillhub --lang=en <command> (Korean: --lang=ko)",
    "/skillhub list [page|all]",
    "/skillhub installed",
    "/skillhub publish <workspace-skill>",
    "/skillhub install <skill-id|name>",
    "/skillhub update <skill-id|name>",
    "/skillhub delete <installed-skill> --confirm",
  ].join("\n");
}
