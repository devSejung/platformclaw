import { EventEmitter } from "node:events";
import {
  canUseAcpProcessTransport,
  diagnoseAcpProcessTransport,
  prepareAcpProcessTransport,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import { launchWithAcpProcessTransport } from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { getSandboxBackendFactory } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { PLATFORMCLAW_EXECUTION_BACKEND_ID } from "./src/backend.js";

const { createExecutionDependenciesFromEnvironmentMock } = vi.hoisted(() => ({
  createExecutionDependenciesFromEnvironmentMock: vi.fn(),
}));

vi.mock("./src/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/runtime.js")>()),
  createExecutionDependenciesFromEnvironment: createExecutionDependenciesFromEnvironmentMock,
}));

describe("PlatformClaw execution plugin", () => {
  it("reserves five owner slots before asynchronous launches and frees a closed slot", async () => {
    const previousBroker = process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS;
    const previousToken = process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
    process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS = "/run/platformclaw/base.sock";
    process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE = "/run/secrets/execution-token";
    const target = {
      kind: "assigned_vm",
      agentId: "person_one",
      targetId: "vm-one",
      revision: 1,
      allocationId: "allocation-one",
      credentialRevision: 1,
      remoteWorkspaceDir: "/workspace",
      codingAgents: [
        { agent: "claude", enabled: true },
        { agent: "codex", enabled: true },
      ],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
    const launchAcpProcess = vi.fn(async () => {
      await gate;
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      children.push(child);
      return child;
    });
    createExecutionDependenciesFromEnvironmentMock.mockResolvedValue({
      resolveTarget: vi.fn(async () => target),
      launchAcpProcess,
      dispose: vi.fn(async () => undefined),
    });
    const stops: Array<() => Promise<void>> = [];
    try {
      plugin.register({
        registrationMode: "full",
        logger: { info: vi.fn() },
        registerGatewayMethod: vi.fn(() => () => undefined),
        on: vi.fn((event, handler) => {
          if (event === "gateway_stop") {
            stops.push(handler);
          }
        }),
      } as unknown as OpenClawPluginApi);
      const routes = Array.from({ length: 6 }, (_, index) => ({
        executionOwnerAgentId: "person_one",
        agent: index % 2 ? "codex" : "claude",
        sessionKey: `agent:person_one:acp:${index}`,
      }));
      await Promise.all(routes.map((route) => prepareAcpProcessTransport(route)));
      const launch = (index: number) =>
        launchWithAcpProcessTransport(
          {
            agentCommand: routes[index]!.agent,
            command: "adapter",
            args: [],
            cwd: "/workspace",
            env: {},
          },
          routes[index],
        );
      const firstFive = Array.from({ length: 5 }, (_, index) => launch(index));
      await vi.waitFor(() => expect(launchAcpProcess).toHaveBeenCalledTimes(5));
      await expect(launch(5)).rejects.toMatchObject({ code: "session_limit_reached" });
      release();
      await Promise.all(firstFive);
      children[0]!.emit("close");
      await expect(launch(5)).resolves.toBeDefined();
      expect(launchAcpProcess).toHaveBeenCalledTimes(6);
    } finally {
      release();
      await Promise.all(stops.map((stop) => stop()));
      if (previousBroker === undefined) {
        delete process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS;
      } else {
        process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS = previousBroker;
      }
      if (previousToken === undefined) {
        delete process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
      } else {
        process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE = previousToken;
      }
    }
  });
  it("registers one fail-closed static backend during full activation", async () => {
    const stopHandlers: Array<() => Promise<void>> = [];
    plugin.register({
      registrationMode: "full",
      on: vi.fn((event: string, handler: () => Promise<void>) => {
        if (event === "gateway_stop") {
          stopHandlers.push(handler);
        }
      }),
    } as unknown as OpenClawPluginApi);

    const factory = getSandboxBackendFactory(PLATFORMCLAW_EXECUTION_BACKEND_ID);
    if (!factory) {
      throw new Error("expected PlatformClaw execution backend registration");
    }
    await expect(
      factory({
        agentId: "person_one",
        sessionKey: "agent:person_one:main",
        scopeKey: "opaque-scope",
        workspaceDir: "/workspace/person_one",
        agentWorkspaceDir: "/agents/person_one",
        cfg: {} as CreateSandboxBackendParams["cfg"],
      }),
    ).rejects.toThrow("target resolution is not configured");

    expect(
      canUseAcpProcessTransport({ executionOwnerAgentId: "person_one", agent: "claude" }),
    ).toBe(true);
    await expect(
      prepareAcpProcessTransport({
        executionOwnerAgentId: "person_one",
        agent: "claude",
        sessionKey: "agent:claude:acp:one",
      }),
    ).rejects.toThrow("Assigned VM ACP routing is not configured");

    await Promise.all(stopHandlers.map(async (handler) => await handler()));
  });

  it("blocks a disabled coding agent before preparing a new ACP session", async () => {
    const previousBroker = process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS;
    const previousToken = process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
    process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS = "/run/platformclaw/base.sock";
    process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE = "/run/secrets/execution-token";
    const stopHandlers: Array<() => Promise<void>> = [];
    createExecutionDependenciesFromEnvironmentMock.mockResolvedValue({
      resolveTarget: vi.fn(async () => ({
        kind: "assigned_vm",
        agentId: "person_one",
        targetId: "vm-one",
        revision: 1,
        allocationId: "allocation-one",
        credentialRevision: 1,
        remoteWorkspaceDir: "/home/person/workspace",
        codingAgents: [{ agent: "claude", enabled: false }],
      })),
      dispose: vi.fn(async () => undefined),
    });
    try {
      plugin.register({
        registrationMode: "full",
        logger: { info: vi.fn() },
        registerGatewayMethod: vi.fn(() => () => undefined),
        on: vi.fn((event: string, handler: () => Promise<void>) => {
          if (event === "gateway_stop") {
            stopHandlers.push(handler);
          }
        }),
      } as unknown as OpenClawPluginApi);

      await expect(
        prepareAcpProcessTransport({
          executionOwnerAgentId: "person_one",
          agent: "claude",
          sessionKey: "agent:claude:acp:disabled",
        }),
      ).rejects.toMatchObject({ code: "agent_disabled" });
    } finally {
      await Promise.all(stopHandlers.map(async (handler) => await handler()));
      if (previousBroker === undefined) {
        delete process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS;
      } else {
        process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS = previousBroker;
      }
      if (previousToken === undefined) {
        delete process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
      } else {
        process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE = previousToken;
      }
    }
  });

  it("diagnoses only the attributed owner and rejects a target revision race", async () => {
    const previousBroker = process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS;
    const previousToken = process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
    process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS = "/run/platformclaw/base.sock";
    process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE = "/run/secrets/execution-token";
    const target = {
      kind: "assigned_vm" as const,
      agentId: "person_one",
      targetId: "vm-one",
      revision: 1,
      allocationId: "allocation-one",
      credentialRevision: 1,
      remoteWorkspaceDir: "/home/person/workspace",
      codingAgents: [{ agent: "claude", enabled: true }],
    };
    const resolveTarget = vi
      .fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({ ...target, revision: 2 });
    const diagnoseAcpProcess = vi.fn(async () => ({
      ok: true as const,
      stage: "ready" as const,
      code: "ready",
      message: "ready",
    }));
    createExecutionDependenciesFromEnvironmentMock.mockResolvedValue({
      resolveTarget,
      diagnoseAcpProcess,
      dispose: vi.fn(async () => undefined),
    });
    const stopHandlers: Array<() => Promise<void>> = [];
    try {
      plugin.register({
        registrationMode: "full",
        logger: { info: vi.fn() },
        registerGatewayMethod: vi.fn(() => () => undefined),
        on: vi.fn((event: string, handler: () => Promise<void>) => {
          if (event === "gateway_stop") {
            stopHandlers.push(handler);
          }
        }),
      } as unknown as OpenClawPluginApi);

      await expect(
        diagnoseAcpProcessTransport({ executionOwnerAgentId: "person_one", agent: "claude" }),
      ).resolves.toEqual(
        expect.objectContaining({ ok: false, stage: "target", code: "target_changed" }),
      );
      expect(resolveTarget).toHaveBeenNthCalledWith(1, {
        agentId: "person_one",
        target: "assigned_vm",
      });
      expect(diagnoseAcpProcess).toHaveBeenCalledWith("claude", target, undefined);
    } finally {
      await Promise.all(stopHandlers.map(async (handler) => await handler()));
      if (previousBroker === undefined) {
        delete process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS;
      } else {
        process.env.PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS = previousBroker;
      }
      if (previousToken === undefined) {
        delete process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE;
      } else {
        process.env.PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE = previousToken;
      }
    }
  });
});
