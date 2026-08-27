import type { PlatformUser } from "./contracts.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";
import { SkillHubPublicationService } from "./skill-hub-service-publication.js";
import {
  compareSemVer,
  projectSkillHubAccessGrant,
  safeName,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  validVersion,
  validVisibility,
} from "./skill-hub-service-support.js";
import type { SkillHubNamespaceBinding } from "./skill-hub-state.js";

function projectNamespaceBinding(binding: SkillHubNamespaceBinding) {
  return Object.assign(
    {
      namespace: binding.namespace,
      scopeKind: binding.scopeKind,
      accessState: binding.accessState,
      visibilityCeiling: binding.visibilityCeiling,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    },
    binding.scopeId ? { scopeId: binding.scopeId } : {},
  );
}

export {
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SKILL_HUB_UPLOAD_ENTRY_BYTES,
  SKILL_HUB_UPLOAD_ENTRIES,
  SKILL_HUB_UPLOAD_EXPANDED_BYTES,
  MAX_SKILL_FILES,
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
        text: `## Published\n\n- Skill: \`${result.namespace}/${result.slug}\`\n- Version: \`${result.version}\`\n- Source: \`${execution.activeTarget}\`\n- Visibility: \`${visibility}\``,
      };
    }
    if (action === "install" || action === "update") {
      if (tail.length !== 1) {
        throw new SkillHubServiceError(`usage: /skillhub ${action} <slug|namespace/slug>`, 400);
      }
      const skill = await this.resolveCommandSkill(actor.user, tail[0]!);
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
      const verb = action === "update" ? "Updated" : "Installed";
      return {
        text: `## ${verb}\n\n- Skill: \`${skill.namespace}/${skill.slug}\`\n- Version: \`${skill.version}\`\n- Target: \`${execution.activeTarget}\``,
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
        text: `## Deleted\n\n- Skill: \`${slug}\`\n- Version: \`${result.version ?? "unknown"}\`\n- Target: \`${result.target}\``,
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
      items: items.map((skill) => ({
        namespace: skill.namespace,
        slug: skill.slug,
        currentVersion: skill.currentVersion,
        visibility: skill.visibility,
        changedAt: skill.updatedAt,
      })),
    };
  }

  async namespaceBindings(user: PlatformUser) {
    if (user.globalRole !== "admin") {
      throw new SkillHubServiceError("PlatformClaw administrator required", 403);
    }
    return {
      bindings: (await this.options.store.listSkillHubNamespaceBindings()).map(
        projectNamespaceBinding,
      ),
      scopes: (await this.options.organization.listScopes())
        .filter((scope) => scope.status === "active")
        .map((scope) =>
          Object.assign(
            { id: scope.id, kind: scope.kind, name: scope.name },
            scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {},
          ),
        ),
    };
  }

  async setNamespaceBinding(
    user: PlatformUser,
    params: {
      namespace: string;
      scopeKind: "global" | "team" | "group" | "part";
      scopeId?: string;
      visibilityCeiling: string;
      expectedUpdatedAt: number | null;
      reason: string;
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
      accessState: params.scopeKind === "global" ? "restricted" : "active",
      visibilityCeiling: validVisibility(params.visibilityCeiling),
      expectedUpdatedAt: params.expectedUpdatedAt,
      reason: params.reason,
      actorUserId: user.id,
      changedAt: this.now(),
    });
    return projectNamespaceBinding(binding);
  }

  async setNamespaceAccessState(
    user: PlatformUser,
    namespaceRaw: string,
    params: { accessState: "active" | "restricted"; expectedUpdatedAt: number; reason: string },
  ) {
    if (user.globalRole !== "admin") {
      throw new SkillHubServiceError("PlatformClaw administrator required", 403);
    }
    const namespace = this.authorizeNamespace(namespaceRaw);
    return projectNamespaceBinding(
      await this.options.store.setSkillHubNamespaceAccessState({
        namespace,
        ...params,
        actorUserId: user.id,
        changedAt: this.now(),
      }),
    );
  }

  async removeNamespaceBinding(
    user: PlatformUser,
    namespaceRaw: string,
    params: { expectedUpdatedAt: number; reason: string },
  ) {
    if (user.globalRole !== "admin") {
      throw new SkillHubServiceError("PlatformClaw administrator required", 403);
    }
    const namespace = this.authorizeNamespace(namespaceRaw);
    const removed = await this.options.store.removeSkillHubNamespaceBinding({
      namespace,
      ...params,
      actorUserId: user.id,
      changedAt: this.now(),
    });
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
    expectedOwnerUpdatedAt: number,
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
    if (!(await this.resolveNamespaceCapabilities(nextOwner, namespace)).canOwn) {
      throw new SkillHubServiceError("new owner is not eligible for this namespace", 400);
    }
    const registrySkill = await this.adapterCall(() =>
      this.options.adapter.getSkill(namespace, slug),
    );
    this.validateSkillIdentity(registrySkill.namespace, registrySkill.slug, namespace, slug);
    const changedAt = this.now();
    const ownership = await this.options.store.transferSkillHubOwner({
      namespace,
      slug,
      expectedOwnerUserId: current.ownerUserId,
      expectedOwnerUpdatedAt,
      ownerUserId: nextOwner.id,
      registryVisibility: registrySkill.visibility,
      actorUserId: actor.id,
      changedAt,
    });
    return { ownerUserId: ownership.ownerUserId };
  }

  async listAccess(actor: PlatformUser, namespaceRaw: string, slugRaw: string) {
    const { namespace, slug } = await this.requireManagedSkill(actor, namespaceRaw, slugRaw);
    return {
      items: (await this.options.store.listSkillHubAccess(namespace, slug, this.now())).map(
        projectSkillHubAccessGrant,
      ),
    };
  }

  async searchManagementUsers(
    actor: PlatformUser,
    namespaceRaw: string,
    slugRaw: string,
    query: string,
    purpose: "owner" | "access",
    limit = 20,
  ) {
    const namespace = this.authorizeNamespace(namespaceRaw);
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 20)) : 20;
    return {
      items: await this.options.store.searchSkillHubManagementUsers({
        namespace,
        slug,
        actorUserId: actor.id,
        query,
        purpose,
        limit: boundedLimit,
      }),
    };
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
    return projectSkillHubAccessGrant(grant);
  }

  async removeAccess(actor: PlatformUser, namespaceRaw: string, slugRaw: string, userId: string) {
    const { namespace, slug } = await this.requireManagedSkill(actor, namespaceRaw, slugRaw);
    const removed = await this.options.store.removeSkillHubAccess({
      namespace,
      slug,
      userId: userId.trim(),
      actorUserId: actor.id,
      changedAt: this.now(),
    });
    return { ok: true, removed };
  }

  async acknowledgeForcePublish(
    actor: PlatformUser,
    namespaceRaw: string,
    slugRaw: string,
    params: { version: string; acknowledged: boolean; reason: string },
  ) {
    const {
      namespace,
      slug,
      ownership: expectedOwnership,
    } = await this.requireManagedSkill(actor, namespaceRaw, slugRaw);
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
    await this.requireManagedSkill(actor, namespace, slug);
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
    await this.reconcileOwners();
    const currentOwnership = await this.options.store.getSkillHubOwnership(namespace, slug);
    const ownershipReviewRequired =
      !currentOwnership?.ownerUserId ||
      currentOwnership.ownerUserId !== expectedOwnership.ownerUserId ||
      currentOwnership.updatedAt !== expectedOwnership.updatedAt;
    await this.options.store.updateSkillHubGovernanceJob({
      namespace,
      slug,
      version,
      state: ownershipReviewRequired ? "blocked" : "approved",
      attempts: 0,
      nextAttemptAt: this.now(),
      lastError: ownershipReviewRequired ? "owner-review-required" : "force-approved",
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
        ownershipReviewRequired,
      },
    );
    return {
      acknowledged: true,
      version,
      upstreamOverridePerformed: true,
      reviewId: approval.reviewId,
      reviewStatus: approval.status,
      ...(ownershipReviewRequired ? { ownershipReviewRequired: true as const } : {}),
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
          await this.reconcileOwners();
          const currentOwnership = await this.options.store.getSkillHubOwnership(
            job.namespace,
            job.slug,
          );
          if (!job.ownerUserId || currentOwnership?.ownerUserId !== job.ownerUserId) {
            await this.finishGovernanceJob(job, "blocked", attempts, "owner-review-required");
            continue;
          }
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
    "- `/skillhub help [ko|en]`: 도움말",
    "- `/skillhub list [페이지]`: 다운로드 가능한 스킬",
    "- `/skillhub installed`: 현재 설치된 스킬",
    "- `/skillhub publish <slug>`: 현재 작업공간의 스킬 게시",
    "- `/skillhub install <slug|namespace/slug>`: 설치",
    "- `/skillhub update <slug|namespace/slug>`: 업데이트",
    "- `/skillhub delete <slug> --confirm`: 현재 실행 대상에서 제거",
  ].join("\n");
}
