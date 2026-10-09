import {
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from "@openclaw/gateway-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import { reportBrowserGatewayRequestFailure } from "./browser-gateway-errors.js";
import { ControlPlaneAuthorizationError } from "./contracts.js";

const context = { method: "sessions.compact", elapsedMs: 30_042 };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

describe("browser Gateway error diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves public Gateway errors and joins browser and operator diagnostics", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const operationId = "f0f9a8bf-c7a7-46df-af0e-5bca8f268fd1";
    const error = reportBrowserGatewayRequestFailure(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "Compaction could not persist its terminal state",
        details: { reason: "transcript-rebuild", operationId, stage: "terminal-persist" },
        retryable: true,
        retryAfterMs: 250,
      }),
      context,
    );
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Compaction could not persist its terminal state",
      retryable: true,
      retryAfterMs: 250,
      details: { operationId, stage: "terminal-persist", requestId: expect.stringMatching(uuid) },
    });
    expect(log).toHaveBeenCalledWith(
      "PlatformClaw browser Gateway request failed",
      expect.objectContaining({
        requestId: (error.details as { requestId: string }).requestId,
        operationId,
        stage: "terminal-persist",
        errorKind: "gateway-rejection",
        method: "sessions.compact",
        elapsedMs: 30_042,
      }),
    );
  });

  it.each([true, false])(
    "records dispatch uncertainty for a timed out request: sent=%s",
    (sent) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const error = reportBrowserGatewayRequestFailure(
        new GatewayClientRequestTimeoutError({
          method: context.method,
          timeoutMs: 30_000,
          requestSent: sent,
        }),
        context,
      );
      expect(error).toMatchObject({
        code: "UNAVAILABLE",
        retryable: !sent,
        details: {
          errorKind: "timeout",
          timeoutMs: 30_000,
          requestDisposition: sent ? "outcome-unknown" : "rejected-before-dispatch",
        },
      });
      expect(error.message).toContain(sent ? "may still be running" : "before it was sent");
    },
  );

  it("keeps authorization visible without claiming a post-dispatch ACL denial prevented execution", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = reportBrowserGatewayRequestFailure(
      new ControlPlaneAuthorizationError("private resource id"),
      context,
    );
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      details: { errorKind: "authorization", requestDisposition: "outcome-unknown" },
    });
    expect(error.message).not.toContain("private resource id");
    const rejected = reportBrowserGatewayRequestFailure(
      new BrowserGatewayProxyError(
        "cross-agent-denied",
        "Request is outside this browser binding",
        "rejected-before-dispatch",
      ),
      context,
    );
    expect(rejected).toMatchObject({
      code: "FORBIDDEN",
      details: { requestDisposition: "rejected-before-dispatch" },
    });
  });

  it("logs bounded cause codes and source locations while withholding private exception text", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "private-user-token";
    const cause = Object.assign(new Error(secret), { code: "ECONNREFUSED" });
    const failure = Object.assign(new Error(`Authorization: Bearer ${secret}`, { cause }), {
      code: secret,
    });
    failure.stack = `Error: ${secret}\n    at connect (C:\\private\\user-data\\runtime.ts:42:7)\n    at process (/private/work/server.js:10:2)`;
    const error = reportBrowserGatewayRequestFailure(failure, {
      ...context,
      method: `sessions.compact\n${secret}`,
    });
    expect(error).toMatchObject({
      details: {
        errorKind: "internal",
        requestDisposition: "outcome-unknown",
        method: "invalid-method",
      },
    });
    expect(error.retryable).not.toBe(true);
    expect(log).toHaveBeenCalledWith(
      "PlatformClaw browser Gateway request failed",
      expect.objectContaining({
        causeCodes: ["ECONNREFUSED"],
        sourceLocations: ["runtime.ts:42:7", "server.js:10:2"],
      }),
    );
    const serialized = JSON.stringify({ error, logs: log.mock.calls });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("user-data");
    expect(serialized).not.toContain("/private/work");
  });
});
