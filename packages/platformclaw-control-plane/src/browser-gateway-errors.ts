import { randomUUID } from "node:crypto";
import {
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from "@openclaw/gateway-client";
import type { ErrorShape } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError } from "./contracts.js";

function proxyErrorShape(error: unknown): ErrorShape {
  // These responses already crossed the private Gateway's public error boundary.
  if (error instanceof GatewayClientRequestError) {
    return {
      code: error.gatewayCode,
      message: error.message,
      details: {
        ...(isRecord(error.details)
          ? error.details
          : error.details === undefined
            ? {}
            : { gatewayDetails: error.details }),
        errorKind: "gateway-rejection",
      },
      ...(error.retryable ? { retryable: true } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  if (error instanceof GatewayClientRequestTimeoutError) {
    return {
      code: "UNAVAILABLE",
      message: error.requestSent
        ? "Gateway response timed out. The operation may still be running; check its status before retrying."
        : "Gateway request timed out before it was sent. Try again after the connection recovers.",
      retryable: !error.requestSent,
      details: {
        errorKind: "timeout",
        timeoutMs: error.timeoutMs,
        requestDisposition: error.requestSent ? "outcome-unknown" : "rejected-before-dispatch",
      },
    };
  }
  if (error instanceof ControlPlaneAuthorizationError) {
    return {
      code: "FORBIDDEN",
      message:
        "Access to this operation is denied. Check your current session and Space permissions.",
      // ACLs are checked both before dispatch and after the operation completes.
      // This exception alone cannot prove that the mutation never ran.
      details: { errorKind: "authorization", requestDisposition: "outcome-unknown" },
    };
  }
  if (error instanceof BrowserGatewayProxyError) {
    const code =
      error.code === "unauthenticated"
        ? "UNAUTHENTICATED"
        : error.code === "agent-unavailable"
          ? "UNAVAILABLE"
          : error.code === "invalid-params"
            ? "INVALID_REQUEST"
            : "FORBIDDEN";
    return {
      code,
      message: error.message,
      ...(error.code === "agent-unavailable" ? { retryable: true } : {}),
      details: {
        errorKind: "proxy-rejection",
        ...(error.requestDisposition ? { requestDisposition: error.requestDisposition } : {}),
      },
    };
  }
  return {
    code: "UNAVAILABLE",
    message:
      "Control Plane could not complete this Gateway request. Check the request ID in the control logs and the operation status before retrying.",
    details: { errorKind: "internal", requestDisposition: "outcome-unknown" },
  };
}

/** Correlates a safe browser error with its operator log without exposing raw exceptions. */
export function reportBrowserGatewayRequestFailure(
  error: unknown,
  context: { method: string; elapsedMs: number },
): ErrorShape {
  const shape = proxyErrorShape(error);
  const requestId = randomUUID();
  const method = /^[a-zA-Z0-9_.-]{1,96}$/u.test(context.method) ? context.method : "invalid-method";
  const details = {
    ...(isRecord(shape.details)
      ? shape.details
      : shape.details === undefined
        ? {}
        : { gatewayDetails: shape.details }),
    requestId,
    method,
  };
  // Stack messages and absolute paths may carry credentials or user data. Only
  // bounded source locations cross this diagnostic boundary; never log params.
  const sourceLocations =
    error instanceof Error && error.stack
      ? error.stack
          .split(/\r?\n/u)
          .slice(1)
          .flatMap((line) => {
            const match = line.match(/(?:[/\\])([\w.-]+\.[cm]?[jt]s):(\d+):(\d+)/u);
            return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
          })
          .slice(0, 6)
      : [];
  const causeCodes: string[] = [];
  let cause = error;
  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    const code: unknown = "code" in cause ? cause.code : undefined;
    if (
      typeof code === "string" &&
      /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENOENT|EACCES|EPERM|SQLITE_(?:BUSY|LOCKED|ERROR|CORRUPT|READONLY|FULL))$/u.test(
        code,
      )
    ) {
      causeCodes.push(code);
    }
    cause = cause.cause;
  }
  console.error("PlatformClaw browser Gateway request failed", {
    requestId,
    method,
    code: shape.code,
    ...("errorKind" in details ? { errorKind: details.errorKind } : {}),
    ...("requestDisposition" in details ? { requestDisposition: details.requestDisposition } : {}),
    ...("operationId" in details &&
    typeof details.operationId === "string" &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(details.operationId)
      ? { operationId: details.operationId }
      : {}),
    ...("stage" in details &&
    typeof details.stage === "string" &&
    ["preflight", "runtime", "terminal-persist"].includes(details.stage)
      ? { stage: details.stage }
      : {}),
    elapsedMs: Math.max(0, Math.round(context.elapsedMs)),
    causeCodes,
    sourceLocations,
  });
  return { ...shape, details };
}
