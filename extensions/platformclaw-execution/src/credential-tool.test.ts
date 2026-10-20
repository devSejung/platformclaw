import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  registerPlatformClawCredentialTool,
  type PlatformClawCredentialRuntime,
} from "./credential-tool.js";

const context = {
  agentId: "person_one",
  sessionKey: "agent:person_one:dashboard:one",
  sessionId: "session-one",
  runId: "run-one",
  sandboxed: true,
};

function runtime(definitions = [{ envName: "REPORT_API_TOKEN", configured: false }]) {
  return { credentialMetadata: vi.fn(async () => ({ definitions })) };
}

function createPlatformClawCredentialTool(
  toolContext: OpenClawPluginToolContext,
  metadata: Promise<PlatformClawCredentialRuntime>,
) {
  const fixture = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    ...fixture,
    id: "platformclaw-execution",
    name: "PlatformClaw Execution",
    contracts: { tools: ["platformclaw_credentials"] },
    register: (api) => registerPlatformClawCredentialTool(api, metadata),
  });
  expect(fixture.registry.registry.diagnostics).toEqual([]);
  const registration = fixture.registry.registry.tools.find((entry) =>
    entry.names.includes("platformclaw_credentials"),
  );
  const tool = registration?.factory(toolContext);
  if (Array.isArray(tool)) {
    throw new Error("credential tool registration returned multiple tools");
  }
  return tool ?? null;
}

describe("PlatformClaw credential tool", () => {
  it("materializes the registered tool for a sandboxed personal conversation and emits a stable bounded action", async () => {
    const metadata = runtime();
    const tool = createPlatformClawCredentialTool(context, Promise.resolve(metadata));
    if (!tool) {
      throw new Error("credential tool was not materialized");
    }
    const first = await tool.execute("call-one", {
      action: "request",
      envName: "REPORT_API_TOKEN",
    });
    const duplicate = await tool.execute("call-one", {
      action: "request",
      envName: "REPORT_API_TOKEN",
    });
    expect(metadata.credentialMetadata).toHaveBeenCalledWith({
      agentId: context.agentId,
      sessionKey: context.sessionKey,
    });
    expect(first.details).toMatchObject({
      status: "required",
      uiAction: {
        version: 1,
        kind: "settings",
        feature: "platformclaw.exec-credentials",
        targetKey: "REPORT_API_TOKEN",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      },
    });
    const action = (first.details as { uiAction: object }).uiAction;
    expect(Object.keys(action).toSorted()).toEqual([
      "feature",
      "kind",
      "requestId",
      "targetKey",
      "version",
    ]);
    expect(duplicate.details).toEqual(first.details);
  });

  it.each(["knox", "webchat", undefined])(
    "provides a manual registration path without a button and rechecks after saving: %s",
    async (messageChannel) => {
      const metadata = runtime();
      const tool = createPlatformClawCredentialTool(
        { ...context, sessionKey: "agent:person_one:main", messageChannel },
        Promise.resolve(metadata),
      )!;
      const input = { action: "request", envName: "REPORT_API_TOKEN" };
      const missing = await tool.execute("missing-call", input);
      expect(missing.details).toMatchObject({ status: "required", envName: input.envName });
      expect(missing.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining(
            "If no button appears, sign in to PlatformClaw on a PC, open Settings > Credentials, save REPORT_API_TOKEN, then send a new message asking to continue in the original conversation.",
          ),
        }),
      ]);
      expect(JSON.stringify(missing.content)).toContain("Never paste a key in chat");
      expect(JSON.stringify(missing.content)).toContain("saving alone does not restart the task");
      expect(JSON.stringify(missing.content)).toContain("no tool call is suspended");

      metadata.credentialMetadata.mockResolvedValue({
        definitions: [{ envName: input.envName, configured: true }],
      });
      const saved = await tool.execute("continue-call", input);
      expect(saved.details).toEqual({ status: "configured", envName: input.envName });
      expect(metadata.credentialMetadata).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "agent:other:main",
    "agent:person_one:subagent:one",
    "agent:person_one:acp:one",
    "agent:person_one:cron:one",
    "agent:person_one:space-session:one",
    "agent:person_one:knox:group:one",
    "catalog-one",
  ])("hides the tool outside an ordinary personal session: %s", (sessionKey) => {
    expect(
      createPlatformClawCredentialTool({ ...context, sessionKey }, Promise.resolve(runtime())),
    ).toBeNull();
  });

  it("keeps discovery visible without starting the configured runtime", () => {
    const registerTool = vi.fn();
    registerPlatformClawCredentialTool({ registrationMode: "tool-discovery", registerTool });
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "platformclaw_credentials",
    });
  });

  it.each([
    [{ action: "request", envName: "UNKNOWN_TOKEN" }, "unsupported"],
    [{ action: "request", envName: "PATH" }, "unsupported"],
    [{ action: "request", envName: "REPORT_API_TOKEN", value: "synthetic-only" }, "unsupported"],
    [{ action: "list", envName: "REPORT_API_TOKEN" }, "unsupported"],
  ])("does not create an action for unsupported input", async (input, status) => {
    const tool = createPlatformClawCredentialTool(context, Promise.resolve(runtime()))!;
    expect((await tool.execute("call", input)).details).toEqual({ status, code: "not-allowed" });
  });

  it("distinguishes configured, forbidden, and unavailable from missing", async () => {
    const cases: Array<[PlatformClawCredentialRuntime, object]> = [
      [
        runtime([{ envName: "REPORT_API_TOKEN", configured: true }]),
        { status: "configured", envName: "REPORT_API_TOKEN" },
      ],
      [
        { credentialMetadata: async () => ({ status: "unsupported", code: "scope" }) },
        { status: "unsupported", code: "scope" },
      ],
      [
        {
          credentialMetadata: async () => {
            throw new Error("synthetic-only");
          },
        },
        { status: "unavailable", code: "metadata-unavailable" },
      ],
    ];
    for (const [metadata, expected] of cases) {
      const tool = createPlatformClawCredentialTool(context, Promise.resolve(metadata))!;
      const result = await tool.execute("call", { action: "request", envName: "REPORT_API_TOKEN" });
      expect(result.details).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain("synthetic-only");
    }
  });

  it("bounds the complete list result to 1 KiB without denying names omitted from display", async () => {
    const definitions = Array.from({ length: 32 }, (_, index) => ({
      envName: `KEY_${index.toString().padStart(2, "0")}_${"X".repeat(118)}`,
      configured: false,
    }));
    const tool = createPlatformClawCredentialTool(context, Promise.resolve(runtime(definitions)))!;
    const result = await tool.execute("list", { action: "list" });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
    expect(result.details).toMatchObject({ status: "available", truncated: true });
    expect(
      (await tool.execute("request", { action: "request", envName: definitions[31]!.envName }))
        .details,
    ).toMatchObject({ status: "required" });
  });
});
