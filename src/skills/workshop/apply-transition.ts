import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "../lifecycle/skill-change-hook.js";
import {
  applyWorkspaceSkillMutation,
  assertInsideWorkspace,
  isWorkspaceSkillMutationApplied,
  isWorkspaceSkillMutationRestored,
  prepareWorkspaceSkillMutation,
  readWorkspaceSkillFile,
  restoreWorkspaceSkillMutation,
  type PreparedWorkspaceSkillMutation,
} from "../lifecycle/workspace-skill-write.js";
import { resolveAllowedSkillSymlinkTargetRealPaths } from "../loading/symlink-targets.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { readProposalFrontmatter, stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { scanProposalBundle } from "./proposal-scan.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import type { NewSkillProposalEvent } from "./store-sqlite-event.js";
import { readStoredProposal } from "./store-sqlite-record.js";
import {
  clearSkillProposalRollback,
  readSkillProposalRollback,
  writeSkillProposalRollback,
} from "./store-sqlite-rollback.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import {
  commitPendingSkillProposalTransition,
  readCommittedSkillProposalTransition,
  type PendingSkillProposalTransitionCommit,
} from "./store-sqlite-transition.js";
import {
  assertSkillWorkshopTargetAccess,
  hashExternalSkillTree,
  readExternalSkillTree,
} from "./target-access.js";
import { withSkillProposalTargetLock } from "./target-lock.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  type SkillProposalActionInput,
  type SkillProposalApplyResult,
  type SkillProposalEvaluateInput,
  type SkillProposalEvaluateResult,
  type SkillProposalEvent,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalStatus,
  type SkillProposalSupportFile,
  type SkillWorkshopTargetFile,
} from "./types.js";

type SkillProposalApplyOutcome =
  | "apply_failed"
  | "apply_succeeded"
  | "scan_failed"
  | "target_changed";

const SKILL_PROPOSAL_APPLY_TRANSITIONS: Readonly<
  Record<SkillProposalStatus, Partial<Record<SkillProposalApplyOutcome, SkillProposalStatus>>>
> = {
  pending: {
    apply_failed: "pending",
    apply_succeeded: "applied",
    scan_failed: "quarantined",
    target_changed: "stale",
  },
  applied: {},
  rejected: {},
  quarantined: {},
  stale: {},
};

type PreparedSkillProposalSupportFile = SkillProposalSupportFile & { content: string };

export type SkillProposalApplyTransitionDependencies = {
  assertExpectedRevisionHash: (actual: string, expected?: string) => void;
  evaluateSkillProposal: (
    input: SkillProposalEvaluateInput,
  ) => Promise<SkillProposalEvaluateResult>;
  isCreateTargetConflict: (error: unknown) => boolean;
  readProposalSupportFiles: (
    record: SkillProposalRecord,
    options?: SkillWorkshopStoreOptions,
  ) => Promise<PreparedSkillProposalSupportFile[]>;
  readRequiredProposal: (
    proposalId: string,
    workspaceDir?: string,
    env?: NodeJS.ProcessEnv,
    agentId?: string,
    readOptions?: {
      config?: OpenClawConfig;
      reconcile?: boolean;
    },
  ) => Promise<SkillProposalReadResult>;
};

export type SkillProposalTransitionInput = Pick<
  SkillProposalActionInput,
  "agentId" | "correlationId" | "env" | "eventActor" | "workspaceDir"
>;

class SkillProposalLifecycleError extends Error {
  constructor(
    message: string,
    readonly record: SkillProposalRecord,
    readonly event: SkillProposalEvent,
  ) {
    super(message);
  }
}

function resolveSkillProposalApplyTransition(
  status: SkillProposalStatus,
  outcome: SkillProposalApplyOutcome,
): SkillProposalStatus | null {
  return SKILL_PROPOSAL_APPLY_TRANSITIONS[status][outcome] ?? null;
}

export async function applySkillProposalTransition(
  input: SkillProposalActionInput,
  dependencies: SkillProposalApplyTransitionDependencies,
): Promise<SkillProposalApplyResult> {
  const recoveryReadOptions = input.config ? { config: input.config } : undefined;
  const lockedReadOptions = {
    ...(input.config ? { config: input.config } : {}),
    reconcile: false,
  };
  const initial = await dependencies.readRequiredProposal(
    input.proposalId,
    input.workspaceDir,
    input.env,
    input.agentId,
    recoveryReadOptions,
  );
  if (initial.record.status !== "pending") {
    throw new Error(
      `Only pending proposals can be applied. Current status: ${initial.record.status}.`,
    );
  }
  dependencies.assertExpectedRevisionHash(initial.revisionHash, input.expectedRevisionHash);
  const recoveredExternal = await reconcileExternalSkillMutation({
    input,
    initial,
    dependencies,
  });
  if (recoveredExternal) {
    return recoveredExternal;
  }

  let evaluated: SkillProposalEvaluateResult;
  try {
    evaluated = await dependencies.evaluateSkillProposal({
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.eventActor ? { eventActor: input.eventActor } : {}),
      ...(input.env ? { env: input.env } : {}),
      proposalId: input.proposalId,
      expectedRevisionHash: initial.revisionHash,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      trigger: "apply",
      targetAccess: input.targetAccess,
    });
  } catch (error) {
    if (dependencies.isCreateTargetConflict(error)) {
      const staleTransition = withSkillProposalTargetLock(
        initial.record,
        async () => {
          const current = await dependencies.readRequiredProposal(
            input.proposalId,
            input.workspaceDir,
            input.env,
            input.agentId,
            lockedReadOptions,
          );
          if (
            current.record.status === "pending" &&
            current.record.kind === "create" &&
            (current.record.target.binding
              ? input.targetAccess
                ? (await input.targetAccess.fsBridge.stat({
                    filePath: current.record.target.skillFile,
                  })) !== null
                : false
              : (await readWorkspaceSkillFile(current.record.target.skillFile)) !== null)
          ) {
            await markSkillProposalStale({
              record: current.record,
              reason: "Target skill was created after proposal creation.",
              message: "Target skill was created after proposal creation; proposal marked stale.",
              input,
            });
          }
          throw error;
        },
        storeOptions(input.env),
      );
      await withSkillProposalLifecycleDispatch(input, staleTransition);
    }
    throw error;
  }

  const blocking = evaluated.evaluation.outcomes.find(
    (outcome) => outcome.status === "completed" && outcome.result.decision === "block",
  );
  if (blocking?.status === "completed") {
    throw new Error(
      blocking.result.decisionReason ||
        `Skill proposal apply blocked by evaluator ${blocking.evaluatorId}.`,
    );
  }

  const application = withSkillProposalTargetLock(
    evaluated.record,
    async () => {
      const read = await dependencies.readRequiredProposal(
        input.proposalId,
        input.workspaceDir,
        input.env,
        input.agentId,
        lockedReadOptions,
      );
      const { record, content } = read;
      if (record.status !== "pending") {
        throw new Error(`Only pending proposals can be applied. Current status: ${record.status}.`);
      }
      dependencies.assertExpectedRevisionHash(read.revisionHash, evaluated.evaluation.revisionHash);
      if (hashSkillProposalContent(content) !== record.draftHash) {
        throw new Error("Proposal draft changed without updating proposal metadata.");
      }
      const supportFiles = await dependencies.readProposalSupportFiles(
        record,
        storeOptions(input.env),
      );
      if (!readProposalFrontmatter(content)) {
        throw new Error("Proposal draft must include proposal frontmatter.");
      }
      const scan = scanProposalBundle(content, supportFiles);
      if (scan.state !== "clean") {
        await quarantineSkillProposalAfterScan({ input, record, scan });
      }

      assertSkillWorkshopTargetAccess(record, input.targetAccess);
      if (record.target.binding) {
        return await applyExternalSkillMutationAndCommit({
          input,
          record,
          content,
          supportFiles,
          scan,
          evaluation: evaluated.evaluation,
        });
      }

      assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
      assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");
      const workshopConfig = resolveSkillWorkshopConfig(input.config);
      const symlinkPolicy = {
        allowWrites: workshopConfig.allowSymlinkTargetWrites,
        allowedTargetRealPaths: workshopConfig.allowSymlinkTargetWrites
          ? resolveAllowedSkillSymlinkTargetRealPaths(input.config)
          : [],
      };
      if (record.evaluation?.id !== evaluated.evaluation.id) {
        throw new Error("Skill proposal evaluation changed before apply; retry the operation.");
      }
      if (evaluated.evaluation.targetTreeSha256) {
        let currentTargetTreeSha256: string;
        try {
          currentTargetTreeSha256 = await readSkillProposalTargetTreeSha256(record.target.skillDir);
        } catch {
          throw new Error("Skill target changed after evaluation; retry the operation.");
        }
        if (currentTargetTreeSha256 !== evaluated.evaluation.targetTreeSha256) {
          throw new Error("Skill target changed after evaluation; retry the operation.");
        }
      }

      const mutation = await prepareWorkspaceSkillMutation({
        workspaceDir: input.workspaceDir,
        skillDir: record.target.skillDir,
        skillFile: record.target.skillFile,
        content: stripProposalFrontmatterForSkill(content),
        supportFiles,
        mode: record.kind,
        symlinkPolicy,
      });
      await assertApplyTargetUnchanged(record, mutation, input);

      const shouldDispatchSkillChange = hasCommittedSkillChangeHooks();
      const beforeSkill =
        shouldDispatchSkillChange && record.kind === "update"
          ? await snapshotCommittedSkillArtifactBestEffort({
              skillDir: record.target.skillDir,
              skillKey: record.target.skillKey,
              source: "workshop",
            })
          : undefined;
      const rollback = createSkillProposalRollbackFromMutation(record, mutation);
      await writeSkillProposalRollback({
        proposalId: record.id,
        rollback,
        store: storeOptions(input.env),
      });

      try {
        await applyWorkspaceSkillMutation(mutation);
      } catch (error) {
        // A rejected filesystem write may have partially changed its target
        // before throwing. Keep recovery facts unless the full bundle is
        // proven back at the authoritative pre-apply state.
        if (await isWorkspaceSkillMutationRestored(mutation).catch(() => false)) {
          await clearSkillProposalRollback({
            proposalId: record.id,
            expectedRecordJson: JSON.stringify(record),
            store: storeOptions(input.env),
          }).catch(() => false);
        }
        throw error;
      }

      const afterSkill = shouldDispatchSkillChange
        ? await snapshotCommittedSkillArtifactBestEffort({
            skillDir: record.target.skillDir,
            skillKey: record.target.skillKey,
            source: "workshop",
            sourceVersion: record.proposedVersion,
          })
        : undefined;
      const now = new Date().toISOString();
      const applied: SkillProposalRecord = {
        ...record,
        status: requiredApplyStatus("apply_succeeded"),
        updatedAt: now,
        appliedAt: now,
        statusReason: normalizeOptionalString(input.reason),
        scan,
      };
      const eventInput = createSkillProposalEvent({
        record: applied,
        type: "applied",
        actor: input.eventActor,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        occurredAt: now,
        payload: { targetSkillFile: record.target.skillFile },
      });

      let commit: PendingSkillProposalTransitionCommit;
      try {
        commit = commitPendingSkillProposalTransition({
          expected: record,
          record: applied,
          event: eventInput,
          store: storeOptions(input.env),
          operationLabel: "skill-workshop.apply.commit",
        });
      } catch (error) {
        const recoveredEvent = await recoverAfterApplyCommitFailure({
          error,
          expected: record,
          applied,
          event: eventInput,
          mutation,
          env: input.env,
          workspaceDir: input.workspaceDir,
        });
        if (!recoveredEvent) {
          throw error;
        }
        commit = { state: "committed" as const, event: recoveredEvent };
      }
      if (commit.state === "conflict") {
        const error = new Error("Skill proposal changed before apply status commit.");
        const recoveredEvent = await recoverAfterApplyCommitFailure({
          error,
          expected: record,
          applied,
          event: eventInput,
          mutation,
          env: input.env,
          workspaceDir: input.workspaceDir,
        });
        if (!recoveredEvent) {
          throw error;
        }
        commit = { state: "committed" as const, event: recoveredEvent };
      }

      bumpSkillsSnapshotVersion({
        workspaceDir: input.workspaceDir,
        reason: "workshop",
        changedPath: record.target.skillFile,
      });
      return {
        result: { record: applied, targetSkillFile: record.target.skillFile },
        ...(commit.state === "committed" && commit.event ? { event: commit.event } : {}),
        skillChange: shouldDispatchSkillChange
          ? { before: beforeSkill, after: afterSkill }
          : undefined,
      };
    },
    storeOptions(input.env),
  );

  const result = await withSkillProposalLifecycleDispatch(input, application);
  if (result.event) {
    await dispatchSkillProposalChanged({
      event: result.event,
      record: result.result.record,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }
  if (result.skillChange) {
    await dispatchCommittedSkillChangeBestEffort({
      action: result.result.record.kind === "create" ? "created" : "updated",
      source: "workshop",
      workspaceDir: input.workspaceDir,
      before: result.skillChange.before,
      after: result.skillChange.after,
      proposal: {
        id: result.result.record.id,
        revision: result.result.record.proposedVersion,
        revisionSha256: hashSkillProposalRevision(result.result.record),
      },
    });
  }
  return result.result;
}

async function reconcileExternalSkillMutation(params: {
  input: SkillProposalActionInput;
  initial: SkillProposalReadResult;
  dependencies: SkillProposalApplyTransitionDependencies;
}): Promise<SkillProposalApplyResult | null> {
  const { record } = params.initial;
  if (!record.target.binding) {
    return null;
  }
  assertSkillWorkshopTargetAccess(record, params.input.targetAccess);
  const access = params.input.targetAccess!;
  const rollback = await readSkillProposalRollback(record.id, storeOptions(params.input.env));
  if (!rollback || !resolveExternalRollback(record, rollback)) {
    return null;
  }
  const supportFiles = await params.dependencies.readProposalSupportFiles(
    record,
    storeOptions(params.input.env),
  );
  const proposed = new Map<string, Buffer>([
    ...supportFiles.map((file) => [file.path, Buffer.from(file.content, "utf8")] as const),
    ["SKILL.md", Buffer.from(stripProposalFrontmatterForSkill(params.initial.content), "utf8")],
  ]);
  const previous = new Map<string, Buffer | null>([
    ...(rollback.supportFiles?.map(
      (file) =>
        [file.path, file.existed ? Buffer.from(file.previousContent ?? "", "utf8") : null] as const,
    ) ?? []),
    [
      "SKILL.md",
      rollback.action === "update" ? Buffer.from(rollback.previousContent ?? "", "utf8") : null,
    ],
  ]);
  const tree = await readExternalSkillTree(access, record.target.skillDir);
  const current = new Map(tree.map((file) => [file.path, file.content]));
  const states = [...proposed].map(([filePath, proposedContent]) => {
    const currentContent = current.get(filePath) ?? null;
    const previousContent = previous.get(filePath) ?? null;
    if (currentContent?.equals(proposedContent)) {
      return "proposed" as const;
    }
    if (
      (currentContent === null && previousContent === null) ||
      (currentContent !== null &&
        previousContent !== null &&
        currentContent.equals(previousContent))
    ) {
      return "previous" as const;
    }
    return "external" as const;
  });
  if (states.every((state) => state === "proposed")) {
    const now = new Date().toISOString();
    const applied: SkillProposalRecord = {
      ...record,
      status: "applied",
      updatedAt: now,
      appliedAt: now,
    };
    const eventInput = createSkillProposalEvent({
      record: applied,
      type: "applied",
      actor: { type: "system" },
      occurredAt: now,
      payload: { recovered: true, targetSkillFile: record.target.skillFile },
    });
    const commit = commitPendingSkillProposalTransition({
      expected: record,
      record: applied,
      event: eventInput,
      store: storeOptions(params.input.env),
      operationLabel: "skill-workshop.apply.remote.reconcile",
    });
    if (commit.state !== "committed") {
      throw new Error("Skill proposal changed during remote apply recovery.");
    }
    await access.notifyChanged?.();
    if (commit.event) {
      await dispatchSkillProposalChanged({
        event: commit.event,
        record: applied,
        workspaceDir: params.input.workspaceDir,
        ...(params.input.agentId ? { agentId: params.input.agentId } : {}),
      });
    }
    if (hasCommittedSkillChangeHooks()) {
      const beforeByPath = new Map(current);
      for (const [filePath, content] of previous) {
        if (content === null) {
          beforeByPath.delete(filePath);
        } else {
          beforeByPath.set(filePath, content);
        }
      }
      const beforeTree = [...beforeByPath].map(([filePath, fileContent]) => ({
        path: filePath,
        content: fileContent,
      }));
      await dispatchCommittedSkillChangeBestEffort({
        action: record.kind === "create" ? "created" : "updated",
        source: "workshop",
        workspaceDir: params.input.workspaceDir,
        before:
          record.kind === "update" ? snapshotExternalSkillArtifact(record, beforeTree) : undefined,
        after: snapshotExternalSkillArtifact(record, tree, record.proposedVersion),
        proposal: {
          id: record.id,
          revision: record.proposedVersion,
          revisionSha256: hashSkillProposalRevision(applied),
        },
      });
    }
    return { record: applied, targetSkillFile: record.target.skillFile };
  }
  if (states.some((state) => state === "external")) {
    throw new Error(
      "VM skill changed during interrupted apply recovery. Inspect the target before retrying.",
    );
  }
  if (states.some((state) => state === "proposed")) {
    await access.mutateSkill({
      mode: "restore",
      skillDir: record.target.skillDir,
      expectedTree: tree,
      files: [...previous].map(([filePath, content]) => ({ path: filePath, content })),
    });
    await access.notifyChanged?.();
  }
  await clearSkillProposalRollback({
    proposalId: record.id,
    expectedRecordJson: JSON.stringify(record),
    store: storeOptions(params.input.env),
  });
  return null;
}

function resolveExternalRollback(
  record: SkillProposalRecord,
  rollback: SkillProposalRollback,
): boolean {
  return (
    rollback.schema === SKILL_WORKSHOP_ROLLBACK_SCHEMA &&
    rollback.proposalId === record.id &&
    rollback.action === record.kind &&
    rollback.targetSkillFile === record.target.skillFile
  );
}

async function applyExternalSkillMutationAndCommit(params: {
  input: SkillProposalActionInput;
  record: SkillProposalRecord;
  content: string;
  supportFiles: readonly PreparedSkillProposalSupportFile[];
  scan: SkillProposalRecord["scan"];
  evaluation: SkillProposalEvaluateResult["evaluation"];
}): Promise<{
  result: SkillProposalApplyResult;
  event?: SkillProposalEvent;
  skillChange?: {
    before?: PluginHookSkillArtifact;
    after?: PluginHookSkillArtifact;
  };
}> {
  const access = params.input.targetAccess!;
  const currentTree = await readExternalSkillTree(access, params.record.target.skillDir);
  const currentTreeSha256 = await readSkillProposalTargetTreeSha256(
    params.record.target.skillDir,
    access,
  );
  if (
    params.evaluation.targetTreeSha256 &&
    currentTreeSha256 !== params.evaluation.targetTreeSha256
  ) {
    throw new Error("Skill target changed after evaluation; retry the operation.");
  }
  const currentByPath = new Map(currentTree.map((file) => [file.path, file.content]));
  const currentSkill = currentByPath.get("SKILL.md") ?? null;
  if (params.record.kind === "create" && currentSkill !== null) {
    await markSkillProposalStale({
      record: params.record,
      reason: "Target skill was created after proposal creation.",
      message: "Target skill was created after proposal creation; proposal marked stale.",
      input: params.input,
    });
  }
  if (params.record.kind === "update" && currentSkill === null) {
    throw new Error(`Target skill is missing: ${params.record.target.skillFile}`);
  }
  const currentSkillText = currentSkill ? decodeUtf8SkillFile(currentSkill, "SKILL.md") : null;
  if (
    params.record.kind === "update" &&
    params.record.target.currentContentHash &&
    currentSkillText !== null &&
    hashSkillProposalContent(currentSkillText) !== params.record.target.currentContentHash
  ) {
    await markSkillProposalStale({
      record: params.record,
      reason: "Target skill changed after proposal creation.",
      message: "Target skill changed after proposal creation; proposal marked stale.",
      input: params.input,
    });
  }
  if (params.record.evaluation?.id !== params.evaluation.id) {
    throw new Error("Skill proposal evaluation changed before apply; retry the operation.");
  }
  for (const support of params.supportFiles) {
    const metadata = params.record.supportFiles?.find((file) => file.path === support.path);
    if (!metadata || params.record.kind !== "update") {
      continue;
    }
    const current = currentByPath.get(support.path);
    await assertSkillProposalSupportTargetUnchanged({
      record: params.record,
      file: metadata,
      currentContent: current ? decodeUtf8SkillFile(current, support.path) : null,
      input: params.input,
    });
  }
  const rollback = createSkillProposalRollback({
    proposalId: params.record.id,
    targetSkillFile: params.record.target.skillFile,
    action: params.record.kind,
    ...(currentSkillText !== null ? { previousContent: currentSkillText } : {}),
    ...(params.supportFiles.length > 0
      ? {
          supportFiles: params.supportFiles.map((file) => {
            const previous = currentByPath.get(file.path);
            return previous
              ? {
                  path: file.path,
                  existed: true,
                  previousContent: decodeUtf8SkillFile(previous, file.path),
                  previousContentHash: hashSkillProposalContent(
                    decodeUtf8SkillFile(previous, file.path),
                  ),
                }
              : { path: file.path, existed: false };
          }),
        }
      : {}),
  });
  await writeSkillProposalRollback({
    proposalId: params.record.id,
    rollback,
    store: storeOptions(params.input.env),
  });
  const nextFiles = [
    ...params.supportFiles.map((file) => ({
      path: file.path,
      content: Buffer.from(file.content, "utf8"),
    })),
    {
      path: "SKILL.md",
      content: Buffer.from(stripProposalFrontmatterForSkill(params.content), "utf8"),
    },
  ];
  const shouldDispatchSkillChange = hasCommittedSkillChangeHooks();
  const beforeSkill =
    shouldDispatchSkillChange && params.record.kind === "update"
      ? snapshotExternalSkillArtifact(params.record, currentTree)
      : undefined;
  await access.mutateSkill({
    mode: params.record.kind,
    skillDir: params.record.target.skillDir,
    expectedTree: currentTree,
    files: nextFiles,
  });
  const afterByPath = new Map(currentTree.map((file) => [file.path, Buffer.from(file.content)]));
  for (const file of nextFiles) {
    afterByPath.set(file.path, Buffer.from(file.content));
  }
  const afterTree = [...afterByPath].map(([filePath, fileContent]) => ({
    path: filePath,
    content: fileContent,
  }));
  const afterSkill = shouldDispatchSkillChange
    ? snapshotExternalSkillArtifact(params.record, afterTree, params.record.proposedVersion)
    : undefined;

  const now = new Date().toISOString();
  const applied: SkillProposalRecord = {
    ...params.record,
    status: requiredApplyStatus("apply_succeeded"),
    updatedAt: now,
    appliedAt: now,
    statusReason: normalizeOptionalString(params.input.reason),
    scan: params.scan,
  };
  const eventInput = createSkillProposalEvent({
    record: applied,
    type: "applied",
    actor: params.input.eventActor,
    ...(params.input.correlationId ? { correlationId: params.input.correlationId } : {}),
    occurredAt: now,
    payload: { targetSkillFile: params.record.target.skillFile },
  });
  const commit = commitPendingSkillProposalTransition({
    expected: params.record,
    record: applied,
    event: eventInput,
    store: storeOptions(params.input.env),
    operationLabel: "skill-workshop.apply.remote.commit",
  });
  if (commit.state !== "committed") {
    const afterTree = await readExternalSkillTree(access, params.record.target.skillDir);
    await access.mutateSkill({
      mode: "restore",
      skillDir: params.record.target.skillDir,
      expectedTree: afterTree,
      files: [
        ...(rollback.supportFiles?.map((file) => ({
          path: file.path,
          content: file.existed ? Buffer.from(file.previousContent ?? "", "utf8") : null,
        })) ?? []),
        {
          path: "SKILL.md",
          content:
            rollback.action === "update"
              ? Buffer.from(rollback.previousContent ?? "", "utf8")
              : null,
        },
      ],
    });
    await clearSkillProposalRollback({
      proposalId: params.record.id,
      expectedRecordJson: JSON.stringify(params.record),
      store: storeOptions(params.input.env),
    });
    throw new Error("Skill proposal changed before apply status commit.");
  }
  await access.notifyChanged?.();
  return {
    result: { record: applied, targetSkillFile: params.record.target.skillFile },
    ...(commit.event ? { event: commit.event } : {}),
    skillChange: shouldDispatchSkillChange ? { before: beforeSkill, after: afterSkill } : undefined,
  };
}

function snapshotExternalSkillArtifact(
  record: SkillProposalRecord,
  files: readonly SkillWorkshopTargetFile[],
  sourceVersion?: string,
): PluginHookSkillArtifact | undefined {
  const skillFile = files.find((file) => file.path === "SKILL.md");
  if (!skillFile) {
    return undefined;
  }
  return {
    name: record.target.skillName,
    skillKey: record.target.skillKey,
    description: record.description,
    skillFile: record.target.skillFile,
    skillDir: record.target.skillDir,
    source: record.target.source ?? "workshop",
    revision: {
      contentSha256: `sha256:${sha256Hex(skillFile.content)}`,
      treeSha256: `sha256:${hashExternalSkillTree(files)}`,
      ...(sourceVersion ? { sourceVersion } : {}),
    },
  };
}

function decodeUtf8SkillFile(content: Buffer, filePath: string): string {
  const decoded = content.toString("utf8");
  if (decoded.includes("\0") || !Buffer.from(decoded, "utf8").equals(content)) {
    throw new Error(`Skill Workshop can only update UTF-8 text files: ${filePath}`);
  }
  return decoded;
}

export async function withSkillProposalLifecycleDispatch<T>(
  input: SkillProposalTransitionInput,
  operation: Promise<T>,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof SkillProposalLifecycleError) {
      await dispatchSkillProposalChanged({
        event: error.event,
        record: error.record,
        workspaceDir: input.workspaceDir,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
    }
    throw error;
  }
}

export async function assertSkillProposalSupportTargetUnchanged(params: {
  input: SkillProposalTransitionInput;
  record: SkillProposalRecord;
  file: SkillProposalSupportFile;
  currentContent: string | null;
}): Promise<void> {
  const { record, file, currentContent } = params;
  if (file.targetExisted === false && currentContent !== null) {
    await markSkillProposalStale({
      record,
      reason: `Target support file changed after proposal creation: ${file.path}`,
      message: "Target support file changed after proposal creation; proposal marked stale.",
      input: params.input,
    });
  }
  if (file.targetExisted === true) {
    const currentHash =
      currentContent === null ? undefined : hashSkillProposalContent(currentContent);
    if (currentHash !== file.targetContentHash) {
      await markSkillProposalStale({
        record,
        reason: `Target support file changed after proposal creation: ${file.path}`,
        message: "Target support file changed after proposal creation; proposal marked stale.",
        input: params.input,
      });
    }
  }
}

export async function markSkillProposalStale(params: {
  record: SkillProposalRecord;
  reason: string;
  message: string;
  input: SkillProposalTransitionInput;
}): Promise<never> {
  const now = new Date().toISOString();
  const stale: SkillProposalRecord = {
    ...params.record,
    status: requiredApplyStatus("target_changed"),
    updatedAt: now,
    staleAt: now,
    statusReason: params.reason,
  };
  const commit = commitPendingSkillProposalTransition({
    expected: params.record,
    record: stale,
    event: createSkillProposalEvent({
      record: stale,
      type: "stale",
      actor: params.input.eventActor,
      ...(params.input.correlationId ? { correlationId: params.input.correlationId } : {}),
      occurredAt: now,
    }),
    store: storeOptions(params.input.env),
    operationLabel: "skill-workshop.stale.commit",
  });
  if (commit.state !== "committed" || !commit.event) {
    throw new Error("Failed to record stale Skill Workshop proposal.");
  }
  throw new SkillProposalLifecycleError(params.message, stale, commit.event);
}

function createSkillProposalRollback(params: {
  proposalId: string;
  targetSkillFile: string;
  action: "create" | "update";
  previousContent?: string;
  supportFiles?: SkillProposalRollback["supportFiles"];
}): SkillProposalRollback {
  return {
    schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
    proposalId: params.proposalId,
    writtenAt: new Date().toISOString(),
    targetSkillFile: params.targetSkillFile,
    action: params.action,
    ...(params.previousContent !== undefined
      ? {
          previousContent: params.previousContent,
          previousContentHash: hashSkillProposalContent(params.previousContent),
        }
      : {}),
    ...(params.supportFiles && params.supportFiles.length > 0
      ? { supportFiles: params.supportFiles }
      : {}),
  };
}

async function quarantineSkillProposalAfterScan(params: {
  input: SkillProposalActionInput;
  record: SkillProposalRecord;
  scan: SkillProposalRecord["scan"];
}): Promise<never> {
  const now = new Date().toISOString();
  const updated: SkillProposalRecord = {
    ...params.record,
    status: requiredApplyStatus("scan_failed"),
    updatedAt: now,
    quarantinedAt: now,
    scan: { ...params.scan, state: "quarantined" },
    statusReason: "Proposal scan failed.",
  };
  const commit = commitPendingSkillProposalTransition({
    expected: params.record,
    record: updated,
    event: createSkillProposalEvent({
      record: updated,
      type: "quarantined",
      actor: params.input.eventActor,
      ...(params.input.correlationId ? { correlationId: params.input.correlationId } : {}),
      occurredAt: now,
    }),
    store: storeOptions(params.input.env),
    operationLabel: "skill-workshop.quarantine.commit",
  });
  if (commit.state !== "committed" || !commit.event) {
    throw new Error("Failed to record quarantined Skill Workshop proposal.");
  }
  throw new SkillProposalLifecycleError(
    "Proposal scan failed; proposal was quarantined.",
    updated,
    commit.event,
  );
}

async function assertApplyTargetUnchanged(
  record: SkillProposalRecord,
  mutation: PreparedWorkspaceSkillMutation,
  input: SkillProposalTransitionInput,
): Promise<void> {
  if (
    record.kind === "update" &&
    record.target.currentContentHash &&
    mutation.skillFile.previousContent !== null &&
    hashSkillProposalContent(mutation.skillFile.previousContent) !==
      record.target.currentContentHash
  ) {
    await markSkillProposalStale({
      record,
      reason: "Target skill changed after proposal creation.",
      message: "Target skill changed after proposal creation; proposal marked stale.",
      input,
    });
  }
  for (const file of mutation.supportFiles) {
    const supportRecord = record.supportFiles?.find((entry) => entry.path === file.path);
    if (record.kind === "update" && supportRecord) {
      await assertSkillProposalSupportTargetUnchanged({
        record,
        file: supportRecord,
        currentContent: file.previousContent,
        input,
      });
    }
  }
}

function createSkillProposalRollbackFromMutation(
  record: SkillProposalRecord,
  mutation: PreparedWorkspaceSkillMutation,
): SkillProposalRollback {
  return createSkillProposalRollback({
    proposalId: record.id,
    targetSkillFile: record.target.skillFile,
    action: record.kind,
    ...(mutation.skillFile.previousContent !== null
      ? { previousContent: mutation.skillFile.previousContent }
      : {}),
    ...(mutation.supportFiles.length > 0
      ? {
          supportFiles: mutation.supportFiles.map((file) =>
            file.previousContent === null
              ? { path: file.path, existed: false }
              : {
                  path: file.path,
                  existed: true,
                  previousContent: file.previousContent,
                  previousContentHash: hashSkillProposalContent(file.previousContent),
                },
          ),
        }
      : {}),
  });
}

async function recoverAfterApplyCommitFailure(params: {
  error: unknown;
  expected: SkillProposalRecord;
  applied: SkillProposalRecord;
  event: NewSkillProposalEvent;
  mutation: PreparedWorkspaceSkillMutation;
  env?: NodeJS.ProcessEnv;
  workspaceDir: string;
}): Promise<SkillProposalEvent | null> {
  const committed = readCommittedSkillProposalTransition({
    record: params.applied,
    event: params.event,
    store: storeOptions(params.env),
  });
  if (committed) {
    return committed.event ?? null;
  }
  const authoritative = readStoredProposal(params.expected.id, storeOptions(params.env));
  if (authoritative?.record.status === "applied") {
    throw new Error("Applied Skill Workshop transition is missing its committed event.", {
      cause: params.error,
    });
  }
  requiredApplyStatus("apply_failed");
  const stillApplied = await isWorkspaceSkillMutationApplied(params.mutation).catch(() => false);
  if (!stillApplied) {
    return null;
  }
  try {
    try {
      await restoreWorkspaceSkillMutation(params.mutation);
    } finally {
      bumpSkillsSnapshotVersion({
        workspaceDir: params.workspaceDir,
        reason: "workshop",
        changedPath: params.expected.target.skillFile,
      });
    }
  } catch (restoreError) {
    const failure = new Error(
      "Skill proposal apply failed after filesystem mutation and requires reconciliation.",
      { cause: params.error },
    );
    Object.assign(failure, { restoreError });
    throw failure;
  }
  await clearSkillProposalRollback({
    proposalId: params.expected.id,
    expectedRecordJson: JSON.stringify(params.expected),
    store: storeOptions(params.env),
  }).catch(() => false);
  return null;
}

function requiredApplyStatus(outcome: SkillProposalApplyOutcome): SkillProposalStatus {
  const status = resolveSkillProposalApplyTransition("pending", outcome);
  if (!status) {
    throw new Error(`Invalid pending Skill Workshop apply transition: ${outcome}`);
  }
  return status;
}

function storeOptions(env?: NodeJS.ProcessEnv): SkillWorkshopStoreOptions {
  return env ? { env } : {};
}
