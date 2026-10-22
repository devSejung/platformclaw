import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentRunFailureReference,
  recordAgentRunFailure,
} from "../../infra/agent-run-failure-diagnostics.js";
import { buildControlUiAgentFailureText } from "./agent-runner-failure-copy.js";

const { failureLog } = vi.hoisted(() => ({ failureLog: vi.fn() }));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ error: failureLog }),
}));
vi.mock("../../logging/config.js", () => ({
  readLoggingConfig: () => ({ redactSensitive: "off" }),
}));

beforeEach(() => failureLog.mockClear());

describe("web chat failure presentation", () => {
  it.each([
    Object.assign(new Error("write EPIPE | EPIPE"), { code: "EPIPE" }),
    new Error("transport failed", {
      cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    }),
  ])("explains an interrupted connection without exposing its implementation", (error) => {
    const text = buildControlUiAgentFailureText(error, "run-pipe-failure");
    expect(text).toContain("connection to the response service was interrupted");
    expect(text).toContain("Reference: run-pipe-failure");
    expect(text).not.toMatch(/EPIPE|transport failed|terminal|openclaw logs/u);
  });

  it("keeps unknown errors private and warns before repeating actions", () => {
    const text = buildControlUiAgentFailureText(
      new Error("private implementation details"),
      "run-actions",
      {
        replayPrevented: true,
      },
    );
    expect(text).toContain("response service encountered a problem");
    expect(text).toContain("Check their results before trying again");
    expect(text).not.toContain("private implementation details");
    expect(text).not.toContain("Please try again in a moment");
  });

  it("describes a known response timeout separately from a connection failure", () => {
    const text = buildControlUiAgentFailureText(
      Object.assign(new Error("private timeout details"), { code: "ETIMEDOUT" }),
      "run-timeout",
    );
    expect(text).toContain("response service took too long");
    expect(text).not.toContain("connection");
  });

  it("records bounded redacted transport evidence with the employee's reference", () => {
    const secret = "sk-secret1234567890SECRET1234567890secret";
    const cause = Object.assign(new Error(`write EPIPE; Authorization: Bearer ${secret}`), {
      code: "EPIPE",
      syscall: "write",
    });
    const error = Object.assign(new Error(`transport failed ${"x".repeat(6_000)}`, { cause }), {
      code: "WRAPPED_TRANSPORT_ERROR",
    });
    const report = recordAgentRunFailure({
      runId: "run-pipe-failure",
      sessionId: "session-test",
      provider: "test-provider",
      model: "test-model",
      phase: "before-reply",
      error,
      details: {
        executionPhase: "model_call_started",
        replayPrevented: true,
        deferredLifecycleError: `https://private.example.test/ Authorization: Bearer ${secret}`,
      },
    });
    const [message, metadata] = failureLog.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("run-pipe-failure");
    expect(metadata).toMatchObject({
      reference: "run-pipe-failure",
      runId: "run-pipe-failure",
      sessionId: "session-test",
      provider: "test-provider",
      model: "test-model",
      phase: "before-reply",
      executionPhase: "model_call_started",
      errorCode: "WRAPPED_TRANSPORT_ERROR",
      causes: [expect.objectContaining({ errorCode: "EPIPE", syscall: "write" })],
    });
    const encoded = JSON.stringify(metadata);
    expect(encoded).toContain("write EPIPE");
    expect(metadata.consoleMessage).toContain("run-pipe-failure");
    expect(metadata.consoleMessage).toContain("EPIPE");
    expect(metadata.consoleMessage).toContain("model_call_started");
    expect(encoded).not.toContain(secret);
    expect(String(metadata.error).length).toBeLessThanOrEqual(4_001);
    expect(String(metadata.stack).length).toBeLessThanOrEqual(4_001);
    expect(report).toContain("Reference: run-pipe-failure");
    expect(report).toContain("Codes: WRAPPED_TRANSPORT_ERROR, EPIPE");
    expect(report).toContain("executionPhase: model_call_started");
    expect(report).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T/u);
    expect(report).not.toMatch(
      /transport failed|session-test|private\.example|Authorization|Caused by/u,
    );
    expect(report).not.toContain(secret);
    expect(report.length).toBeLessThanOrEqual(4_096);
    expect(buildControlUiAgentFailureText(error, "run-pipe-failure")).toContain(
      buildAgentRunFailureReference("run-pipe-failure"),
    );
  });

  it("includes safe HTTP and transport classifications from nested errors", () => {
    const report = recordAgentRunFailure({
      runId: "run-http-timeout",
      error: new Error("request failed", {
        cause: Object.assign(new Error("private timeout details"), {
          code: "ETIMEDOUT",
          status: 504,
        }),
      }),
    });
    expect(report).toContain("Failure kind: timeout");
    expect(report).toContain("Status: 504");
    expect(report).not.toContain("private timeout details");
  });

  it("does not let malformed client run ids inject text into references", () => {
    const runId = "untrusted\nprivate details";
    const reference = buildAgentRunFailureReference(runId);
    expect(reference).toMatch(/^Reference: run-[a-f0-9]{16}$/u);
    recordAgentRunFailure({ runId, error: new Error("failure") });
    expect(failureLog.mock.calls[0]?.[0]).toBe(`Agent run failed: ${reference.slice(11)}`);
  });
});
