import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sha256HexPrefix } from "./crypto-digest.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticHttpStatusCode,
  diagnosticProviderRequestIdHash,
} from "./diagnostic-error-metadata.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import { extractErrorCode, formatErrorMessage, formatUncaughtError } from "./errors.js";

const failureLog = createSubsystemLogger("agent/failure");
const MAX_FAILURE_DETAIL_CHARS = 4_000;
const SUPPORT_REPORT_DETAIL_KEYS = [
  "reason",
  "stopReason",
  "executionPhase",
  "toolCount",
  "replaySafe",
  "hadPotentialSideEffects",
  "replayPrevented",
  "reasoningRetries",
  "emptyRetries",
  "missingAssistantRetries",
  "compactions",
  "fallbackExhausted",
  "fallbackAttemptCount",
] as const;

function safeFailureDetail(value: string, limit = MAX_FAILURE_DETAIL_CHARS): string {
  const redacted = redactToolPayloadText(value);
  return redacted.length > limit ? `${truncateUtf16Safe(redacted, limit)}…` : redacted;
}

function failureReferenceId(runId: string): string {
  // Client-supplied run ids must not inject text or credentials into support copy.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId) && safeFailureDetail(runId) === runId
    ? runId
    : `run-${sha256HexPrefix(runId, 16)}`;
}

function supportReportIdentifier(value: string | undefined): string | undefined {
  return value &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u.test(value) &&
    !value.includes("://") &&
    safeFailureDetail(value) === value
    ? value
    : undefined;
}

export function buildAgentRunFailureReference(runId: string): string {
  return `Reference: ${failureReferenceId(runId)}`;
}

/** Records final failure evidence independently of optional profiling or verbose output. */
export function recordAgentRunFailure(input: {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  phase?: string;
  error: unknown;
  details?: Record<string, unknown>;
}): string {
  const details: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(input.details ?? {}).slice(0, 16)) {
    if (typeof value === "string") {
      details[key] = safeFailureDetail(value, 512);
    } else if (
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      details[key] = value;
    }
  }
  const reference = failureReferenceId(input.runId);
  const errors = collectNestedErrorCandidates(input.error).slice(0, 4);
  const errorCode = errors.map(extractErrorCode).find((code) => code !== undefined);
  const causes = errors.slice(1).map((error) => {
    const code = extractErrorCode(error);
    const syscall =
      error && typeof error === "object" && "syscall" in error ? error.syscall : undefined;
    return {
      errorCode: code ? safeFailureDetail(code, 128) : undefined,
      syscall: typeof syscall === "string" ? safeFailureDetail(syscall, 128) : undefined,
      error: safeFailureDetail(formatErrorMessage(error), 1_000),
      stack: safeFailureDetail(formatUncaughtError(error), 1_000),
    };
  });
  const evidence = {
    ...details,
    reference,
    runId: safeFailureDetail(input.runId, 128),
    sessionId: input.sessionId ? safeFailureDetail(input.sessionId, 128) : undefined,
    sessionKey: input.sessionKey ? safeFailureDetail(input.sessionKey, 256) : undefined,
    provider: input.provider ? safeFailureDetail(input.provider, 128) : undefined,
    model: input.model ? safeFailureDetail(input.model, 256) : undefined,
    phase: input.phase ? safeFailureDetail(input.phase, 128) : undefined,
    errorCategory: diagnosticErrorCategory(input.error),
    failureKind: diagnosticErrorFailureKind(input.error),
    errorCode: errorCode ? safeFailureDetail(errorCode, 128) : undefined,
    httpStatus: diagnosticHttpStatusCode(input.error),
    providerRequestIdHash: diagnosticProviderRequestIdHash(input.error),
    error: safeFailureDetail(formatErrorMessage(input.error)),
    stack: safeFailureDetail(formatUncaughtError(input.error)),
    ...(causes.length > 0 ? { causes } : {}),
  };
  const message = `Agent run failed: ${reference}`;
  // Compact console logging omits metadata. Docker stderr must still carry the
  // same redacted evidence, otherwise copied operator logs lose the diagnosis.
  failureLog.error(message, {
    ...evidence,
    consoleMessage: `${message} ${JSON.stringify(evidence)}`,
  });
  // The copy report crosses into employee chat. Free-form errors, stacks,
  // session identities, paths, and arbitrary detail strings stay in operator logs.
  const report = [
    "Agent failure report",
    `Timestamp: ${new Date().toISOString()}`,
    `Reference: ${reference}`,
    `Category: ${diagnosticErrorCategory(input.error)}`,
  ];
  const failureKind = diagnosticErrorFailureKind(input.error);
  const httpStatus = errors.map(diagnosticHttpStatusCode).find((status) => status !== undefined);
  if (failureKind) {
    report.push(`Failure kind: ${failureKind}`);
  }
  if (httpStatus) {
    // Failover errors also carry synthesized HTTP-like statuses (for example 408
    // for a closed transport); do not imply an HTTP response was received.
    report.push(`Status: ${httpStatus}`);
  }
  for (const [label, value] of [
    ["Phase", input.phase],
    ["Provider", input.provider],
    ["Model", input.model],
  ]) {
    const safe = supportReportIdentifier(value);
    if (safe) {
      report.push(`${label}: ${safe}`);
    }
  }
  const codes = [
    ...new Set(errors.map(extractErrorCode).map(supportReportIdentifier).filter(Boolean)),
  ];
  if (codes.length > 0) {
    report.push(`Codes: ${codes.join(", ")}`);
  }
  for (const key of SUPPORT_REPORT_DETAIL_KEYS) {
    const value = details[key];
    if (typeof value === "boolean" || typeof value === "number") {
      report.push(`${key}: ${value}`);
    } else if (typeof value === "string") {
      const safe = supportReportIdentifier(value);
      if (safe) {
        report.push(`${key}: ${safe}`);
      }
    }
  }
  return truncateUtf16Safe(report.join("\n"), 4_096);
}
