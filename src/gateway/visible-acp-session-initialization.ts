import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpSessionRuntimeOptions, SessionEntry } from "../config/sessions/types.js";

/** Internal durable owner marker for the never-admitted visible ACP creation fence. */
export const VISIBLE_ACP_INITIALIZATION_OWNER = "visible-acp" as const;

export type VisibleAcpPendingSessionEntry = SessionEntry & {
  initializationOwner?: typeof VISIBLE_ACP_INITIALIZATION_OWNER;
};

/**
 * Signals that trusted initialization failed and its exact runtime cleanup could
 * not be confirmed. The lifecycle owner must preserve the pending row rather
 * than deleting the durable recovery anchor underneath the still-live handle.
 */
export class VisibleAcpInitializationCleanupError extends Error {
  readonly initializationError: unknown;
  readonly cleanupError: unknown;

  constructor(initializationError: unknown, cleanupError: unknown) {
    super("visible ACP initialization failed and exact runtime/sidecar retirement also failed");
    this.name = "VisibleAcpInitializationCleanupError";
    this.initializationError = initializationError;
    this.cleanupError = cleanupError;
  }
}

/** True only for the core-owned visible ACP pending lifecycle. */
export function isVisibleAcpPendingSessionEntry(
  entry: SessionEntry | undefined,
): entry is VisibleAcpPendingSessionEntry & {
  initializationPending: true;
  initializationOwner: typeof VISIBLE_ACP_INITIALIZATION_OWNER;
} {
  const candidate = entry as VisibleAcpPendingSessionEntry | undefined;
  return (
    candidate?.initializationPending === true &&
    candidate.initializationOwner === VISIBLE_ACP_INITIALIZATION_OWNER
  );
}

/**
 * Trusted, non-wire intent for creating one persistent dashboard ACP session.
 * This value is carried only by in-process creation provenance or the signed
 * agent-runtime identity fallback; public sessions.create params never expose it.
 */
export type TrustedVisibleAcpInitialization = {
  logicalAgentId: string;
  runtimeAgentId: string;
  executionOwnerAgentId?: string;
  runtimeOptions?: Partial<AcpSessionRuntimeOptions>;
  modelExplicit?: boolean;
  cwd?: string;
  cwdExplicit?: boolean;
};

function decodeRuntimeOptions(
  value: unknown,
): Partial<AcpSessionRuntimeOptions> | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const model = normalizeOptionalString(value.model);
  const thinking = normalizeOptionalString(value.thinking);
  const timeoutSeconds = value.timeoutSeconds;
  if (
    (value.model !== undefined && !model) ||
    (value.thinking !== undefined && !thinking) ||
    (timeoutSeconds !== undefined &&
      (typeof timeoutSeconds !== "number" ||
        !Number.isFinite(timeoutSeconds) ||
        timeoutSeconds < 0))
  ) {
    return null;
  }
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(typeof timeoutSeconds === "number" ? { timeoutSeconds } : {}),
  };
}

/** Strictly decode the signed/internal ACP initialization payload. */
export function decodeTrustedVisibleAcpInitialization(
  value: unknown,
): TrustedVisibleAcpInitialization | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const logicalAgentId = normalizeOptionalString(value.logicalAgentId);
  const runtimeAgentId = normalizeOptionalString(value.runtimeAgentId);
  const executionOwnerAgentId = normalizeOptionalString(value.executionOwnerAgentId);
  const cwd = normalizeOptionalString(value.cwd);
  const runtimeOptions = decodeRuntimeOptions(value.runtimeOptions);
  if (
    !logicalAgentId ||
    !runtimeAgentId ||
    (value.executionOwnerAgentId !== undefined && !executionOwnerAgentId) ||
    (value.cwd !== undefined && !cwd) ||
    runtimeOptions === null ||
    (value.modelExplicit !== undefined && typeof value.modelExplicit !== "boolean") ||
    (value.cwdExplicit !== undefined && typeof value.cwdExplicit !== "boolean")
  ) {
    return undefined;
  }
  return {
    logicalAgentId,
    runtimeAgentId,
    ...(executionOwnerAgentId ? { executionOwnerAgentId } : {}),
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(typeof value.modelExplicit === "boolean" ? { modelExplicit: value.modelExplicit } : {}),
    ...(cwd ? { cwd } : {}),
    ...(typeof value.cwdExplicit === "boolean" ? { cwdExplicit: value.cwdExplicit } : {}),
  };
}
