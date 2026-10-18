import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { setDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { registerPendingAgentQuestion } from "../harness/gateway-question.js";
import { queueEmbeddedAgentMessageWithOutcomeAsync, setActiveEmbeddedRun } from "./runs.js";
import { testing } from "./runs.test-support.js";

describe("bound question answer queue ownership", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticSessionStateForTest();
    setDiagnosticsEnabledForProcess(false);
    vi.restoreAllMocks();
  });
  it.each(["duplicate", "replacement", "externally-resolved"] as const)(
    "never injects a bound answer into provider work after %s",
    async (scenario) => {
      const sessionKey = `agent:main:question-${scenario}`;
      const questions = [
        {
          id: "action",
          header: "Action",
          question: "Continue?",
          options: [{ label: "Continue" }, { label: "Cancel" }],
        },
      ];
      const gatewayCall = vi.fn(async () => ({
        status: "answered",
        answers: { answers: { action: ["Continue"] } },
      }));
      const reservation = registerPendingAgentQuestion({
        sessionKey,
        questionId: "Q1",
        questions,
        gatewayCall,
        answer: new Promise(() => {}),
      });
      let replacement: ReturnType<typeof registerPendingAgentQuestion> | undefined;
      const queueMessage = vi.fn(async () => {});
      setActiveEmbeddedRun(
        "bound-session",
        { queueMessage, isStreaming: () => true, isCompacting: () => false, abort: () => {} },
        sessionKey,
      );
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "1" },
        target: () => undefined,
      });
      const persist = vi.spyOn(recorder, "persistApproved").mockResolvedValue(undefined);
      const options = {
        questionAnswerBinding: { sessionKey, questionId: "Q1" },
        userTurnTranscriptRecorder: recorder,
      };
      try {
        if (scenario !== "externally-resolved") {
          expect(
            await queueEmbeddedAgentMessageWithOutcomeAsync("bound-session", "1", options),
          ).toMatchObject({ queued: true, target: "embedded_run" });
        }
        reservation.dispose();
        if (scenario === "replacement") {
          replacement = registerPendingAgentQuestion({
            sessionKey,
            questionId: "Q2",
            questions,
            gatewayCall,
            answer: new Promise(() => {}),
          });
        }
        expect(
          await queueEmbeddedAgentMessageWithOutcomeAsync("bound-session", "1", options),
        ).toMatchObject({ queued: false, reason: "question_unavailable" });
        expect(queueMessage).not.toHaveBeenCalled();
        expect(persist).toHaveBeenCalledTimes(scenario === "externally-resolved" ? 0 : 1);
        expect(gatewayCall).toHaveBeenCalledTimes(scenario === "externally-resolved" ? 0 : 1);
      } finally {
        reservation.dispose();
        replacement?.dispose();
      }
    },
  );
});
