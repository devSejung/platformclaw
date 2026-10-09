import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";

/** Live compaction reasons cross into operator UI even when log redaction is disabled. */
export function formatCompactionFailureReason(error: unknown): string {
  return (
    truncateUtf16Safe(
      sanitizeTerminalText(redactToolPayloadText(formatErrorMessage(error))).trim(),
      512,
    ) || "Compaction failed"
  );
}
