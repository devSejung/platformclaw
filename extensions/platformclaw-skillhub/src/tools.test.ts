import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { SkillHubClientRequest } from "./client.js";
import { registerPlatformClawSkillHubTools } from "./tools.js";

const context: OpenClawPluginToolContext = {
  agentId: "room-agent",
  sessionKey: "agent:room-agent:main",
  requesterSenderId: "person.one",
  messageChannel: "knox",
  agentAccountId: "default",
  nativeChannelId: "group-1",
  deliveryContext: { channel: "knox", accountId: "default", to: "room:group-1" },
};

function setup() {
  const registerTool = vi.fn();
  const request = vi.fn(async (_request: SkillHubClientRequest) => ({
    status: 200,
    body: { items: [] },
  }));
  registerPlatformClawSkillHubTools({ registerTool } as unknown as OpenClawPluginApi, { request });
  return {
    registerTool,
    request,
    tool: (index: number, ctx = context) => registerTool.mock.calls[index]![0](ctx),
  };
}

describe("SkillHub natural language tools", () => {
  it.each(["full", "discovery", "tool-discovery"])(
    "discovers search, status, install and installed-copy deletion in %s",
    (registrationMode) => {
      const registerTool = vi.fn();
      const registerCommand = vi.fn();
      plugin.register({
        registrationMode,
        registerTool,
        registerCommand,
      } as unknown as OpenClawPluginApi);
      expect(registerTool.mock.calls.map((call) => call[1].name)).toEqual([
        "skillhub_search",
        "skillhub_status",
        "skillhub_install",
        "skillhub_delete",
      ]);
      expect(registerCommand).toHaveBeenCalledTimes(registrationMode === "full" ? 1 : 0);
    },
  );

  it("does not register tools in setup mode", () => {
    const registerTool = vi.fn();
    plugin.register({ registrationMode: "setup", registerTool } as unknown as OpenClawPluginApi);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("uses the authenticated sender and current room, without model target arguments", async () => {
    const { tool, request } = setup();
    await tool(0).execute("search", { query: "spreadsheet" });
    await tool(2).execute("install", { namespace: "finance", slug: "sheets", version: "1.2.3" });
    expect(request).toHaveBeenLastCalledWith({
      accountId: "person.one",
      action: "install",
      input: { namespace: "finance", slug: "sheets", version: "1.2.3" },
      context: {
        accountId: "default",
        conversationType: "room",
        conversationId: "group-1",
        agentId: "room-agent",
        sessionKey: "agent:room-agent:main",
      },
    });
    expect(tool(2).parameters.properties).not.toHaveProperty("accountId");
    expect(tool(2).parameters.properties).not.toHaveProperty("context");
  });

  it("uses the same tools for a DM", async () => {
    const { tool, request } = setup();
    await tool(1, {
      ...context,
      agentId: "personal-agent",
      sessionKey: "agent:personal-agent:main",
      nativeChannelId: "dm-1",
      deliveryContext: { channel: "knox", accountId: "default", to: "dm:dm-1" },
    }).execute("status", {});
    expect(request.mock.calls[0]![0].context).toMatchObject({
      conversationType: "dm",
      conversationId: "dm-1",
      agentId: "personal-agent",
    });
  });

  it.each([
    { requesterSenderId: undefined },
    { agentAccountId: undefined },
    { messageChannel: "webchat" },
    { nativeChannelId: "other-room" },
    { agentId: undefined },
    { sessionKey: undefined },
    { deliveryContext: { channel: "knox", accountId: "other-account", to: "room:group-1" } },
  ])("hides tools without a complete matching Knox context %j", (patch) => {
    expect(setup().tool(2, { ...context, ...patch })).toBeNull();
  });

  it.each([
    { accountId: "victim" },
    { context: { conversationId: "other-room" } },
    { args: "delete sheets --confirm" },
    { force: true },
    { acknowledgedReplacement: true },
    { approvalBody: "install it" },
  ])("rejects forged identity, commands, or approval arguments %j", async (extra) => {
    const { tool, request } = setup();
    expect(
      await tool(2).execute("install", {
        namespace: "finance",
        slug: "sheets",
        version: "1.2.3",
        ...extra,
      }),
    ).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns server rejection and visible recovery advice on uncertain response", async () => {
    const { tool, request } = setup();
    request.mockResolvedValueOnce({ status: 409, body: { error: "search again" } } as never);
    expect(
      await tool(2).execute("install", { namespace: "finance", slug: "sheets", version: "1.2.3" }),
    ).toMatchObject({ isError: true, details: { error: "search again" } });
    request.mockRejectedValueOnce(new Error("response lost"));
    const result = await tool(2).execute("install", {
      namespace: "finance",
      slug: "sheets",
      version: "1.2.3",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("check installed status");
  });

  it("requires explicit deletion confirmation and keeps the target in runtime context", async () => {
    const { tool, request } = setup();
    expect(await tool(3).execute("delete", { slug: "sheets" })).toMatchObject({ isError: true });
    expect(await tool(3).execute("delete", { slug: "sheets", confirm: false })).toMatchObject({
      isError: true,
    });
    expect(
      await tool(3).execute("delete", { slug: "sheets", confirm: true, path: "/other/workspace" }),
    ).toMatchObject({ isError: true });
    expect(request).not.toHaveBeenCalled();
    await tool(3).execute("delete", { slug: "sheets", confirm: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "person.one",
        action: "delete",
        input: { slug: "sheets", confirm: true },
        context: expect.objectContaining({ conversationId: "group-1", agentId: "room-agent" }),
      }),
    );
  });
});
