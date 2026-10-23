import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type KnoxProgressState =
  | "running"
  | "completed"
  | "failed"
  | "pending"
  | "cancelled"
  | "not-started"
  | "unknown"
  | "background"
  | "approved"
  | "denied"
  | "unavailable"
  | "resolved";
export type KnoxProgressCall = { name: string; detail?: string; state: KnoxProgressState };

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Keep whole emoji/combining sequences, including the ellipsis, inside the item budget. */
export function boundKnoxProgressLine(value: string, limit = 50): string {
  const line = redactSensitiveText(value)
    .replace(/[\r\n\t\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const parts = [...segmenter.segment(line)].map(({ segment }) => segment);
  return parts.length > limit ? `${parts.slice(0, limit - 1).join("")}…` : line;
}

function field(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key];
    }
  }
  return undefined;
}

/** Use invocation facts only; never infer task purposes or forward command output. */
export function describeKnoxProgressCall(
  data: Record<string, unknown>,
  previous?: KnoxProgressCall,
): KnoxProgressCall {
  const args = isRecord(data.args) ? data.args : {};
  let detail = field(args, "command", "cmd");
  if (!detail) {
    const path = field(args, "path", "file_path", "filePath");
    detail = path?.replace(/\\/gu, "/").split("/").findLast(Boolean);
  }
  const action = field(args, "action");
  const url = field(args, "url", "targetUrl");
  let host: string | undefined;
  if (url) {
    try {
      host = new URL(url).hostname;
    } catch {
      /* Invalid URLs are not display evidence. */
    }
  }
  detail ??= [action, host].filter(Boolean).join(" ") || undefined;
  // Raw command URLs must not expose credentials, query parameters, or fragments either.
  detail = detail?.replace(/https?:\/\/[^\s"'`]+/giu, (value) => {
    try {
      return new URL(value).hostname;
    } catch {
      return "[url]";
    }
  });
  return {
    name: boundKnoxProgressLine(field(data, "name") ?? previous?.name ?? "Tool"),
    detail: detail ? boundKnoxProgressLine(detail) : previous?.detail,
    state: previous?.state ?? "running",
  };
}

export function terminalKnoxProgressState(data: Record<string, unknown>): KnoxProgressState {
  const result = isRecord(data.result) ? data.result : {};
  const details = isRecord(result.details) ? result.details : {};
  const status = details.status ?? result.status ?? data.status;
  const reason = details.reason ?? result.reason;
  const exitCode = details.exitCode ?? result.exitCode;
  // A failed RPC can leave execution unknown; transport failure is not proof
  // that the command ran and failed, or that it never started.
  if (reason === "outcome-unknown" || status === "unknown") {
    return "unknown";
  }
  if (reason === "not-dispatched") {
    return "not-started";
  }
  if (status === "approval-pending") {
    return "pending";
  }
  if (status === "approval-unavailable") {
    return "unavailable";
  }
  if (["cancelled", "canceled", "aborted"].includes(String(status))) {
    return "cancelled";
  }
  if (
    data.isError === true ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    ["failed", "error", "blocked", "declined"].includes(String(status))
  ) {
    return "failed";
  }
  if (
    (details.async === true && status === "started") ||
    status === "running" ||
    status === "inProgress"
  ) {
    return "background";
  }
  return "completed";
}

export function formatKnoxProgressCall(call: KnoxProgressCall, suffix = ""): string {
  const labels: Record<KnoxProgressState, string> = {
    running: "⏳",
    completed: "✓",
    failed: "✗",
    pending: "? Awaiting approval",
    cancelled: "– Cancelled",
    "not-started": "– Not started",
    unknown: "? Unknown",
    background: "↗ Background started",
    approved: "✓ Approved",
    denied: "– Denied",
    unavailable: "? Approval unavailable",
    resolved: "? Approval ended",
  };
  const base = `${labels[call.state]} ${call.name}${call.detail ? ` · ${call.detail}` : ""}`;
  return `${boundKnoxProgressLine(base, 50 - [...segmenter.segment(suffix)].length)}${suffix}`;
}
