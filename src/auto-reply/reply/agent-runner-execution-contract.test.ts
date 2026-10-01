import { describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { resolveAgentRunAdmissionId } from "../../infra/agent-run-registry.js";
import {
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

describe("executeAgentTurn contract", () => {
  it("registers the queued admission before entering the model runtime", async () => {
    const params = createMinimalRunAgentTurnParams();
    params.sessionKey = "agent:team:issue";
    params.followupRun.run.agentId = "team";
    params.followupRun.run.admissionRunId = "admitted-request";
    params.opts = { ...params.opts, runId: "queued-execution" };
    state.runEmbeddedAgentMock.mockImplementation(async () => {
      expect(
        resolveAgentRunAdmissionId({
          runId: "queued-execution",
          agentId: "team",
          sessionKey: params.sessionKey,
        }),
      ).toBe("admitted-request");
      return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
    });
    await executeAgentTurn(params);
    expect(state.runEmbeddedAgentMock).toHaveBeenCalled();
  });

  it("returns one closed settled result with winner and fallback facts", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 1,
        agentMeta: { provider: "anthropic", model: "claude-sonnet" },
      },
    });

    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result).toMatchObject({
      runId: expect.any(String),
      outcome: {
        kind: "settled",
        status: "ok",
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        result: { payloads: [{ text: "done" }] },
      },
    });
  });

  it("retains a late completed result for accounting after user abort was accepted", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "late reply" }],
      meta: { durationMs: 1 },
    });
    const { replyOperation } = createMockReplyOperation();
    let operationResult: typeof replyOperation.result = null;
    const lateAbortedOperation = {
      ...replyOperation,
      get result() {
        return operationResult;
      },
      freezeAbort: () => {
        operationResult = { kind: "aborted", code: "aborted_by_user" };
      },
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: lateAbortedOperation }),
    );

    expect(result.outcome).toMatchObject({
      kind: "settled",
      abortReason: "user",
      result: { payloads: [{ text: "late reply" }] },
    });
  });

  it("releases an unsettled operation when a restart error aborts execution", async () => {
    const { replyOperation } = createMockReplyOperation();
    const complete = vi.fn();
    const unsettledOperation = {
      ...replyOperation,
      complete,
      freezeAbort: () => {
        throw createAgentRunRestartAbortError();
      },
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: unsettledOperation }),
    );

    expect(result.outcome).toEqual({ kind: "aborted", reason: "restart" });
    expect(complete).toHaveBeenCalledOnce();
  });
});
