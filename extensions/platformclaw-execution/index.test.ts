import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { getSandboxBackendFactory } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { PLATFORMCLAW_EXECUTION_BACKEND_ID } from "./src/backend.js";

describe("PlatformClaw execution plugin", () => {
  it("registers one fail-closed static backend during full activation", async () => {
    plugin.register({ registrationMode: "full" } as OpenClawPluginApi);

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
  });
});
