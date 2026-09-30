import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactIdentifier } from "../logging/redact-identifier.js";
import { getDefaultRedactPatterns, redactSensitiveText } from "../logging/redact.js";
import { extractLeadingHttpStatus, parseApiErrorInfo } from "../shared/assistant-error-format.js";

export const DTGPT_PROVIDER_ID = "dtgpt";
export const DTGPT_SUPPORT_MESSAGE = "DT팀 API에 현재 이상현상이 있다. seungon.jung 에게 문의해라.";

export type DtgptFailureDiagnostic = {
  httpCode?: string;
  errorType?: string;
  messagePreview?: string;
  rawPreview?: string;
  rawHash?: string;
  requestIdHash?: string;
};

export function isDtgptProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === DTGPT_PROVIDER_ID;
}

function sanitizeDiagnosticText(value: string | undefined, maxChars: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const redacted = redactSensitiveText(trimmed, {
    mode: "tools",
    patterns: getDefaultRedactPatterns(),
  }).trim();
  if (!redacted) {
    return undefined;
  }
  return redacted.length > maxChars ? `${truncateUtf16Safe(redacted, maxChars)}…` : redacted;
}

function stringifyDiagnosticField(value: string | undefined): string | undefined {
  return sanitizeDiagnosticText(value, 160)?.replace(/\s+/g, " ");
}

export function formatRetryDelayKo(waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  if (seconds < 60) {
    return `약 ${seconds}초`;
  }
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `약 ${minutes}분`;
}

export function formatDtgptProviderFailureMessage(params: {
  provider?: string;
  model?: string;
  reason?: string;
  rawError?: string;
  errorCode?: string;
  errorType?: string;
  diagnostic?: DtgptFailureDiagnostic;
  retryAfterMs?: number;
}): string | undefined {
  if (!isDtgptProvider(params.provider)) {
    return undefined;
  }

  const rawError = params.rawError?.trim();
  const parsed = rawError ? parseApiErrorInfo(rawError) : undefined;
  const leadingStatus = rawError ? extractLeadingHttpStatus(rawError) : undefined;
  const httpCode =
    params.diagnostic?.httpCode ?? parsed?.httpCode ?? leadingStatus?.code?.toString();
  const errorType =
    params.diagnostic?.errorType ?? parsed?.type ?? stringifyDiagnosticField(params.errorType);
  const errorCode = stringifyDiagnosticField(params.errorCode);
  const model = stringifyDiagnosticField(params.model);
  const reason = stringifyDiagnosticField(params.reason);
  const requestIdHash =
    params.diagnostic?.requestIdHash ??
    (parsed?.requestId ? redactIdentifier(parsed.requestId, { len: 12 }) : undefined);
  const rawHash =
    params.diagnostic?.rawHash ?? (rawError ? redactIdentifier(rawError, { len: 12 }) : undefined);
  const detail = sanitizeDiagnosticText(
    params.diagnostic?.messagePreview ??
      parsed?.message ??
      params.diagnostic?.rawPreview ??
      leadingStatus?.rest ??
      rawError,
    600,
  );

  const fields = [
    `provider=${DTGPT_PROVIDER_ID}`,
    model ? `model=${model}` : undefined,
    reason ? `reason=${reason}` : undefined,
    httpCode ? `status=${httpCode}` : undefined,
    errorType ? `type=${stringifyDiagnosticField(errorType)}` : undefined,
    errorCode ? `code=${errorCode}` : undefined,
    requestIdHash ? `requestIdHash=${requestIdHash}` : undefined,
    rawHash ? `errorHash=${rawHash}` : undefined,
  ].filter((value): value is string => Boolean(value));

  const lines = [
    DTGPT_SUPPORT_MESSAGE,
    `진단: ${fields.join(" ")}`,
    `오류: ${detail ?? "상세 오류 정보 없음"}`,
  ];
  if (typeof params.retryAfterMs === "number" && Number.isFinite(params.retryAfterMs)) {
    lines.push(`재시도: ${formatRetryDelayKo(params.retryAfterMs)} 후 가능.`);
  }
  return lines.join("\n");
}
