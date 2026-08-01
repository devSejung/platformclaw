import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
} from "../lifecycle/skill-change-hook.js";
import type { SkillProposalApplyTransitionDependencies } from "./apply-transition.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import {
  clearSkillProposalRollback,
  readSkillProposalRollback,
  writeSkillProposalRollback,
} from "./store-sqlite-rollback.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import { commitPendingSkillProposalTransition } from "./store-sqlite-transition.js";
import {
  assertSkillWorkshopTargetAccess,
  hashExternalSkillTree,
  readExternalSkillTree,
} from "./target-access.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  type SkillProposalActionInput,
  type SkillProposalApplyResult,
  type SkillProposalEvaluateResult,
  type SkillProposalEvent,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalSupportFile,
  type SkillWorkshopTargetFile,
} from "./types.js";

type PreparedSkillProposalSupportFile = SkillProposalSupportFile & { content: string };

export type ExternalSkillMutationOperations = {
  markStale: (params: {
    record: SkillProposalRecord;
    reason: string;
    message: string;
    input: SkillProposalActionInput;
  }) => Promise<never>;
  assertSupportTargetUnchanged: (params: {
    record: SkillProposalRecord;
    file: SkillProposalSupportFile;
    currentContent: string | null;
    input: Pick<
      SkillProposalActionInput,
      "agentId" | "correlationId" | "env" | "eventActor" | "workspaceDir"
    >;
  }) => Promise<void>;
};

function storeOptions(env?: NodeJS.ProcessEnv): SkillWorkshopStoreOptions {
  return env ? { env } : {};
}

export async function reconcileExternalSkillMutation(params: {
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

export async function applyExternalSkillMutationAndCommit(params: {
  input: SkillProposalActionInput;
  record: SkillProposalRecord;
  content: string;
  supportFiles: readonly PreparedSkillProposalSupportFile[];
  scan: SkillProposalRecord["scan"];
  evaluation: SkillProposalEvaluateResult["evaluation"];
  operations: ExternalSkillMutationOperations;
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
    await params.operations.markStale({
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
    await params.operations.markStale({
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
    await params.operations.assertSupportTargetUnchanged({
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
    status: "applied",
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
    const authoritativeTree = await readExternalSkillTree(access, params.record.target.skillDir);
    await access.mutateSkill({
      mode: "restore",
      skillDir: params.record.target.skillDir,
      expectedTree: authoritativeTree,
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

export function createSkillProposalRollback(params: {
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
