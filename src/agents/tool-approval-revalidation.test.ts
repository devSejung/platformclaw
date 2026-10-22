import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { resolveBeforeToolCallApprovalOutcome } from "./agent-tools.before-tool-call.approval.js";
import { awaitExecApprovalInline } from "./bash-tools.exec-approval-wait.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
vi.mock("../infra/embedded-mode.js", () => ({ isEmbeddedMode: () => false }));

beforeEach(() => resetGlobalHookRunner());
afterEach(() => {
  resetGlobalHookRunner();
  vi.clearAllMocks();
});

const identity = {
  agentId: "personal-a",
  sessionKey: "agent:personal-a:space-1",
  sessionId: "session-a",
  runId: "request-run-a",
};
function policy(handler: (...args: unknown[]) => unknown) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "after_tool_approval", pluginId: "policy", handler }]),
  );
}

describe("tool authority after an approval wait", () => {
  it("revalidates the original immutable inline exec identity before releasing its decision", async () => {
    let release!: (value: string) => void;
    const waiting = new Promise<string>((resolve) => {
      release = resolve;
    });
    const hook = vi.fn();
    policy(hook);
    const context = { ...identity, toolCallId: "tool-a" };
    const result = awaitExecApprovalInline(context, "approval-a", () => waiting);
    context.runId = "replacement-run";
    release("allow-once");
    await expect(result).resolves.toBe("allow-once");
    expect(hook).toHaveBeenCalledWith(
      { approvalId: "approval-a", toolCallId: "tool-a" },
      expect.objectContaining(identity),
    );
    expect(Object.isFrozen(hook.mock.calls[0]![0])).toBe(true);
    expect(Object.isFrozen(hook.mock.calls[0]![1])).toBe(true);
  });

  it("fails closed when inline exec permission was revoked while approval waited", async () => {
    policy(() => {
      throw new Error("request permanently revoked");
    });
    await expect(
      awaitExecApprovalInline(identity, "approval-a", async () => "allow-once"),
    ).rejects.toThrow("request permanently revoked");
  });

  it.each(["allow-once", "allow-always"])(
    "blocks plugin %s before notifying approval callbacks when revalidation fails",
    async (decision) => {
      const hook = vi.fn(() => {
        throw new Error("request permanently revoked");
      });
      policy(hook);
      vi.mocked(callGatewayTool).mockResolvedValue({ id: "approval-a", decision });
      const onResolution = vi.fn();
      const result = await resolveBeforeToolCallApprovalOutcome({
        result: {
          requireApproval: {
            title: "Execute",
            description: "Confirm execution",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
            onResolution,
          },
        },
        toolName: "exec",
        toolCallId: "tool-a",
        ctx: identity,
        baseParams: { command: "reviewed command" },
      });
      expect(result).toMatchObject({ blocked: true, reason: "Tool approval no longer authorized" });
      expect(hook).toHaveBeenCalledWith(
        { approvalId: "approval-a", toolCallId: "tool-a" },
        expect.objectContaining(identity),
      );
      expect(onResolution).not.toHaveBeenCalledWith(decision);
    },
  );

  it("preserves approved plugin parameters and skips revalidation for denials", async () => {
    const hook = vi.fn();
    policy(hook);
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({ id: "approval-a", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "approval-b", decision: "deny" });
    const params = {
      result: { requireApproval: { title: "Execute", description: "Confirm execution" } },
      toolName: "exec",
      toolCallId: "tool-a",
      ctx: identity,
      baseParams: { command: "reviewed command" },
    };
    await expect(resolveBeforeToolCallApprovalOutcome(params)).resolves.toMatchObject({
      blocked: false,
      params: params.baseParams,
    });
    await expect(resolveBeforeToolCallApprovalOutcome(params)).resolves.toMatchObject({
      blocked: true,
      reason: "Denied by user",
    });
    expect(hook).toHaveBeenCalledOnce();
  });
});
