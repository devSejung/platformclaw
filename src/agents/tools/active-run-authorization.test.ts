import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  retainQueuedAgentRunContext,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  resolveActiveAgentRunAuthorization,
  type ActiveAgentRunAuthorization,
} from "../../infra/agent-tool-invocation.js";
import type { AnyAgentTool } from "./common.js";
import {
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./gateway-caller-context.js";

const context = {
  runId: "runtime-run",
  agentId: "personal-alice",
  sessionKey: "agent:personal-alice:space-session:issue",
};

function startRun(runId = context.runId) {
  registerAgentRunContext(runId, {
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    admissionRunId: "ingress-request",
  });
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: 1 } });
}

async function duringTool(
  run: () => void | Promise<void>,
  abortSignal = new AbortController().signal,
  toolSignal?: AbortSignal,
) {
  const tool: AnyAgentTool = {
    name: "authorization-probe",
    label: "Authorization probe",
    description: "Test real host tool invocation",
    parameters: Type.Object({}),
    async execute() {
      await run();
      return { content: [], details: {} };
    },
  };
  await wrapToolWithGatewayCallerIdentity(tool, { ...context, abortSignal }).execute!(
    "call",
    {},
    toolSignal,
  );
}

describe("active tool run authorization", () => {
  beforeEach(() => resetAgentEventsForTest());
  afterEach(() => resetAgentEventsForTest());

  it("requires actual tool execution and seals its current verified ingress identity", async () => {
    startRun();
    expect(resolveActiveAgentRunAuthorization(context)).toBeUndefined();
    await withGatewayToolCallerIdentity(context, () => {
      expect(resolveActiveAgentRunAuthorization(context)).toBeUndefined();
    });
    let authorization: ActiveAgentRunAuthorization | undefined;
    await duringTool(() => {
      authorization = resolveActiveAgentRunAuthorization(context);
      expect(authorization).toMatchObject({
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        runtimeRunId: context.runId,
        admissionRunId: "ingress-request",
      });
      expect(authorization?.isActive()).toBe(true);
    });
    expect(authorization?.isActive()).toBe(false);
  });

  it("rejects queued registrations, even with a lifecycle start, until lane admission", async () => {
    startRun();
    const release = retainQueuedAgentRunContext(context.runId, getAgentRunLifecycleGeneration())!;
    try {
      await duringTool(() => expect(resolveActiveAgentRunAuthorization(context)).toBeUndefined());
      release("admitted");
      await duringTool(() =>
        expect(resolveActiveAgentRunAuthorization(context)?.isActive()).toBe(true),
      );
    } finally {
      release("abandoned");
    }
  });

  it.each(["agent", "session", "run"] as const)("rejects a mismatched %s owner", async (field) => {
    startRun();
    startRun("other-known-active-run");
    const requested = {
      ...context,
      ...(field === "agent" ? { agentId: "personal-bob" } : {}),
      ...(field === "session" ? { sessionKey: "agent:personal-alice:other" } : {}),
      ...(field === "run" ? { runId: "other-known-active-run" } : {}),
    };
    await duringTool(() => expect(resolveActiveAgentRunAuthorization(requested)).toBeUndefined());
  });

  it.each(["abort", "end", "error", "restart", "clear", "recycle"] as const)(
    "retires a previously sealed handle on %s before the tool resolves",
    async (reason) => {
      const claimId = claimAgentRunContext(
        context.runId,
        {
          agentId: context.agentId,
          sessionKey: context.sessionKey,
        },
        { trackOwner: true, ownsContext: true },
      );
      emitAgentEvent({
        runId: context.runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1 },
      });
      const abort = new AbortController();
      await duringTool(() => {
        const authorization = resolveActiveAgentRunAuthorization(context)!;
        expect(authorization.isActive()).toBe(true);
        if (reason === "abort") {
          abort.abort();
        } else if (reason === "restart") {
          rotateAgentRunRegistryLifecycleGeneration();
        } else if (reason === "clear") {
          clearAgentRunContext(context.runId, getAgentRunLifecycleGeneration(), claimId);
        } else if (reason === "recycle") {
          resetAgentEventsForTest();
          startRun();
        } else {
          emitAgentEvent({ runId: context.runId, stream: "lifecycle", data: { phase: reason } });
        }
        expect(authorization.isActive()).toBe(false);
        expect(resolveActiveAgentRunAuthorization(context)).toBeUndefined();
      }, abort.signal);
    },
  );

  it("uses a verified root registry identity without accepting an arbitrary fallback", async () => {
    registerAgentRunContext(context.runId, {
      agentId: context.agentId,
      sessionKey: context.sessionKey,
    });
    await duringTool(() => expect(resolveActiveAgentRunAuthorization(context)).toBeUndefined());
    emitAgentEvent({
      runId: context.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 1 },
    });
    await duringTool(() => {
      expect(resolveActiveAgentRunAuthorization(context)?.admissionRunId).toBe(context.runId);
    });
  });

  it("expires authority on a per-tool cancellation while its parent run is still active", async () => {
    startRun();
    const toolAbort = new AbortController();
    await duringTool(
      () => {
        const authorization = resolveActiveAgentRunAuthorization(context)!;
        expect(authorization.isActive()).toBe(true);
        toolAbort.abort(new Error("Tool timeout"));
        expect(authorization.isActive()).toBe(false);
        expect(resolveActiveAgentRunAuthorization(context)).toBeUndefined();
      },
      undefined,
      toolAbort.signal,
    );
  });

  it("shares the actual invocation with a separately loaded host accessor module", async () => {
    startRun();
    vi.resetModules();
    const reloaded = await import("../../infra/agent-tool-invocation.js");
    let authorization: ActiveAgentRunAuthorization | undefined;
    await duringTool(() => {
      authorization = reloaded.resolveActiveAgentRunAuthorization(context);
      expect(authorization?.isActive()).toBe(true);
      expect(authorization?.admissionRunId).toBe("ingress-request");
    });
    expect(authorization?.isActive()).toBe(false);
  });
});
