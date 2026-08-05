import { describe, expect, it, vi } from "vitest";
import {
  BrowserGatewayInteractiveOwnership,
  type BrowserInteractiveAccess,
} from "./browser-gateway-interactive-ownership.js";

function access(agentId: string): BrowserInteractiveAccess {
  return {
    agentId,
    resolveAgentIdFromSessionKey: (key) => /^agent:([^:]+):/.exec(key)?.[1] ?? null,
  };
}

function createController() {
  const request = vi.fn();
  const controller = new BrowserGatewayInteractiveOwnership({ request }, (code, message): never => {
    throw Object.assign(new Error(message), { code });
  });
  return { controller, request };
}

const question = (agentId: string, id = `question-${agentId}`) => ({
  id,
  agentId,
  sessionKey: `agent:${agentId}:main`,
  questions: [],
  createdAtMs: 1,
  expiresAtMs: 2,
  status: "pending",
});

const suggestion = (agentId: string, id = `task-${agentId}`) => ({
  id,
  agentId,
  sessionKey: `agent:${agentId}:main`,
  title: "Next",
  prompt: "Continue",
  tldr: "Continue work",
  cwd: "/srv/workspace",
  createdAt: 1,
});

const approval = (agentId: string, id = `approval-${agentId}`) => ({
  id,
  status: "pending",
  urlPath: `/approval/${id}`,
  createdAtMs: 1,
  expiresAtMs: 2,
  presentation: {
    kind: "exec",
    agentId,
    commandText: "pnpm test",
    allowedDecisions: ["allow-once", "deny"],
  },
});

describe("BrowserGatewayInteractiveOwnership", () => {
  it("projects question recovery and binds id-only terminal events", async () => {
    const { controller, request } = createController();
    request.mockResolvedValueOnce({ questions: [question("alice"), question("bob")] });

    await expect(controller.request(access("alice"), "question.list", {})).resolves.toEqual({
      handled: true,
      result: { questions: [question("alice")] },
    });
    expect(
      controller.filterEvent(access("alice"), {
        event: "question.resolved",
        payload: { id: "question-alice", status: "answered", answers: { answers: {} } },
      }),
    ).not.toBeNull();
    expect(
      controller.filterEvent(access("bob"), {
        event: "question.resolved",
        payload: { id: "question-alice", status: "cancelled" },
      }),
    ).toBeNull();
  });

  it("preflights question resolution from authoritative question.get", async () => {
    const { controller, request } = createController();
    request
      .mockResolvedValueOnce({ question: question("alice") })
      .mockResolvedValueOnce({ status: "answered", answers: { answers: { choice: ["yes"] } } });

    await controller.request(access("alice"), "question.resolve", {
      id: "question-alice",
      answers: { answers: { choice: ["yes"] } },
      resolvedBy: "spoofed",
    });
    expect(request).toHaveBeenNthCalledWith(1, "question.get", { id: "question-alice" });
    expect(request).toHaveBeenNthCalledWith(2, "question.resolve", {
      id: "question-alice",
      answers: { answers: { choice: ["yes"] } },
    });
  });

  it("denies resolving a foreign question", async () => {
    const { controller, request } = createController();
    request.mockResolvedValueOnce({ question: question("bob") });

    await expect(
      controller.request(access("alice"), "question.resolve", {
        id: "question-bob",
        cancel: true,
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("projects task suggestions and gates id-only mutations", async () => {
    const { controller, request } = createController();
    request
      .mockResolvedValueOnce({ suggestions: [suggestion("alice"), suggestion("bob")] })
      .mockResolvedValueOnce({ taskId: "task-alice", key: "agent:alice:task" });

    await expect(controller.request(access("alice"), "taskSuggestions.list", {})).resolves.toEqual({
      handled: true,
      result: { suggestions: [suggestion("alice")] },
    });
    await expect(
      controller.request(access("alice"), "taskSuggestions.accept", { taskId: "task-alice" }),
    ).resolves.toMatchObject({ handled: true });
    expect(request).toHaveBeenLastCalledWith("taskSuggestions.accept", { taskId: "task-alice" });
  });

  it("routes task terminal events only after an owned create or list", () => {
    const { controller } = createController();
    expect(
      controller.filterEvent(access("alice"), {
        event: "task.suggestion",
        payload: { action: "created", suggestion: suggestion("alice") },
      }),
    ).not.toBeNull();
    expect(
      controller.filterEvent(access("alice"), {
        event: "task.suggestion",
        payload: { action: "resolved", taskId: "task-alice", resolution: "dismissed" },
      }),
    ).not.toBeNull();
    expect(
      controller.filterEvent(access("bob"), {
        event: "task.suggestion",
        payload: { action: "resolved", taskId: "task-alice", resolution: "dismissed" },
      }),
    ).toBeNull();
  });

  it("binds approval replay and permits only its exact kind and decisions", async () => {
    const { controller, request } = createController();
    const replay = {
      sessionKey: "agent:alice:main",
      updatedAtMs: 1,
      approvals: [approval("alice"), approval("bob")],
      truncated: false,
    };
    expect(controller.projectApprovalReplay(access("alice"), replay)).toEqual({
      ...replay,
      approvals: [approval("alice")],
    });
    request.mockResolvedValueOnce({ approval: approval("alice") });
    await expect(
      controller.request(access("alice"), "approval.get", { id: "approval-alice" }),
    ).resolves.toEqual({ handled: true, result: { approval: approval("alice") } });
    request.mockResolvedValueOnce({ applied: true, approval: { status: "allowed" } });
    await controller.request(access("alice"), "approval.resolve", {
      id: "approval-alice",
      kind: "exec",
      decision: "allow-once",
    });
    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: "approval-alice",
      kind: "exec",
      decision: "allow-once",
    });
    await expect(
      controller.request(access("alice"), "approval.resolve", {
        id: "approval-alice",
        kind: "exec",
        decision: "allow-always",
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
  });

  it("routes live session approvals by session and presentation owner", () => {
    const { controller } = createController();
    const event = {
      event: "session.approval",
      payload: {
        sessionKey: "agent:alice:main",
        updatedAtMs: 1,
        phase: "pending",
        approval: approval("alice"),
      },
    };
    expect(controller.filterEvent(access("alice"), event)).toEqual(event);
    expect(controller.filterEvent(access("bob"), event)).toBeNull();
  });
});
