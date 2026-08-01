import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildWorkspaceSkillStatus,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
} from "../discovery/status.js";
import {
  assertInsideWorkspace,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { parseFrontmatter } from "../loading/frontmatter.js";
import {
  applySkillProposalTransition,
  assertSkillProposalSupportTargetUnchanged,
  markSkillProposalStale,
  withSkillProposalLifecycleDispatch,
  type SkillProposalApplyTransitionDependencies,
} from "./apply-transition.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { createSkillProposalEvent, dispatchSkillProposalChanged } from "./plugin-hooks.js";
import {
  nextProposalVersion,
  prepareSkillProposalDraft,
  resolveUpdateProposalDescription,
} from "./proposal-draft.js";
export { readSkillProposalDraftDirectory, readSkillProposalDraftFile } from "./proposal-draft.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import {
  assertExpectedRevisionHash,
  evaluateSkillProposal,
  SkillProposalCreateTargetConflictError,
} from "./service-evaluation.js";
import { readRequiredProposal } from "./service-query.js";
import {
  assertWritableSkillTarget,
  assertSupportTargetsUnchanged,
  buildSupportFileMetadata,
  isWritableWorkspaceSkillSource,
  normalizeRequired,
  resolveExternalSkill,
} from "./service-targets.js";
import {
  createSkillProposalId,
  hashSkillProposalContent,
  readProposalSupportFiles,
  replaceSkillProposalDraft,
  resolveSkillProposalTarget,
  updateSkillProposalRecord,
  writeSkillProposal,
  withSkillProposalTargetLock,
} from "./store.js";
import {
  assertSkillWorkshopTargetAccess,
  readExternalSkillFile,
  resolveExternalSkillTarget,
  skillWorkshopTargetBinding,
} from "./target-access.js";
export {
  getSkillProposalRunProgress,
  inspectSkillProposal,
  listSkillProposals,
  resolvePendingSkillProposal,
} from "./service-query.js";
export { evaluateSkillProposal, listSkillProposalEvents } from "./service-evaluation.js";
import {
  MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalActionInput,
  type SkillProposalApplyResult,
  type SkillProposalCreateInput,
  type SkillProposalOrigin,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalReviseInput,
  type SkillProposalUpdateInput,
} from "./types.js";

type SkillWorkshopWorkspaceOptions = {
  config?: OpenClawConfig;
  agentId?: string;
};

function proposalStoreOptions(env?: NodeJS.ProcessEnv) {
  return env ? { env } : {};
}

const APPLY_TRANSITION_DEPENDENCIES = {
  assertExpectedRevisionHash,
  evaluateSkillProposal,
  isCreateTargetConflict: (error: unknown) =>
    error instanceof SkillProposalCreateTargetConflictError,
  readProposalSupportFiles,
  readRequiredProposal,
} satisfies SkillProposalApplyTransitionDependencies;

function normalizeProposalOrigin(
  origin: SkillProposalOrigin | undefined,
): SkillProposalOrigin | undefined {
  const agentId = normalizeOptionalString(origin?.agentId);
  const sessionKey = normalizeOptionalString(origin?.sessionKey);
  const runId = normalizeOptionalString(origin?.runId);
  const messageId = normalizeOptionalString(origin?.messageId);
  if (!agentId && !sessionKey && !runId && !messageId) {
    return undefined;
  }
  return {
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function mergeProposalOriginRunProvenance(
  record:
    | Pick<SkillProposalRecord, "origin" | "originRunIds" | "originRunMutationCounts">
    | undefined,
  origin: SkillProposalOrigin | undefined,
): { originRunIds?: string[]; originRunMutationCounts?: Record<string, number> } {
  const ids = new Set(record?.originRunIds);
  const counts = { ...record?.originRunMutationCounts };
  if (record?.origin?.runId) {
    ids.add(record.origin.runId);
  }
  for (const runId of ids) {
    counts[runId] ??= 1;
  }
  if (origin?.runId) {
    ids.add(origin.runId);
    counts[origin.runId] = (counts[origin.runId] ?? 0) + 1;
  }
  if (ids.size > MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS) {
    throw new Error("Skill proposal run provenance exceeds the supported limit.");
  }
  return {
    ...(ids.size > 0 ? { originRunIds: [...ids] } : {}),
    ...(Object.keys(counts).length > 0 ? { originRunMutationCounts: counts } : {}),
  };
}

export async function proposeCreateSkill(
  input: SkillProposalCreateInput,
): Promise<SkillProposalReadResult> {
  const name = normalizeRequired(input.name, "Skill name");
  const description = normalizeRequired(input.description, "Skill description");
  const config = resolveSkillWorkshopConfig(input.config);
  const localTarget = resolveSkillProposalTarget({
    workspaceDir: input.workspaceDir,
    skillName: name,
  });
  const target = input.targetAccess
    ? {
        skillKey: localTarget.skillKey,
        ...resolveExternalSkillTarget({
          access: input.targetAccess,
          skillKey: localTarget.skillKey,
        }),
      }
    : localTarget;
  const currentTargetContent = input.targetAccess
    ? await readExternalSkillFile(input.targetAccess, target.skillFile)
    : await readWorkspaceSkillFile(target.skillFile);
  if (currentTargetContent !== null) {
    throw new Error(`Skill already exists at ${target.skillFile}.`);
  }

  const now = new Date().toISOString();
  const prepared = prepareSkillProposalDraft({
    name: target.skillKey,
    description,
    content: input.content,
    date: now,
    maxSkillBytes: config.maxSkillBytes,
    supportFiles: input.supportFiles,
    secretScanMetadata: [{ file: "skill-name", content: name }],
    goal: input.goal,
    evidence: input.evidence,
  });
  if (!prepared.ok) {
    throw prepared.error.cause;
  }
  const {
    content: proposalContent,
    draftHash,
    evidence,
    goal,
    scan,
    supportFiles,
  } = prepared.value;
  const id = createSkillProposalId(name);
  const origin = normalizeProposalOrigin({
    ...input.origin,
    agentId: input.origin?.agentId ?? input.agentId,
  });
  const originRunProvenance = mergeProposalOriginRunProvenance(undefined, origin);
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id,
    kind: "create",
    status: "pending",
    title: `Create ${name}`,
    description,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? "skill-workshop",
    ...(input.autonomousCapture ? { autonomousCapture: true as const } : {}),
    ...(origin ? { origin } : {}),
    ...originRunProvenance,
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash,
    target: {
      skillName: name,
      skillKey: target.skillKey,
      skillDir: target.skillDir,
      skillFile: target.skillFile,
      source: input.targetAccess?.source ?? "openclaw-workspace",
      ...(input.targetAccess ? { binding: skillWorkshopTargetBinding(input.targetAccess) } : {}),
    },
    scan,
    ...(supportFiles.length > 0
      ? { supportFiles: await buildSupportFileMetadata(supportFiles) }
      : {}),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  const event = await writeSkillProposal({
    record,
    content: proposalContent,
    supportFiles,
    workspaceDir: input.workspaceDir,
    ownerAgentId: input.agentId,
    maxPending: config.maxPending,
    event: createSkillProposalEvent({
      record,
      type: "created",
      actor: input.eventActor,
    }),
    store: proposalStoreOptions(input.env),
  });
  if (event) {
    await dispatchSkillProposalChanged({
      event,
      record,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }
  return { record, revisionHash: hashSkillProposalRevision(record), content: proposalContent };
}

/** Summary of a workspace skill the workshop is allowed to write. */
type WritableWorkspaceSkillSummary = {
  name: string;
  description?: string;
  filePath: string;
};

/**
 * Lists the workspace skills the workshop can target with update proposals, using the same
 * status discovery as `proposeUpdateSkill` so callers that route corrections to existing
 * skills stay in lockstep with what an update can actually write.
 */
export function listWritableWorkspaceSkillSummaries(
  workspaceDir: string,
  opts?: { config?: OpenClawConfig; agentId?: string },
): WritableWorkspaceSkillSummary[] {
  const status = buildWorkspaceSkillStatus(workspaceDir, {
    config: opts?.config,
    agentId: opts?.agentId,
  });
  const summaries: WritableWorkspaceSkillSummary[] = [];
  for (const skill of status.skills) {
    if (!isWritableWorkspaceSkillSource(skill.source)) {
      continue;
    }
    summaries.push(
      skill.description
        ? { name: skill.skillKey, description: skill.description, filePath: skill.filePath }
        : { name: skill.skillKey, filePath: skill.filePath },
    );
  }
  return summaries;
}

export async function proposeUpdateSkill(
  input: SkillProposalUpdateInput & SkillWorkshopWorkspaceOptions,
): Promise<SkillProposalReadResult> {
  const skillName = normalizeRequired(input.skillName, "Skill name");
  const config = resolveSkillWorkshopConfig(input.config);
  const targetSkill = input.targetAccess
    ? resolveExternalSkill(input.targetAccess, await input.targetAccess.listSkills(), skillName)
    : resolveSkillStatusEntry(
        buildWorkspaceSkillStatus(input.workspaceDir, {
          config: input.config,
          agentId: input.agentId,
        }).skills,
        skillName,
      );
  if (!targetSkill) {
    throw new Error(`Skill not found: ${skillName}`);
  }
  if (!input.targetAccess) {
    assertWritableSkillTarget(input.workspaceDir, targetSkill as SkillStatusEntry);
  }
  const targetSkillFile = "filePath" in targetSkill ? targetSkill.filePath : targetSkill.skillFile;
  const targetSkillDir = "baseDir" in targetSkill ? targetSkill.baseDir : targetSkill.skillDir;
  const currentContent = input.targetAccess
    ? await readExternalSkillFile(input.targetAccess, targetSkillFile)
    : await readWorkspaceSkillFile(targetSkillFile);
  if (currentContent === null) {
    throw new Error(`Skill file is missing: ${targetSkillFile}`);
  }
  const currentDescription =
    targetSkill.description ?? parseFrontmatter(currentContent).description;
  const description = resolveUpdateProposalDescription(
    input.description,
    normalizeRequired(currentDescription ?? "", "Skill description"),
  );

  const now = new Date().toISOString();
  const prepared = prepareSkillProposalDraft({
    name: targetSkill.skillKey,
    description,
    content: input.content,
    fallbackFrontmatterContent: currentContent,
    date: now,
    maxSkillBytes: config.maxSkillBytes,
    supportFiles: input.supportFiles,
    goal: input.goal,
    evidence: input.evidence,
  });
  if (!prepared.ok) {
    throw prepared.error.cause;
  }
  const {
    content: proposalContent,
    draftHash,
    evidence,
    goal,
    scan,
    supportFiles,
  } = prepared.value;
  const id = createSkillProposalId(targetSkill.skillKey || targetSkill.name);
  const origin = normalizeProposalOrigin({
    ...input.origin,
    agentId: input.origin?.agentId ?? input.agentId,
  });
  const originRunProvenance = mergeProposalOriginRunProvenance(undefined, origin);
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id,
    kind: "update",
    status: "pending",
    title: `Update ${targetSkill.name}`,
    description,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy ?? "skill-workshop",
    ...(input.autonomousCapture ? { autonomousCapture: true as const } : {}),
    ...(origin ? { origin } : {}),
    ...originRunProvenance,
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash,
    target: {
      skillName: targetSkill.name,
      skillKey: targetSkill.skillKey,
      skillDir: targetSkillDir,
      skillFile: targetSkillFile,
      source: targetSkill.source,
      currentContentHash: hashSkillProposalContent(currentContent),
      ...(input.targetAccess ? { binding: skillWorkshopTargetBinding(input.targetAccess) } : {}),
    },
    scan,
    ...(supportFiles.length > 0
      ? {
          supportFiles: await buildSupportFileMetadata(
            supportFiles,
            targetSkillDir,
            input.targetAccess,
          ),
        }
      : {}),
    ...(goal ? { goal } : {}),
    ...(evidence ? { evidence } : {}),
  };
  const event = await writeSkillProposal({
    record,
    content: proposalContent,
    supportFiles,
    workspaceDir: input.workspaceDir,
    ownerAgentId: input.agentId ?? origin?.agentId,
    maxPending: config.maxPending,
    event: createSkillProposalEvent({
      record,
      type: "created",
      actor: input.eventActor,
    }),
    store: proposalStoreOptions(input.env),
  });
  if (event) {
    await dispatchSkillProposalChanged({
      event,
      record,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }
  return { record, revisionHash: hashSkillProposalRevision(record), content: proposalContent };
}

export async function reviseSkillProposal(
  input: SkillProposalReviseInput,
): Promise<SkillProposalReadResult> {
  if (
    input.content === undefined &&
    input.supportFiles === undefined &&
    input.description === undefined &&
    input.goal === undefined &&
    input.evidence === undefined
  ) {
    throw new Error("Skill proposal revision requires at least one changed field.");
  }
  const config = resolveSkillWorkshopConfig(input.config);
  const revision = withPendingSkillProposalMutation(input, "revised", async (read) => {
    const { record } = read;
    assertSkillWorkshopTargetAccess(record, input.targetAccess);
    if (!record.target.binding) {
      assertInsideWorkspace(input.workspaceDir, record.target.skillFile, "skill file");
      assertInsideWorkspace(input.workspaceDir, record.target.skillDir, "skill directory");
    }

    if (record.kind === "create") {
      const currentContent = input.targetAccess
        ? await readExternalSkillFile(input.targetAccess, record.target.skillFile)
        : await readWorkspaceSkillFile(record.target.skillFile);
      if (currentContent !== null) {
        await markSkillProposalStale({
          record,
          reason: "Target skill was created after proposal creation.",
          message: "Target skill was created after proposal creation; proposal marked stale.",
          input,
        });
      }
    } else {
      const currentContent = input.targetAccess
        ? await readExternalSkillFile(input.targetAccess, record.target.skillFile)
        : await readWorkspaceSkillFile(record.target.skillFile);
      if (currentContent === null) {
        throw new Error(`Target skill is missing: ${record.target.skillFile}`);
      }
      if (
        record.target.currentContentHash &&
        hashSkillProposalContent(currentContent) !== record.target.currentContentHash
      ) {
        await markSkillProposalStale({
          record,
          reason: "Target skill changed after proposal creation.",
          message: "Target skill changed after proposal creation; proposal marked stale.",
          input,
        });
      }
      await assertSupportTargetsUnchanged({
        record,
        targetAccess: input.targetAccess,
        assertUnchanged: async (file, supportContent) =>
          await assertSkillProposalSupportTargetUnchanged({
            record,
            file,
            currentContent: supportContent,
            input,
          }),
      });
    }

    const supportFiles =
      input.supportFiles === undefined
        ? await readProposalSupportFiles(record, proposalStoreOptions(input.env))
        : input.supportFiles;
    const requestedContent = input.content ?? read.content;
    const nextVersion = nextProposalVersion(record.proposedVersion);
    const description = normalizeOptionalString(input.description) ?? record.description;
    const now = new Date().toISOString();
    const prepared = prepareSkillProposalDraft({
      name: record.target.skillKey,
      description,
      content: requestedContent,
      fallbackFrontmatterContent: read.content,
      version: nextVersion,
      date: now,
      maxSkillBytes: config.maxSkillBytes,
      supportFiles,
      goal: input.goal === undefined ? record.goal : input.goal,
      evidence: input.evidence === undefined ? record.evidence : input.evidence,
    });
    if (!prepared.ok) {
      throw prepared.error.cause;
    }
    const {
      content: proposalContent,
      draftHash,
      evidence,
      goal,
      scan,
      supportFiles: preparedSupportFiles,
    } = prepared.value;
    const supportFileMetadata =
      preparedSupportFiles.length > 0
        ? await buildSupportFileMetadata(
            preparedSupportFiles,
            record.kind === "update" ? record.target.skillDir : undefined,
            input.targetAccess,
          )
        : [];
    const origin = normalizeProposalOrigin(input.origin);
    const originRunProvenance = mergeProposalOriginRunProvenance(record, origin);
    const previousSupportFiles = record.supportFiles;
    const revised: SkillProposalRecord = {
      ...record,
      description,
      updatedAt: now,
      proposedVersion: nextVersion,
      draftHash,
      scan,
      ...(origin ? { origin } : {}),
      ...originRunProvenance,
    };
    delete revised.evaluation;
    if (preparedSupportFiles.length > 0) {
      revised.supportFiles = supportFileMetadata;
    } else {
      delete revised.supportFiles;
    }
    if (goal) {
      revised.goal = goal;
    } else {
      delete revised.goal;
    }
    if (evidence) {
      revised.evidence = evidence;
    } else {
      delete revised.evidence;
    }
    const event = await replaceSkillProposalDraft({
      record: revised,
      previousSupportFiles,
      content: proposalContent,
      supportFiles: preparedSupportFiles,
      event: createSkillProposalEvent({
        record: revised,
        type: "revised",
        actor: input.eventActor,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        occurredAt: now,
      }),
      store: proposalStoreOptions(input.env),
    });
    return {
      read: {
        record: revised,
        revisionHash: hashSkillProposalRevision(revised),
        content: proposalContent,
      },
      event,
    };
  });
  const revisedResult = await withSkillProposalLifecycleDispatch(input, revision);
  if (revisedResult.event) {
    await dispatchSkillProposalChanged({
      event: revisedResult.event,
      record: revisedResult.read.record,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }
  return revisedResult.read;
}

export async function rejectSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  return await markProposal(input, "rejected");
}

export async function quarantineSkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalRecord> {
  const result = await withPendingSkillProposalMutation(input, "quarantined", async (read) => {
    const now = new Date().toISOString();
    const record: SkillProposalRecord = {
      ...read.record,
      status: "quarantined",
      updatedAt: now,
      quarantinedAt: now,
      statusReason: normalizeOptionalString(input.reason),
      scan: {
        ...read.record.scan,
        state: "quarantined",
      },
    };
    const event = await updateSkillProposalRecord({
      record,
      event: createSkillProposalEvent({
        record,
        type: "quarantined",
        actor: input.eventActor,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        occurredAt: now,
      }),
      store: proposalStoreOptions(input.env),
    });
    return { record, event };
  });
  if (result.event) {
    await dispatchSkillProposalChanged({
      event: result.event,
      record: result.record,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }
  return result.record;
}

export async function applySkillProposal(
  input: SkillProposalActionInput,
): Promise<SkillProposalApplyResult> {
  return await applySkillProposalTransition(input, APPLY_TRANSITION_DEPENDENCIES);
}

async function markProposal(
  input: SkillProposalActionInput,
  status: "rejected",
): Promise<SkillProposalRecord> {
  const result = await withPendingSkillProposalMutation(input, status, async (read) => {
    const now = new Date().toISOString();
    const record: SkillProposalRecord = {
      ...read.record,
      status,
      updatedAt: now,
      rejectedAt: now,
      statusReason: normalizeOptionalString(input.reason),
    };
    const event = await updateSkillProposalRecord({
      record,
      event: createSkillProposalEvent({
        record,
        type: status,
        actor: input.eventActor,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        occurredAt: now,
      }),
      store: proposalStoreOptions(input.env),
    });
    return { record, event };
  });
  if (result.event) {
    await dispatchSkillProposalChanged({
      event: result.event,
      record: result.record,
      workspaceDir: input.workspaceDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    });
  }
  return result.record;
}

async function withPendingSkillProposalMutation<T>(
  input: Pick<
    SkillProposalActionInput,
    | "agentId"
    | "config"
    | "env"
    | "eventActor"
    | "expectedRevisionHash"
    | "proposalId"
    | "workspaceDir"
  >,
  action: "applied" | "quarantined" | "rejected" | "revised",
  fn: (read: SkillProposalReadResult) => Promise<T>,
): Promise<T> {
  const recoveryReadOptions = input.config ? { config: input.config } : undefined;
  const lockedReadOptions = {
    ...(input.config ? { config: input.config } : {}),
    reconcile: false,
  };
  const initial = await readRequiredProposal(
    input.proposalId,
    input.workspaceDir,
    input.env,
    input.agentId,
    recoveryReadOptions,
  );
  return await withSkillProposalTargetLock(
    initial.record,
    async () => {
      const read = await readRequiredProposal(
        input.proposalId,
        input.workspaceDir,
        input.env,
        input.agentId,
        lockedReadOptions,
      );
      if (read.record.status !== "pending") {
        throw new Error(
          `Only pending proposals can be ${action}. Current status: ${read.record.status}.`,
        );
      }
      assertExpectedRevisionHash(read.revisionHash, input.expectedRevisionHash);
      if (hashSkillProposalContent(read.content) !== read.record.draftHash) {
        throw new Error("Proposal draft changed without updating proposal metadata.");
      }
      return await fn(read);
    },
    proposalStoreOptions(input.env),
  );
}
