// ACP Core module implements error text behavior.
import { type AcpRuntimeErrorCode, AcpRuntimeError, toAcpRuntimeError } from "./errors.js";

export type AcpRuntimeErrorTextContext = {
  recoveryTarget?: "bound-conversation" | "session-key";
};

function resolveAcpRuntimeErrorNextStep(
  error: AcpRuntimeError,
  context?: AcpRuntimeErrorTextContext,
): string | undefined {
  if (error.code === "ACP_BACKEND_MISSING" || error.code === "ACP_BACKEND_UNAVAILABLE") {
    return "Run `/acp doctor`, install/enable the backend plugin, then retry.";
  }
  if (error.code === "ACP_DISPATCH_DISABLED") {
    return "Enable `acp.dispatch.enabled=true` to allow thread-message ACP turns.";
  }
  if (error.code === "ACP_SESSION_INIT_FAILED") {
    return context?.recoveryTarget === "bound-conversation"
      ? "If this session is stale, recreate it with `/acp spawn` and rebind this conversation."
      : "If this session is stale, recreate it and retry using the new session key.";
  }
  if (error.code === "ACP_INVALID_RUNTIME_OPTION") {
    return "Use `/acp status` to inspect options and pass valid values.";
  }
  if (error.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") {
    return "This backend does not support that control; use a supported command.";
  }
  if (error.code === "ACP_TURN_FAILED") {
    return "Retry, or use `/acp cancel` and send the message again.";
  }
  return undefined;
}

/** Formats ACP runtime errors with the operator next-step hint attached when known. */
export function formatAcpRuntimeErrorText(
  error: AcpRuntimeError,
  context?: AcpRuntimeErrorTextContext,
): string {
  const next = resolveAcpRuntimeErrorNextStep(error, context);
  if (!next) {
    return `ACP error (${error.code}): ${error.message}`;
  }
  return `ACP error (${error.code}): ${error.message}\nnext: ${next}`;
}

/** Normalizes unknown failures into ACP runtime error text for user-facing surfaces. */
export function toAcpRuntimeErrorText(params: {
  error: unknown;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): string {
  return formatAcpRuntimeErrorText(
    toAcpRuntimeError({
      error: params.error,
      fallbackCode: params.fallbackCode,
      fallbackMessage: params.fallbackMessage,
    }),
  );
}
