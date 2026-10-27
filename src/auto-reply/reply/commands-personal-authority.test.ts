import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand } from "./commands-config.js";
import { handleStatusCommand } from "./commands-info.js";
import { handleRestartCommand } from "./commands-session.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

// Keep command context, authorization, and handlers real. Only terminal I/O is stubbed.
const effects = vi.hoisted(() => ({
  compact: vi.fn<typeof import("./commands-compact.runtime.js").compactEmbeddedAgentSession>(
    async () => ({
      ok: true,
      compacted: false,
      reason: "already under target",
    }),
  ),
  enqueueSystemEvent: vi.fn<typeof import("./commands-compact.runtime.js").enqueueSystemEvent>(),
  status: vi.fn<typeof import("../../status/status-text.js").buildStatusText>(
    async () => "Current personal session status",
  ),
  shell: vi.fn<typeof import("./bash-command.js").handleBashChatCommand>(async () => ({
    text: "shell executed",
  })),
  readConfig: vi.fn<typeof import("../../config/config.js").readConfigFileSnapshot>(),
  restart: vi.fn<typeof import("../../infra/restart.js").triggerOpenClawRestart>(),
  scheduleRestart: vi.fn<typeof import("../../infra/restart.js").scheduleGatewaySigusr1Restart>(),
}));

vi.mock("./commands-compact.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands-compact.runtime.js")>()),
  compactEmbeddedAgentSession: effects.compact,
  enqueueSystemEvent: effects.enqueueSystemEvent,
}));
vi.mock("../../status/status-text.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../status/status-text.js")>()),
  buildStatusText: effects.status,
}));
vi.mock("./bash-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-command.js")>()),
  handleBashChatCommand: effects.shell,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: effects.readConfig,
}));
vi.mock("../../infra/restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart.js")>()),
  triggerOpenClawRestart: effects.restart,
  scheduleGatewaySigusr1Restart: effects.scheduleRestart,
}));

const config: OpenClawConfig = {
  commands: {
    text: true,
    config: true,
    restart: true,
    bash: true,
    ownerAllowFrom: ["global.owner"],
  },
  agents: { entries: { main: { default: true } } },
};

function personalCommand(body: string, cfg = config) {
  const params = buildCommandTestParams(body, cfg, {
    Provider: "webchat",
    Surface: "webchat",
    AgentId: "main",
    SenderId: "first.user",
    SenderAgentId: "main",
    SenderIsOwner: false,
    GatewayClientScopes: [],
  });
  params.agentId = "main";
  params.sessionEntry = { sessionId: "personal-session", updatedAt: 1 };
  return params;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("personal Agent command authority at actual handlers", () => {
  it("returns status with a configured global owner allowlist without acquiring ownership", async () => {
    const params = personalCommand("/status");
    expect(params.command).toMatchObject({ isAuthorizedSender: true, senderIsOwner: false });
    await expect(handleStatusCommand(params, true)).resolves.toEqual({
      shouldContinue: false,
      reply: { text: "Current personal session status" },
    });
    expect(effects.status).toHaveBeenCalledOnce();
  });

  it("runs compact and returns a visible outcome with the configured global owner allowlist", async () => {
    const params = personalCommand("/compact");
    expect(params.command).toMatchObject({ isAuthorizedSender: true, senderIsOwner: false });
    const result = await handleCompactCommand(params, true);
    expect(result).toMatchObject({
      shouldContinue: false,
      reply: { text: expect.stringContaining("Compaction skipped") },
    });
    expect(effects.compact).toHaveBeenCalledOnce();
    expect(effects.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        sessionId: "personal-session",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      }),
    );
  });

  it("keeps explicit command allowlists authoritative", async () => {
    const params = personalCommand("/status", {
      ...config,
      commands: { ...config.commands, allowFrom: { "*": ["other.user"] } },
    });
    expect(params.command).toMatchObject({ isAuthorizedSender: false, senderIsOwner: false });
    await expect(handleStatusCommand(params, true)).resolves.toEqual({ shouldContinue: false });
    expect(effects.status).not.toHaveBeenCalled();
  });

  it("does not grant global config writes or restart", async () => {
    const configParams = personalCommand("/config set commands.restart true");
    const restartParams = personalCommand("/restart");
    expect(configParams.command).toMatchObject({ isAuthorizedSender: true, senderIsOwner: false });
    expect(await handleConfigCommand(configParams, true)).toEqual({ shouldContinue: false });
    expect(await handleRestartCommand(restartParams, true)).toEqual({ shouldContinue: false });
    expect(effects.readConfig).not.toHaveBeenCalled();
    expect(effects.restart).not.toHaveBeenCalled();
    expect(effects.scheduleRestart).not.toHaveBeenCalled();
  });

  it.each(["/bash echo forbidden", "! echo forbidden"])(
    "visibly denies the global shell shortcut %s before its effect",
    async (body) => {
      const params = personalCommand(body);
      expect(params.command).toMatchObject({ isAuthorizedSender: true, senderIsOwner: false });
      expect(params.elevated).toMatchObject({ enabled: true, allowed: true });
      const result = await handleBashCommand(params, true);
      expect(result).toMatchObject({
        shouldContinue: false,
        reply: { text: expect.stringContaining("Gateway-owner authority") },
      });
      expect(effects.shell).not.toHaveBeenCalled();
    },
  );

  it.each(["webchat", "discord"])(
    "preserves legacy/external shell authorization for %s",
    async (provider) => {
      const params = buildCommandTestParams(
        "/bash echo legacy",
        { commands: { text: true, bash: true } },
        {
          Provider: provider,
          Surface: provider,
          SenderId: "first.user",
          ...(provider === "discord" ? { SenderIsOwner: false } : {}),
        },
      );
      expect(params.command.isAuthorizedSender).toBe(true);
      expect(await handleBashCommand(params, true)).toEqual({
        shouldContinue: false,
        reply: { text: "shell executed" },
      });
      expect(effects.shell).toHaveBeenCalledOnce();
    },
  );
});
