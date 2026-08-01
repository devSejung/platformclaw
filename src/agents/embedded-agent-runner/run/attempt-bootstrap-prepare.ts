import path from "node:path";
import { isEmbeddedMode } from "../../../infra/embedded-mode.js";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import {
  buildBootstrapContextForFiles,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "../../bootstrap-files.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import {
  isPrimaryBootstrapRun,
  resolveWorkspaceBootstrapRouting,
} from "../../bootstrap-routing.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapPromptTruncationWarningMode,
  resolveBootstrapTotalMaxChars,
} from "../../embedded-agent-helpers.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../../workspace-bootstrap-read.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  isWorkspaceBootstrapPending,
  type WorkspaceBootstrapFile,
} from "../../workspace.js";
import { log } from "../logger.js";
import { remapInjectedContextFilesToWorkspace } from "./attempt.bootstrap-context.js";
import { resolveAttemptBootstrapContext } from "./attempt.context-engine-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function loadProjectAgentsFile(params: {
  sandbox?: SandboxContext | null;
  logicalWorkspaceDir: string;
}): Promise<WorkspaceBootstrapFile | undefined> {
  const sandbox = params.sandbox;
  if (sandbox?.backend?.capabilities?.separateAgentWorkspace !== true) {
    return undefined;
  }
  const bridge = sandbox.fsBridge;
  if (!bridge) {
    throw new Error("Project instruction filesystem bridge is unavailable.");
  }
  const remotePath = path.posix.join(sandbox.containerWorkdir, DEFAULT_AGENTS_FILENAME);
  const logicalPath = path.join(params.logicalWorkspaceDir, DEFAULT_AGENTS_FILENAME);
  const stat = await bridge.stat({ filePath: remotePath });
  if (!stat) {
    return { name: DEFAULT_AGENTS_FILENAME, path: logicalPath, missing: true };
  }
  if (stat.type !== "file") {
    throw new Error("Project AGENTS.md is not a regular file.");
  }
  const content = await bridge.readFile({
    filePath: remotePath,
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  return {
    name: DEFAULT_AGENTS_FILENAME,
    path: logicalPath,
    content: content.toString("utf8"),
    missing: false,
  };
}

export async function prepareEmbeddedAttemptBootstrap(params: {
  attempt: EmbeddedRunAttemptParams;
  effectiveWorkspace: string;
  hasBootstrapFileAccess: boolean;
  hasMemoryReadTools: boolean;
  isRawModelRun: boolean;
  markStage: (name: string) => void;
  resolvedWorkspace: string;
  sessionAgentId: string;
  sessionLabel: string;
  sandbox?: SandboxContext | null;
}) {
  const { attempt } = params;
  const suppressAmbientContext =
    params.isRawModelRun || attempt.operation === "settled-tool-finalization";
  const contextInjectionMode = resolveContextInjectionMode(attempt.config, params.sessionAgentId);
  const bootstrapWarn = makeBootstrapWarn({
    sessionLabel: params.sessionLabel,
    workspaceDir: params.resolvedWorkspace,
    warn: (message) => log.warn(message),
  });
  const projectAgentsFile = await loadProjectAgentsFile({
    sandbox: params.sandbox,
    logicalWorkspaceDir: params.resolvedWorkspace,
  });
  const resolveFilesForAttempt = async () => {
    const files = await resolveBootstrapFilesForRun({
      workspaceDir: params.resolvedWorkspace,
      config: attempt.config,
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      agentId: params.sessionAgentId,
      warn: bootstrapWarn,
      contextMode: attempt.bootstrapContextMode,
      runKind: attempt.bootstrapContextRunKind,
      projectAgentsFile,
    });
    return params.sandbox?.backend?.capabilities?.separateAgentWorkspace === true &&
      params.hasMemoryReadTools
      ? files.filter((file) => file.name !== DEFAULT_MEMORY_FILENAME)
      : files;
  };
  let completedBootstrapTurn: boolean | undefined;
  const hasCompletedBootstrapTurnForAttempt = async () => {
    completedBootstrapTurn ??= await hasCompletedBootstrapTurn(attempt.sessionTarget);
    return completedBootstrapTurn;
  };
  const resolveBootstrapRouting = (bootstrapFiles?: readonly WorkspaceBootstrapFile[]) =>
    resolveWorkspaceBootstrapRouting({
      isWorkspaceBootstrapPending,
      bootstrapFiles,
      bootstrapContextRunKind: attempt.bootstrapContextRunKind,
      trigger: attempt.trigger,
      sessionKey: attempt.sessionKey,
      isPrimaryRun: isPrimaryBootstrapRun(attempt.sessionKey),
      isCanonicalWorkspace: attempt.isCanonicalWorkspace,
      effectiveWorkspace: params.effectiveWorkspace,
      resolvedWorkspace: params.resolvedWorkspace,
      hasBootstrapFileAccess: params.hasBootstrapFileAccess,
      bootstrapFilesProvideAccess: false,
    });
  const shouldProbeContinuationSkip =
    !suppressAmbientContext &&
    contextInjectionMode === "continuation-skip" &&
    !isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind) &&
    (await hasCompletedBootstrapTurnForAttempt());
  let preloadedBootstrapFiles: WorkspaceBootstrapFile[] | undefined;
  let bootstrapRouting =
    shouldProbeContinuationSkip || suppressAmbientContext || contextInjectionMode === "never"
      ? await resolveBootstrapRouting()
      : undefined;
  if (
    !suppressAmbientContext &&
    contextInjectionMode !== "never" &&
    (bootstrapRouting === undefined || bootstrapRouting.bootstrapMode === "full")
  ) {
    preloadedBootstrapFiles = await resolveFilesForAttempt();
    bootstrapRouting = await resolveBootstrapRouting(preloadedBootstrapFiles);
  }
  bootstrapRouting ??= await resolveBootstrapRouting(preloadedBootstrapFiles);
  const bootstrapMode = bootstrapRouting.bootstrapMode;
  const {
    bootstrapFiles: hookAdjustedBootstrapFiles,
    contextFiles: resolvedContextFiles,
    shouldRecordCompletedBootstrapTurn,
  } = await resolveAttemptBootstrapContext({
    // Raw probes and isolated finalization must not load AGENTS/BOOTSTRAP
    // context even though finalization preserves the settled transcript.
    contextInjectionMode: suppressAmbientContext ? "never" : contextInjectionMode,
    bootstrapContextMode: attempt.bootstrapContextMode,
    bootstrapContextRunKind: attempt.bootstrapContextRunKind ?? "default",
    bootstrapMode,
    hasCompletedBootstrapTurn: hasCompletedBootstrapTurnForAttempt,
    resolveBootstrapContextForRun: async () => {
      const bootstrapFiles = preloadedBootstrapFiles ?? (await resolveFilesForAttempt());
      return {
        bootstrapFiles,
        contextFiles: buildBootstrapContextForFiles(bootstrapFiles, {
          config: attempt.config,
          agentId: params.sessionAgentId,
          warn: bootstrapWarn,
        }),
      };
    },
  });
  params.markStage("bootstrap-context");
  const remappedContextFiles = remapInjectedContextFilesToWorkspace({
    files: resolvedContextFiles,
    sourceWorkspaceDir: params.resolvedWorkspace,
    targetWorkspaceDir: params.effectiveWorkspace,
  });
  const contextFiles = bootstrapRouting.includeBootstrapInSystemContext
    ? remappedContextFiles
    : remappedContextFiles.filter((file) => !/(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path.trim()));
  const bootstrapFilesForInjectionStats = bootstrapRouting.includeBootstrapInSystemContext
    ? hookAdjustedBootstrapFiles
    : hookAdjustedBootstrapFiles.filter((file) => file.name !== DEFAULT_BOOTSTRAP_FILENAME);
  const bootstrapMaxChars = resolveBootstrapMaxChars(attempt.config, params.sessionAgentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(
    attempt.config,
    params.sessionAgentId,
  );
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles: bootstrapFilesForInjectionStats,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode = resolveBootstrapPromptTruncationWarningMode(attempt.config);
  const bootstrapPromptWarning = buildBootstrapPromptWarning({
    analysis: bootstrapAnalysis,
    mode: bootstrapPromptWarningMode,
    seenSignatures: attempt.bootstrapPromptWarningSignaturesSeen,
    previousSignature: attempt.bootstrapPromptWarningSignature,
  });
  const workspaceNotes: string[] = [];
  if (
    hookAdjustedBootstrapFiles.some(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.missing,
    )
  ) {
    workspaceNotes.push("Reminder: commit your changes in this workspace after edits.");
  }
  if (isEmbeddedMode()) {
    workspaceNotes.push(
      "Running in local embedded mode (no gateway). Most tools work locally. Gateway-dependent tools (canvas, nodes, cron, message, sessions_send, sessions_spawn, gateway) are unavailable. Subagent kill/steer require a gateway. Do not attempt to read gateway-specific files such as sessions.json, gateway.log, or gateway.pid.",
    );
  }
  if (params.sandbox?.backend?.capabilities?.separateAgentWorkspace === true) {
    workspaceNotes.push(
      "Agent profile and bootstrap files are outside the active project. Use agent_workspace_read/write/edit for SOUL.md, IDENTITY.md, USER.md, or BOOTSTRAP.md, and bootstrap_complete instead of deleting BOOTSTRAP.md or running host control-plane CLI commands. General file tools remain scoped to the active project. If an optional bootstrap action has no dedicated tool, skip that optional action; never emulate it in the project shell.",
    );
  }

  return {
    bootstrapAnalysis,
    bootstrapMaxChars,
    bootstrapMode,
    bootstrapPromptWarning,
    bootstrapPromptWarningMode,
    bootstrapTotalMaxChars,
    contextFiles,
    hookAdjustedBootstrapFiles,
    shouldRecordCompletedBootstrapTurn,
    workspaceNotes,
  };
}
