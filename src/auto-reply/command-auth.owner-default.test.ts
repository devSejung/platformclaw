/** Tests command authorization owner defaults for direct-message senders. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveOwnerPromptNumbers } from "../agents/owner-display.js";
import { buildAgentSystemPrompt } from "../agents/system-prompt.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { resolvePersonalAgentCommandScope } from "./sender-identity.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

describe("senderIsOwner only reflects explicit owner authorization", () => {
  it.each([
    { provider: "webchat", senderAgentId: "main", agentId: "main", owner: false, allowed: true },
    {
      provider: "webchat",
      senderAgentId: "foreign",
      agentId: "main",
      owner: false,
      allowed: false,
    },
    {
      provider: "webchat",
      senderAgentId: undefined,
      agentId: "main",
      owner: false,
      allowed: false,
    },
    {
      provider: "webchat",
      senderAgentId: "main",
      agentId: undefined,
      owner: false,
      allowed: false,
    },
    {
      provider: "webchat",
      senderAgentId: "main",
      agentId: "main",
      owner: undefined,
      allowed: false,
    },
    { provider: "discord", senderAgentId: "main", agentId: "main", owner: false, allowed: false },
  ])(
    "keeps personal command authority separate from owner identity ($provider/$senderAgentId/$agentId/$owner)",
    ({ provider, senderAgentId, agentId, owner, allowed }) => {
      const ctx: MsgContext = {
        Provider: provider,
        Surface: provider,
        SenderId: "first.user",
        SenderIsOwner: owner,
        SenderAgentId: senderAgentId,
        AgentId: agentId,
        GatewayClientScopes: [],
      };
      expect(resolvePersonalAgentCommandScope(ctx)).toBe(allowed ? "main" : undefined);
      const auth = resolveCommandAuthorization({
        cfg: { commands: { ownerAllowFrom: ["global.owner"] } },
        ctx,
        commandAuthorized: true,
      });
      expect(auth.isAuthorizedSender).toBe(allowed);
      expect(auth.senderIsOwner).toBe(false);
    },
  );

  it("retains explicit commands.allowFrom for a bound personal Agent", () => {
    const ctx: MsgContext = {
      Provider: "webchat",
      SenderId: "first.user",
      SenderIsOwner: false,
      SenderAgentId: "main",
      AgentId: "main",
      GatewayClientScopes: [],
    };
    for (const [allowed, sender] of [
      [false, "other.user"],
      [true, "first.user"],
    ] as const) {
      const auth = resolveCommandAuthorization({
        cfg: { commands: { ownerAllowFrom: ["global.owner"], allowFrom: { "*": [sender] } } },
        ctx,
        commandAuthorized: true,
      });
      expect(auth.isAuthorizedSender).toBe(allowed);
      expect(auth.senderIsOwner).toBe(false);
    }
  });

  it.each([false, undefined, true])(
    "respects internal ingress owner authority %s before shared scopes and owner identity",
    (senderIsOwner) => {
      const auth = resolveCommandAuthorization({
        cfg: { commands: { ownerAllowFrom: ["first.user"] } },
        ctx: {
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          SenderId: "first.user",
          SenderIsOwner: senderIsOwner,
          GatewayClientScopes: ["operator.admin"],
        },
        commandAuthorized: true,
      });
      expect(auth.senderIsOwner).toBe(senderIsOwner !== false);
    },
  );

  it("accepts trusted post-admission owner proof from an external channel", () => {
    const auth = resolveCommandAuthorization({
      cfg: {},
      ctx: {
        Provider: "knox",
        Surface: "knox",
        ChatType: "direct",
        From: "dm:42",
        SenderId: "user.name",
        SenderIsOwner: true,
      } as MsgContext,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does not treat direct-message senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does not treat group-chat senders as owners when no ownerAllowFrom is configured", () => {
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
      From: "discord:123",
      SenderId: "123",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("keeps channel-validated native group commands authorized without owner status", () => {
    const cfg = {
      channels: { telegram: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SenderId: "200482621",
      CommandSource: "native",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("keeps channel allowlist senders authorized without owner status", () => {
    const cfg = {
      channels: { telegram: { allowFrom: ["200482621"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:200482621",
      SenderId: "200482621",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.ownerList).toEqual([]);
    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("senderIsOwner is false when ownerAllowFrom is configured and sender does not match", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:789",
      SenderId: "789",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("does not let native command authorization bypass explicit owner allowlists", () => {
    const cfg = {
      channels: { telegram: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SenderId: "200482621",
      CommandSource: "native",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
  });

  it("senderIsOwner is true when ownerAllowFrom matches sender", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:456",
      SenderId: "456",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
  });

  it("keeps a large owner allowlist authorized without exhausting the model prompt", () => {
    const ownerIds = Array.from({ length: 9_282 }, (_, index) =>
      String(100_000_000_000_000_000n + BigInt(index)),
    );
    const currentOwnerId = ownerIds.at(-1)!;
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ownerIds.map((ownerId) => `discord:${ownerId}`) },
    } as OpenClawConfig;
    const context = {
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: `discord:${currentOwnerId}`,
      SenderId: `<@!${currentOwnerId}>`,
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: context,
    });

    expect(auth.ownerList).toHaveLength(ownerIds.length);
    expect(auth.senderId).toBe(currentOwnerId);
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.isAuthorizedSender).toBe(true);

    const ownerNumbers = resolveOwnerPromptNumbers({
      ownerNumbers: auth.ownerList,
      senderId: auth.senderId,
      senderIsOwner: auth.senderIsOwner,
    });
    const promptParams = {
      workspaceDir: "/tmp/openclaw",
      ownerNumbers,
      runtimeInfo: { channel: "discord" },
    };
    const prompt = buildAgentSystemPrompt(promptParams);
    const ownerLine = prompt.split("## Authorized Senders\n")[1]?.split("\n")[0] ?? "";

    expect(ownerLine).toContain(currentOwnerId);
    expect(Buffer.byteLength(ownerLine, "utf8")).toBeLessThanOrEqual(1_024);

    const hashedPrompt = buildAgentSystemPrompt({ ...promptParams, ownerDisplay: "hash" });
    const currentOwnerHash = createHash("sha256").update(currentOwnerId).digest("hex").slice(0, 12);
    expect(hashedPrompt).toContain(currentOwnerHash);
    expect(hashedPrompt).not.toContain(currentOwnerId);

    cfg.commands?.ownerAllowFrom?.pop();
    const revoked = resolveCommandAuthorization({
      cfg,
      commandAuthorized: true,
      ctx: context,
    });
    expect(revoked.ownerList).toHaveLength(ownerIds.length - 1);
    expect(revoked.senderIsOwner).toBe(false);
    expect(revoked.isAuthorizedSender).toBe(false);
  });

  it("ignores ownerAllowFrom wildcards", () => {
    const cfg = {
      channels: { discord: {} },
      commands: { ownerAllowFrom: ["*"] },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:anyone",
      SenderId: "anyone",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.ownerList).toEqual([]);
    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("senderIsOwner is true for internal operator.admin sessions", () => {
    const cfg = {} as OpenClawConfig;

    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.admin"],
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
  });
});
