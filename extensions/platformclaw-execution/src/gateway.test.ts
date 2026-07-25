import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { PlatformClawVmAuthenticationError } from "./connection-errors.js";
import { registerPlatformClawExecutionGateway } from "./gateway.js";

type GatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
type BeforeRunHandler = Parameters<OpenClawPluginApi["on"]>[1];

function createHarness(runtime: {
  testConnection: ReturnType<typeof vi.fn>;
  changeTarget: ReturnType<typeof vi.fn>;
}) {
  const methods = new Map<string, GatewayHandler>();
  let beforeRun: BeforeRunHandler | undefined;
  const api = {
    on: vi.fn((name: string, handler: BeforeRunHandler) => {
      if (name === "before_agent_run") {
        beforeRun = handler;
      }
    }),
    registerGatewayMethod: vi.fn((name: string, handler: GatewayHandler) => {
      methods.set(name, handler);
    }),
  };
  registerPlatformClawExecutionGateway(api as never, Promise.resolve(runtime as never));
  return { beforeRun: () => beforeRun!, methods };
}

describe("PlatformClaw execution Gateway methods", () => {
  it("classifies only an SSH authentication rejection for the BFF", async () => {
    const runtime = {
      testConnection: vi.fn(async () => {
        throw new PlatformClawVmAuthenticationError();
      }),
      changeTarget: vi.fn(),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();

    await harness.methods.get("platformclaw-execution.testConnection")!({
      params: { agentId: "person_one", credentialGrantToken: "grant-token" },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "development VM authentication failed",
      details: { kind: "vm_authentication_failed" },
    });
  });

  it("rejects a work-location change while that agent has an active run", async () => {
    const runtime = { testConnection: vi.fn(), changeTarget: vi.fn() };
    const harness = createHarness(runtime);
    const respond = vi.fn();

    await harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "assigned_vm", expectedRevision: 1 },
      context: {
        chatAbortControllers: new Map([["run-one", { agentId: "person_one" }]]),
      },
      respond,
    } as never);

    expect(runtime.changeTarget).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "CONFLICT" }),
    );
  });

  it("blocks a new run until the atomic target change finishes", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      testConnection: vi.fn(),
      changeTarget: vi.fn(async () => {
        await pending;
        return {
          kind: "platform_server" as const,
          agentId: "person_one",
          targetId: "platform-server",
          revision: 2,
        };
      }),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();
    const changing = harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "platform_server", expectedRevision: 1 },
      context: { chatAbortControllers: new Map() },
      respond,
    } as never);

    await vi.waitFor(() => expect(runtime.changeTarget).toHaveBeenCalledOnce());
    expect(harness.beforeRun()({} as never, { agentId: "person_one" } as never)).toMatchObject({
      outcome: "block",
    });
    release();
    await changing;
    expect(harness.beforeRun()({} as never, { agentId: "person_one" } as never)).toMatchObject({
      outcome: "pass",
    });
  });

  it("preserves an optimistic-revision conflict from the control plane", async () => {
    const runtime = {
      testConnection: vi.fn(),
      changeTarget: vi.fn(async () => {
        throw new Error("execution handoff request failed (409)");
      }),
    };
    const harness = createHarness(runtime);
    const respond = vi.fn();

    await harness.methods.get("platformclaw-execution.changeTarget")!({
      params: { agentId: "person_one", target: "assigned_vm", expectedRevision: 1 },
      context: { chatAbortControllers: new Map() },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "CONFLICT",
      message: "work location changed before the requested update",
    });
  });
});
