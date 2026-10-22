import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import {
  abortEmbeddedAgentRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

describe("request-scoped reply input isolation", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticSessionStateForTest();
  });

  it.each(["embedded", "reply"] as const)(
    "protects request-scoped %s input at the final queue boundary while allowing stop",
    async (kind) => {
      const sessionId = "request-scoped-session";
      const queueMessage = vi.fn(async () => {});
      const abort = vi.fn();
      const operation = createReplyOperation({
        sessionKey: "agent:main:private-request",
        sessionId,
        resetTriggered: false,
        replyRouteScope: "request",
      });
      operation.setPhase("running");
      operation.attachBackend({
        kind: "embedded",
        isStreaming: () => true,
        cancel: abort,
        queueMessage,
      });
      if (kind === "embedded") {
        setActiveEmbeddedRun(sessionId, {
          queueMessage,
          isStreaming: () => true,
          isCompacting: () => false,
          abort,
        });
      }

      expect(
        await queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "independent web question", {
          isInboundUserMessage: true,
        }),
      ).toMatchObject({ queued: false, reason: "request_scoped_reply" });
      expect(queueMessage).not.toHaveBeenCalled();
      expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
      expect(abort).toHaveBeenCalledOnce();
    },
  );
});
