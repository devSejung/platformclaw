import type { PlatformUser } from "./contracts.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";
import { SkillHubPublicationService } from "./skill-hub-service-publication.js";
import {
  compareSemVer,
  safeName,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  validVersion,
  validVisibility,
} from "./skill-hub-service-support.js";

export {
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SKILL_HUB_UPLOAD_ENTRY_BYTES,
  SKILL_HUB_UPLOAD_EXPANDED_BYTES,
  SKILL_HUB_UPLOAD_FILES,
  SkillHubServiceError,
} from "./skill-hub-service-support.js";
export type { AuthenticatedWorkspace, SkillInstallTarget } from "./skill-hub-service-support.js";

export class SkillHubService extends SkillHubPublicationService {
  async command(accountId: string, rawArgs: string | undefined): Promise<{ text: string }> {
    const actor = await this.authenticateAccount(accountId);
    if (!actor) {
      throw new SkillHubServiceError("linked active employee account required", 401);
    }
    const [action = "help", ...tail] = (rawArgs ?? "").trim().split(/\s+/u).filter(Boolean);
    if (action === "help") {
      return { text: tail[0]?.toLowerCase() === "ko" ? skillHubHelpKo() : skillHubHelpEn() };
    }
    if (action === "list") {
      const page = tail[0] === undefined ? 1 : Number(tail[0]);
      const result = await this.commandCatalog(actor.user, page);
      const lines = [
        `## Downloadable skills — page ${result.page}`,
        "",
        "| Skill | Namespace | Latest |",
        "|---|---|---|",
        ...result.items.map(
          (item) => `| \`${item.slug}\` | \`${item.namespace}\` | \`${item.latestVersion}\` |`,
        ),
      ];
      if (result.items.length === 0) {
        lines.splice(2, lines.length - 2, "No downloadable skills on this page.");
      }
      if (result.hasNext) {
        lines.push("", `Next: \`/skillhub list ${result.page + 1}\``);
      }
      return { text: lines.join("\n") };
    }
    if (action === "installed") {
      const result = await this.commandInstalled(actor);
      const target = result.target === "assigned_vm" ? "My VM workspace" : "Basic workspace";
      if (result.items.length === 0) {
        return { text: `## Installed skills\n\nTarget: **${target}**\n\nNo skills installed.` };
      }
      return {
        text: [
          "## Installed skills",
          "",
          `Target: **${target}**`,
          "",
          "| Skill | Version |",
          "|---|---|",
          ...result.items.map(
            (item) => `| \`${item.skillKey ?? "unknown"}\` | \`${item.version ?? "unknown"}\` |`,
          ),
        ].join("\n"),
      };
    }
    if (action === "install" || action === "update") {
      if (tail.length !== 1) {
        throw new SkillHubServiceError(`usage: /skillhub ${action} <slug|namespace/slug>`, 400);
      }
      const skill = await this.resolveCommandSkill(actor.user, tail[0]!);
      const execution = await this.resolveExecutionTarget(actor.agentId);
      let currentVersion: string | undefined;
      if (action === "update") {
        const installed = await this.commandInstalled(actor);
        currentVersion = installed.items.find((item) => item.skillKey === skill.slug)?.version;
        if (!currentVersion) {
          throw new SkillHubServiceError(
            `skill is not installed on the active target: ${skill.slug}`,
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
      const result = await this.install(actor, {
        ...skill,
        destination: execution.activeTarget,
        ...(currentVersion ? { acknowledgedVersionChange: true, currentVersion } : {}),
      });
      const verb = result.noOp
        ? "Already installed"
        : action === "update"
          ? "Updated"
          : "Installed";
      return {
        text: `## ${verb}\n\n- Skill: \`${skill.namespace}/${skill.slug}\`\n- Version: \`${skill.version}\`\n- Target: \`${execution.activeTarget}\``,
      };
    }
    if (action === "delete") {
      const refs = tail.filter((value) => value !== "--confirm");
      if (!tail.includes("--confirm") || refs.length !== 1 || refs.length === tail.length) {
        throw new SkillHubServiceError(
          "usage: /skillhub delete <slug|namespace/slug> --confirm",
          400,
        );
      }
      const reference = refs[0]!.trim().toLowerCase();
      const segments = reference.split("/");
      if (segments.length > 2) {
        throw new SkillHubServiceError("invalid skill reference", 400);
      }
      const slug = safeName(segments.at(-1) ?? "", "skill slug", SKILL_KEY_PATTERN);
      const namespace = segments.length === 2 ? this.authorizeNamespace(segments[0]!) : undefined;
      const result = await this.uninstall(actor, slug);
      return {
        text: `## Deleted\n\n- Skill: \`${namespace ? `${namespace}/` : ""}${slug}\`\n- Version: \`${result.version ?? "unknown"}\`\n- Target: \`${result.target}\``,
      };
    }
    throw new SkillHubServiceError(`unknown SkillHub command: ${action}`, 400);
  }

  async notifications(user: PlatformUser, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SkillHubServiceError("notification limit must be between 1 and 100", 400);
    }
    return {
      items: await this.options.store.listSkillHubNotifications(user.id, limit),
      unreadCount: await this.options.store.countUnreadSkillHubNotifications(user.id),
    };
  }

  async unassignedSkills(user: PlatformUser) {
    if (user.globalRole !== "admin") {
      throw new SkillHubServiceError("PlatformClaw administrator required", 403);
    }
    await this.reconcileOwners();
    const items = await this.options.store.listUnassignedSkillHubSkills();
    return {
      items: items.map((skill) =>
        Object.assign(
          {
            namespace: skill.namespace,
            slug: skill.slug,
            currentVersion: skill.currentVersion,
            visibility: skill.visibility,
            changedAt: skill.updatedAt,
          },
          skill.previousOwnerUserId ? { previousOwnerId: skill.previousOwnerUserId } : {},
        ),
      ),
    };
  }

  async namespaceBindings(user: PlatformUser) {
    if (user.globalRole !== "admin") {
      throw new SkillHubServiceError("PlatformClaw administrator required", 403);
    }
    return {
      bindings: await this.options.store.listSkillHubNamespaceBindings(),
      scopes: (await this.options.store.listManagedScopes())
        .filter((scope) => scope.status === "active")
        .map((scope) =>
          Object.assign(
            { id: scope.id, kind: scope.kind, name: scope.name },
            scope.parentGroupId ? { parentGroupId: scope.parentGroupId } : {},
          ),
        ),
    };
  }

  async setNamespaceBinding(
    user: PlatformUser,
    params: {
      namespace: string;
      scopeKind: "team" | "group" | "part";
      scopeId?: string;
      visibilityCeiling: string;
    },
  ) {
    if (user.globalRole !== "admin") {
      throw new SkillHubServiceError("PlatformClaw administrator required", 403);
    }
    const namespace = this.authorizeNamespace(params.namespace);
    const binding = await this.options.store.setSkillHubNamespaceBinding({
      namespace,
      scopeKind: params.scopeKind,
      ...(params.scopeId ? { scopeId: params.scopeId.trim() } : {}),
      visibilityCeiling: validVisibility(params.visibilityCeiling),
      actorUserId: user.id,
      changedAt: this.now(),
    });
    await this.audit(user.id, "skill-hub.namespace.bound", namespace, binding);
    return binding;
  }

  async removeNamespaceBinding(user: PlatformUser, namespaceRaw: string) {
    if (user.globalRole !== "admin") {
      throw new SkillHubServiceError("PlatformClaw administrator required", 403);
    }
    const namespace = this.authorizeNamespace(namespaceRaw);
    const removed = await this.options.store.removeSkillHubNamespaceBinding(namespace);
    if (removed) {
      await this.audit(user.id, "skill-hub.namespace.unbound", namespace, {});
    }
    return { ok: true, removed };
  }

  async markNotificationsRead(user: PlatformUser, ids?: readonly string[]) {
    if (ids && (ids.length > 100 || ids.some((id) => !id.trim() || id.length > 128))) {
      throw new SkillHubServiceError("invalid notification ids", 400);
    }
    const updated = await this.options.store.markSkillHubNotificationsRead({
      userId: user.id,
      ...(ids ? { ids: ids.map((id) => id.trim()) } : {}),
      readAt: this.now(),
    });
    return { ok: true, updated };
  }

  async transferOwner(
    actor: PlatformUser,
    namespaceRaw: string,
    slugRaw: string,
    ownerUserId: string,
  ) {
    const {
      namespace,
      slug,
      ownership: current,
    } = await this.requireManagedSkill(actor, namespaceRaw, slugRaw);
    const nextOwner = await this.options.store.getUserById(ownerUserId.trim());
    if (!nextOwner || nextOwner.status !== "active") {
      throw new SkillHubServiceError("new owner must be an active PlatformClaw user", 400);
    }
    const changedAt = this.now();
    const ownership = await this.options.store.transferSkillHubOwner({
      namespace,
      slug,
      expectedOwnerUserId: current.ownerUserId,
      ownerUserId: nextOwner.id,
      changedAt,
    });
    await this.options.store.createSkillHubNotification({
      userId: nextOwner.id,
      kind: "owner-transferred",
      namespace,
      slug,
      message: `You now own ${namespace}/${slug}.`,
      createdAt: changedAt,
    });
    await this.audit(actor.id, "skill-hub.owner.transferred", `${namespace}/${slug}`, {
      fromUserId: current.ownerUserId,
      toUserId: nextOwner.id,
    });
    return ownership;
  }

  async listAccess(actor: PlatformUser, namespaceRaw: string, slugRaw: string) {
    const { namespace, slug } = await this.requireManagedSkill(actor, namespaceRaw, slugRaw);
    return { items: await this.options.store.listSkillHubAccess(namespace, slug, this.now()) };
  }

  async setAccess(
    actor: PlatformUser,
    namespaceRaw: string,
    slugRaw: string,
    params: {
      userId: string;
      expiresAt?: number;
      inheritVersions: boolean;
      version?: string;
    },
  ) {
    const { namespace, slug, ownership } = await this.requireManagedSkill(
      actor,
      namespaceRaw,
      slugRaw,
    );
    const now = this.now();
    if (
      params.expiresAt !== undefined &&
      (!Number.isSafeInteger(params.expiresAt) || params.expiresAt <= now)
    ) {
      throw new SkillHubServiceError("access expiry must be in the future", 400);
    }
    const version = params.inheritVersions
      ? undefined
      : validVersion(params.version ?? ownership.currentVersion);
    const grant = await this.options.store.setSkillHubAccess({
      namespace,
      slug,
      userId: params.userId.trim(),
      grantedByUserId: actor.id,
      ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }),
      inheritVersions: params.inheritVersions,
      ...(version ? { grantedVersion: version } : {}),
      changedAt: now,
    });
    await this.options.store.createSkillHubNotification({
      userId: grant.userId,
      kind: "access-granted",
      namespace,
      slug,
      message: `You can now access ${namespace}/${slug}.`,
      createdAt: now,
    });
    await this.audit(actor.id, "skill-hub.access.granted", `${namespace}/${slug}`, {
      userId: grant.userId,
      expiresAt: grant.expiresAt ?? null,
      inheritVersions: grant.inheritVersions,
      canReshare: false,
    });
    return grant;
  }

  async removeAccess(actor: PlatformUser, namespaceRaw: string, slugRaw: string, userId: string) {
    const { namespace, slug } = await this.requireManagedSkill(actor, namespaceRaw, slugRaw);
    const removed = await this.options.store.removeSkillHubAccess(namespace, slug, userId.trim());
    if (removed) {
      await this.audit(actor.id, "skill-hub.access.revoked", `${namespace}/${slug}`, {
        userId: userId.trim(),
      });
    }
    return { ok: true, removed };
  }

  async acknowledgeForcePublish(
    actor: PlatformUser,
    namespaceRaw: string,
    slugRaw: string,
    params: { version: string; acknowledged: boolean; reason: string },
  ) {
    const { namespace, slug } = await this.requireManagedSkill(actor, namespaceRaw, slugRaw);
    const version = validVersion(params.version);
    const reason = params.reason.trim();
    if (!params.acknowledged || reason.length < 10 || reason.length > 1_000) {
      throw new SkillHubServiceError(
        "force publish requires acknowledgement and a reason between 10 and 1000 characters",
        400,
      );
    }
    if (!this.options.governance) {
      throw new SkillHubServiceError("Skill Hub force publish is not configured", 503);
    }
    let approval: { reviewId: number; status: string };
    try {
      approval = await this.options.governance.approvePendingReview({
        namespace,
        slug,
        version,
        comment: reason,
      });
    } catch (error) {
      if (error instanceof SkillHubGovernanceError) {
        throw new SkillHubServiceError(error.message, error.statusCode === 409 ? 409 : 502);
      }
      throw new SkillHubServiceError("Skill Hub force publish failed", 502);
    }
    await this.options.store.updateSkillHubGovernanceJob({
      namespace,
      slug,
      version,
      state: "approved",
      attempts: 0,
      nextAttemptAt: this.now(),
      lastError: "force-approved",
      updatedAt: this.now(),
    });
    await this.audit(
      actor.id,
      "skill-hub.force-publish.acknowledged",
      `${namespace}/${slug}@${version}`,
      {
        acknowledged: true,
        reason,
        upstreamOverridePerformed: true,
        reviewId: approval.reviewId,
        reviewStatus: approval.status,
      },
    );
    return {
      acknowledged: true,
      version,
      upstreamOverridePerformed: true,
      reviewId: approval.reviewId,
      reviewStatus: approval.status,
    };
  }

  override async processGovernanceQueue(): Promise<{ processed: number }> {
    if (!this.options.governance || this.governanceClosed || this.governanceProcessing) {
      return { processed: 0 };
    }
    this.governanceProcessing = true;
    let processed = 0;
    try {
      const now = this.now();
      const jobs = await this.options.store.listDueSkillHubGovernanceJobs(now, 10);
      for (const job of jobs) {
        processed += 1;
        const attempts = job.attempts + 1;
        try {
          const skill = await this.adapterCall(() =>
            this.options.adapter.getSkill(job.namespace, job.slug),
          );
          const versions = await this.adapterCall(() =>
            this.options.adapter.listVersions(job.namespace, job.slug),
          );
          const version = versions.find((candidate) => candidate.version === job.version);
          if (!version) {
            await this.retryGovernanceJob(job, attempts, "version-not-visible");
            continue;
          }
          const audits = await this.adapterCall(() =>
            this.options.adapter.listSecurityAudits(skill.id, version.id),
          );
          const terminal =
            audits.length > 0 &&
            audits.every((audit) => !["PENDING", "SCANNING"].includes(audit.verdict.toUpperCase()));
          if (!terminal) {
            await this.retryGovernanceJob(job, attempts, "scan-pending");
            continue;
          }
          if (audits.some((audit) => audit.isSafe !== true)) {
            await this.finishGovernanceJob(job, "blocked", attempts, "scan-unsafe");
            if (job.ownerUserId) {
              await this.options.store.createSkillHubNotification({
                userId: job.ownerUserId,
                kind: "scan-blocked",
                namespace: job.namespace,
                slug: job.slug,
                message: `${job.namespace}/${job.slug}@${job.version} did not pass security scanning.`,
                createdAt: now,
              });
            }
            continue;
          }
          const approval = await this.options.governance.approvePendingReview({
            namespace: job.namespace,
            slug: job.slug,
            version: job.version,
            comment: "PlatformClaw automatic approval after a clean security scan.",
          });
          await this.finishGovernanceJob(job, "approved", attempts);
          // Approval is an external irreversible side effect. Persist it before
          // ancillary delivery so a notification failure never repeats approval.
          const sideEffects = await Promise.allSettled([
            this.audit(
              undefined,
              "skill-hub.review.auto-approved",
              `${job.namespace}/${job.slug}@${job.version}`,
              {
                reviewId: approval.reviewId,
                reviewStatus: approval.status,
              },
            ),
            ...(job.ownerUserId
              ? [
                  this.options.store.createSkillHubNotification({
                    userId: job.ownerUserId,
                    kind: "scan-approved",
                    namespace: job.namespace,
                    slug: job.slug,
                    message: `${job.namespace}/${job.slug}@${job.version} passed scanning and was published.`,
                    createdAt: now,
                  }),
                ]
              : []),
          ]);
          if (sideEffects.some((result) => result.status === "rejected")) {
            await this.options.store.updateSkillHubGovernanceJob({
              namespace: job.namespace,
              slug: job.slug,
              version: job.version,
              state: "approved",
              attempts,
              nextAttemptAt: now,
              lastError: "approval-side-effect-failed",
              updatedAt: now,
            });
          }
        } catch {
          await this.retryGovernanceJob(job, attempts, "governance-unavailable");
        }
      }
    } finally {
      this.governanceProcessing = false;
      this.triggerGovernanceProcessing(30_000);
    }
    return { processed };
  }
}

function skillHubHelpEn(): string {
  return [
    "## SkillHub commands",
    "",
    "- `/skillhub help [ko|en]`",
    "- `/skillhub list [page]`",
    "- `/skillhub installed`",
    "- `/skillhub install <slug|namespace/slug>`",
    "- `/skillhub update <slug|namespace/slug>`",
    "- `/skillhub delete <slug|namespace/slug> --confirm`",
  ].join("\n");
}

function skillHubHelpKo(): string {
  return [
    "## SkillHub 명령어",
    "",
    "- `/skillhub help [ko|en]`: 도움말",
    "- `/skillhub list [페이지]`: 다운로드 가능한 스킬",
    "- `/skillhub installed`: 현재 설치된 스킬",
    "- `/skillhub install <slug|namespace/slug>`: 설치",
    "- `/skillhub update <slug|namespace/slug>`: 업데이트",
    "- `/skillhub delete <slug|namespace/slug> --confirm`: 현재 실행 대상에서 제거",
  ].join("\n");
}
