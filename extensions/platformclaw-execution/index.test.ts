import {
  canUseAcpProcessTransport,
  prepareAcpProcessTransport,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { getSandboxBackendFactory } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { PLATFORMCLAW_EXECUTION_BACKEND_ID } from "./src/backend.js";

describe("PlatformClaw execution plugin", () => {
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
});
