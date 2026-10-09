// Control UI shared Gateway error helpers.
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  readMissingScopeError,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGatewayErrorDetailCode } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { redactToolDetail } from "./browser-redact.ts";
import { truncateText } from "./format.ts";

const DIAGNOSTIC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function formatGatewayDiagnosticId(
  value: unknown,
  kind: "request" | "operation" | "run",
): string | null {
  return typeof value === "string" && DIAGNOSTIC_ID_PATTERN.test(value)
    ? t(`gatewayErrors.${kind}Id`, { id: value })
    : null;
}

/** Public RPC diagnostics are allowlisted; arbitrary Gateway details may contain private state. */
export function formatGatewayRequestFailure(error: unknown): {
  message: string;
  outcomeUnknown: boolean;
} {
  const record = asRecord(error);
  const details = asRecord(record?.details);
  const publicMessage =
    typeof record?.message === "string" && record.message.trim()
      ? record.message.trim()
      : typeof error === "string" && error.trim()
        ? error.trim()
        : t("gatewayErrors.requestFailed");
  const lines = [truncateText(redactToolDetail(publicMessage), 2_000).text];
  const code = record?.gatewayCode ?? record?.code;
  if (Object.values(ErrorCodes).some((value) => value === code)) {
    lines.push(t("gatewayErrors.code", { code: String(code) }));
  }
  for (const kind of ["request", "operation"] as const) {
    const diagnostic = formatGatewayDiagnosticId(details?.[`${kind}Id`], kind);
    if (diagnostic) {
      lines.push(diagnostic);
    }
  }
  const stage = details?.stage;
  if (stage === "preflight" || stage === "runtime" || stage === "terminal-persist") {
    lines.push(t("gatewayErrors.stage", { stage }));
  }
  const outcomeUnknown = details?.requestDisposition === "outcome-unknown";
  if (outcomeUnknown) {
    lines.push(t("gatewayErrors.outcomeUnknown"));
  } else if (details?.requestDisposition === "rejected-before-dispatch") {
    lines.push(t("gatewayErrors.requestNotStarted"));
  }
  return { message: lines.join("\n\n"), outcomeUnknown };
}

/** Identifies an expired process-local wizard session without parsing public copy. */
export function isWizardNotFoundError(err: unknown): boolean {
  const error = asRecord(err);
  if (!error) {
    return false;
  }
  const code =
    typeof error.gatewayCode === "string"
      ? error.gatewayCode
      : typeof error.code === "string"
        ? error.code
        : null;
  return (
    code === ErrorCodes.INVALID_REQUEST &&
    asRecord(error.details)?.code === GatewayErrorDetailCodes.WIZARD_NOT_FOUND
  );
}

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  // Structural check, not instanceof: under isolate:false a custom element
  // registered by an earlier test file keeps its own module registry, so class
  // identity diverges while the error shape (name + details) stays stable.
  if (!(err instanceof Error) || err.name !== "GatewayRequestError") {
    return false;
  }
  if (readMissingScopeError(err)?.missingScope === "operator.read") {
    return true;
  }
  const detailCode = resolveGatewayErrorDetailCode(err as { details?: unknown });
  // Older gateways sometimes reused the connect-time authorization detail for RPC failures.
  return detailCode === ConnectErrorDetailCodes.AUTH_UNAUTHORIZED;
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}
