// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  formatGatewayRequestFailure,
  isMissingOperatorReadScopeError,
  isWizardNotFoundError,
} from "./gateway-errors.ts";

function gatewayRequestError(params: { code: string; message: string; details?: unknown }): Error {
  return Object.assign(new Error(params.message), {
    name: "GatewayRequestError",
    code: params.code,
    gatewayCode: params.code,
    details: params.details,
  });
}

describe("gateway error helpers", () => {
  it("formats allowlisted RPC diagnostics and the unknown-outcome recovery path", () => {
    const requestId = "84bff23c-5e53-41a6-ae02-b0d8c0d82586";
    const operationId = "5d551778-c8b7-4d98-b8dc-82dbcc224842";
    const failure = formatGatewayRequestFailure(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "The Gateway did not confirm the request in time.",
        details: {
          requestId,
          operationId,
          method: "sessions.compact",
          errorKind: "timeout",
          requestDisposition: "outcome-unknown",
          stage: "runtime",
          privateSession: "/private/employee/transcript",
          token: "sk-private-token-that-must-not-be-rendered",
        },
      }),
    );
    expect(failure).toEqual({
      outcomeUnknown: true,
      message: [
        "The Gateway did not confirm the request in time.",
        t("gatewayErrors.code", { code: "UNAVAILABLE" }),
        t("gatewayErrors.requestId", { id: requestId }),
        t("gatewayErrors.operationId", { id: operationId }),
        t("gatewayErrors.stage", { stage: "runtime" }),
        t("gatewayErrors.outcomeUnknown"),
      ].join("\n\n"),
    });
  });

  it("accepts structural RPC errors and distinguishes a request rejected before dispatch", () => {
    const failure = formatGatewayRequestFailure({
      gatewayCode: "FORBIDDEN",
      message: "This action is not allowed for your account.",
      details: { requestDisposition: "rejected-before-dispatch" },
    });
    expect(failure).toEqual({
      outcomeUnknown: false,
      message: [
        "This action is not allowed for your account.",
        t("gatewayErrors.code", { code: "FORBIDDEN" }),
        t("gatewayErrors.requestNotStarted"),
      ].join("\n\n"),
    });
  });

  it("rejects unrecognized diagnostic values instead of rendering arbitrary details", () => {
    expect(
      formatGatewayRequestFailure({
        code: "private-value",
        message: "Request failed",
        details: {
          requestId: "private-value",
          operationId: { path: "/private/path" },
          stage: "private-value",
          requestDisposition: "private-value",
        },
      }),
    ).toEqual({ message: "Request failed", outcomeUnknown: false });
    expect(formatGatewayRequestFailure({ details: { secret: "private-value" } })).toEqual({
      message: t("gatewayErrors.requestFailed"),
      outcomeUnknown: false,
    });
  });

  it("keeps ordinary errors readable and bounds/redacts public diagnostics", () => {
    expect(formatGatewayRequestFailure(new Error("Session access changed"))).toEqual({
      message: "Session access changed",
      outcomeUnknown: false,
    });
    const secret = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
    const failure = formatGatewayRequestFailure(new Error(`token=${secret} ${"x".repeat(3_000)}`));
    expect(failure.message).not.toContain(secret);
    expect(failure.message.length).toBeLessThanOrEqual(2_001);
    expect(failure.outcomeUnknown).toBe(false);
  });

  it("classifies structured missing-wizard errors", () => {
    expect(
      isWizardNotFoundError(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "localized or changed public copy",
          details: { code: "WIZARD_NOT_FOUND" },
        }),
      ),
    ).toBe(true);
    expect(
      isWizardNotFoundError({
        gatewayCode: "INVALID_REQUEST",
        details: { code: "WIZARD_NOT_FOUND" },
      }),
    ).toBe(true);
  });

  it("rejects unrelated errors and malformed missing-wizard details", () => {
    expect(
      isWizardNotFoundError({
        gatewayCode: "UNAVAILABLE",
        details: { code: "WIZARD_NOT_FOUND" },
      }),
    ).toBe(false);
    expect(
      isWizardNotFoundError({
        gatewayCode: "INVALID_REQUEST",
        details: { code: "UNKNOWN_AGENT_ID" },
      }),
    ).toBe(false);
    expect(
      isWizardNotFoundError({ gatewayCode: "INVALID_REQUEST", message: "wizard not found" }),
    ).toBe(false);
    for (const details of [null, "WIZARD_NOT_FOUND", [], { code: 42 }]) {
      expect(isWizardNotFoundError({ gatewayCode: "INVALID_REQUEST", details })).toBe(false);
    }
  });

  it("classifies structured read-scope failures without message parsing", () => {
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "FORBIDDEN",
          message: "permission denied",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.read",
            requiredScopes: ["operator.read"],
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps compatibility with legacy scope messages and detail codes", () => {
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "INVALID_REQUEST",
          message: "missing scope: operator.read",
        }),
      ),
    ).toBe(true);
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "INVALID_REQUEST",
          message: "unauthorized",
          details: { code: "AUTH_UNAUTHORIZED" },
        }),
      ),
    ).toBe(true);
  });

  it("does not confuse another missing scope with operator.read", () => {
    expect(
      isMissingOperatorReadScopeError(
        gatewayRequestError({
          code: "FORBIDDEN",
          message: "missing scope: operator.questions",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.questions",
            requiredScopes: ["operator.questions"],
          },
        }),
      ),
    ).toBe(false);
  });
});
