import type { PlatformUser } from "./contracts.js";
import { SkillHubCommandService } from "./skill-hub-command-service.js";
import {
  SkillHubGovernanceError,
  type SkillHubEditableMetadata,
} from "./skill-hub-governance-client.js";
import {
  safeName,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  validVisibility,
} from "./skill-hub-service-support.js";
import type {
  SkillHubEditCompletion,
  SkillHubEditIntent,
  SkillHubEditResult,
} from "./skill-hub-state.js";

export type SkillHubEditRequest = {
  operationId: string;
  namespace: string;
  displayName: string;
  summary: string;
  visibility: string;
  expectedOwnerUpdatedAt: number;
  expectedRegistryRevision: string;
};

export abstract class SkillHubEditService extends SkillHubCommandService {
  async editPublishedSkill(
    actor: PlatformUser,
    namespaceRaw: string,
    slugRaw: string,
    params: SkillHubEditRequest,
  ) {
    if (!this.options.governance?.getEditableSkill || !this.options.governance.editSkill) {
      throw new SkillHubServiceError(
        "Skill Hub editing is unavailable; configure the managed registry runtime.",
        503,
      );
    }
    const namespace = this.authorizeNamespace(namespaceRaw);
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const targetNamespace = this.authorizeNamespace(params.namespace);
    const displayName = params.displayName.trim();
    const summary = params.summary.trim();
    const visibility = validVisibility(params.visibility);
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(params.operationId) ||
      !displayName ||
      displayName.length > 200 ||
      summary.length > 4_000 ||
      !Number.isSafeInteger(params.expectedOwnerUpdatedAt) ||
      params.expectedOwnerUpdatedAt < 1 ||
      !params.expectedRegistryRevision ||
      params.expectedRegistryRevision.length > 100
    ) {
      throw new SkillHubServiceError("Invalid Skill Hub edit fields; reload and retry.", 400);
    }
    return await this.withRegistryMutationLocks(
      [
        { namespace, slug },
        { namespace: targetNamespace, slug },
      ],
      async () => {
        const prior = await this.options.store.getSkillHubEdit(params.operationId);
        if (prior) {
          const sameRequest =
            prior.namespace === namespace &&
            prior.slug === slug &&
            prior.actorUserId === actor.id &&
            prior.targetNamespace === targetNamespace &&
            prior.displayName === displayName &&
            prior.summary === summary &&
            prior.visibility === visibility &&
            prior.expectedOwnerUpdatedAt === params.expectedOwnerUpdatedAt &&
            prior.registryRevision === params.expectedRegistryRevision;
          if (!sameRequest) {
            throw new SkillHubServiceError(
              "Skill Hub edit ID belongs to another request; reload and retry.",
              409,
            );
          }
          if (prior.state === "cancelled") {
            throw new SkillHubServiceError(
              "This edit was rejected; reload and start a new edit.",
              409,
            );
          }
          if (prior.state === "completed") {
            return this.skillEditResponse(prior, prior.result!);
          }
          return await this.applySkillEdit(prior);
        }
        const { ownership } = await this.requireManagedSkill(actor, namespace, slug);
        if (ownership.updatedAt !== params.expectedOwnerUpdatedAt) {
          throw new SkillHubServiceError("Skill Hub skill changed; reload and retry.", 409);
        }
        if (targetNamespace !== namespace) {
          await this.authorizePublishNamespace(actor, targetNamespace);
        }
        await this.authorizeVisibilityCeiling(targetNamespace, visibility);
        const source = await this.resolveNamespaceCapabilities(actor, namespace);
        const target = await this.resolveNamespaceCapabilities(actor, targetNamespace);
        if (!source.binding || !target.binding) {
          throw new SkillHubServiceError("Skill Hub namespace must have a managed binding.", 409);
        }
        if (ownership.ownerUserId && targetNamespace !== namespace) {
          const owner = await this.options.store.getUserById(ownership.ownerUserId);
          if (
            !owner ||
            owner.status !== "active" ||
            !(await this.resolveNamespaceCapabilities(owner, targetNamespace)).canOwn
          ) {
            throw new SkillHubServiceError(
              "Transfer ownership to a member of the destination namespace before moving this skill.",
              409,
            );
          }
        }
        const metadata = await this.options.governance!.getEditableSkill!(namespace, slug);
        if (metadata.revision !== params.expectedRegistryRevision) {
          throw new SkillHubServiceError("Skill Hub metadata changed; reload and retry.", 409);
        }
        const intent = await this.options.store.beginSkillHubEdit({
          id: params.operationId,
          namespace,
          slug,
          targetNamespace,
          skillId: metadata.id,
          registryRevision: metadata.revision,
          displayName,
          summary,
          visibility,
          actorUserId: actor.id,
          expectedOwnerUpdatedAt: params.expectedOwnerUpdatedAt,
          expectedSourceBindingUpdatedAt: source.binding.updatedAt,
          expectedTargetBindingUpdatedAt: target.binding.updatedAt,
          changedAt: this.now(),
        });
        return await this.applySkillEdit(intent);
      },
    );
  }

  protected async recoverPendingSkillEdits(): Promise<number> {
    if (!this.options.governance?.editSkill) {
      return 0;
    }
    const intents = await this.options.store.listPendingSkillHubEdits(10);
    for (const intent of intents) {
      await this.withRegistryMutationLocks(
        [
          { namespace: intent.namespace, slug: intent.slug },
          { namespace: intent.targetNamespace, slug: intent.slug },
        ],
        async () => {
          const current = await this.options.store.getSkillHubEdit(intent.id);
          if (current?.state !== "pending") {
            return;
          }
          try {
            await this.applySkillEdit(current);
          } catch {
            // The durable intent reserves both coordinates until registry replay and
            // local finalization succeed. Never guess whether a lost HTTP reply committed.
          } finally {
            await this.options.store.recordSkillHubEditRecoveryAttempt({
              id: current.id,
              attemptedAt: this.now(),
            });
          }
        },
      );
    }
    return intents.length;
  }

  private async applySkillEdit(intent: SkillHubEditIntent) {
    if (intent.privacy) {
      return await this.applySkillEditPrivacy(intent);
    }

    let metadata: SkillHubEditableMetadata;
    try {
      metadata = await this.options.governance!.editSkill!({
        operationId: intent.id,
        skillId: intent.skillId,
        namespace: intent.namespace,
        slug: intent.slug,
        expectedRevision: intent.registryRevision,
        targetNamespace: intent.targetNamespace,
        displayName: intent.displayName,
        summary: intent.summary,
        visibility: intent.visibility,
      });
    } catch (error) {
      if (
        error instanceof SkillHubGovernanceError &&
        [400, 404, 409, 422].includes(error.statusCode ?? 0)
      ) {
        await this.options.store.cancelSkillHubEdit({
          id: intent.id,
          actorUserId: intent.actorUserId,
          changedAt: this.now(),
          reason: `registry-rejected-${error.statusCode}`,
        });
        throw new SkillHubServiceError(
          error.statusCode === 422
            ? "Publish a new Private version before sharing this skill."
            : "The registry rejected this edit; reload the skill and retry.",
          error.statusCode!,
        );
      }
      this.triggerGovernanceProcessing();
      throw new SkillHubServiceError("Skill Hub edit is pending recovery; retry shortly.", 503, {
        code: "skill-hub-edit-pending",
      });
    }
    return await this.finishSkillEdit(intent, metadata);
  }

  private async applySkillEditPrivacy(intent: SkillHubEditIntent) {
    let metadata: SkillHubEditableMetadata;
    try {
      metadata = await this.options.governance!.editSkill!(intent.privacy!);
    } catch (error) {
      if (error instanceof SkillHubGovernanceError && error.statusCode === 409) {
        try {
          const current = await this.options.governance!.getEditableSkill!(
            intent.targetNamespace,
            intent.slug,
          );
          await this.options.store.rebaseSkillHubEditPrivacy({
            id: intent.id,
            expectedOperationId: intent.privacy!.operationId,
            metadata: current,
            changedAt: this.now(),
          });
        } catch {
          // Keep the durable privacy phase and both reservations until a later
          // recovery pass can reconcile a definite revision conflict.
        }
      }
      this.triggerGovernanceProcessing();
      throw new SkillHubServiceError("Registry privacy recovery is pending; retry shortly.", 503, {
        code: "skill-hub-edit-pending",
      });
    }
    return await this.finishSkillEdit(intent, metadata, intent.privacy!.operationId);
  }

  private async finishSkillEdit(
    intent: SkillHubEditIntent,
    metadata: SkillHubEditableMetadata,
    privacyConfirmedOperationId?: string,
  ): Promise<ReturnType<SkillHubEditService["skillEditResponse"]>> {
    let completion: SkillHubEditCompletion;
    try {
      completion = await this.options.store.completeSkillHubEdit({
        id: intent.id,
        changedAt: this.now(),
        registryMetadata: metadata,
        ...(privacyConfirmedOperationId ? { privacyConfirmedOperationId } : {}),
        reviewVersions: metadata.reviewVersions,
        publicationPending:
          metadata.visibility !== metadata.effectiveVisibility ||
          metadata.reviewVersions.length > 0,
      });
    } catch {
      this.triggerGovernanceProcessing();
      throw new SkillHubServiceError(
        "Registry edit saved; PlatformClaw reconciliation is pending. Retry shortly.",
        503,
        { code: "skill-hub-edit-pending" },
      );
    }
    if (completion.state === "privacy-required") {
      return await this.applySkillEditPrivacy(completion.intent);
    }
    this.triggerGovernanceProcessing();
    return this.skillEditResponse(intent, completion.result);
  }

  private skillEditResponse(intent: SkillHubEditIntent, result: SkillHubEditResult) {
    return {
      ok: true as const,
      namespace: intent.targetNamespace,
      slug: intent.slug,
      ...(result.reconciliationRequired ? { ownershipReviewRequired: true as const } : {}),
      ...(result.publicationPending ? { publicationPending: true as const } : {}),
    };
  }
}
