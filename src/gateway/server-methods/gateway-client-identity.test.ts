import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { createGatewayChatUserTurnController } from "./chat-user-turn-recorder.js";
import {
  gatewayClientSenderFields,
  gatewayClientSenderIsOwner,
  gatewayClientSessionCreator,
  normalizeRequestedGatewaySenderAttribution,
} from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

describe("gateway client identity", () => {
  it("normalizes requested sender fields without changing legacy connection metadata", () => {
    expect(
      normalizeRequestedGatewaySenderAttribution({
        id: " first.user ",
        name: " First User ",
        profileId: " profile-first ",
        agentId: " main ",
        isOwner: false,
      }),
    ).toEqual({
      ok: true,
      value: {
        id: "first.user",
        name: "First User",
        profileId: "profile-first",
        agentId: "main",
        isOwner: false,
      },
    });
    expect(normalizeRequestedGatewaySenderAttribution({ id: "first.user", agentId: " " })).toEqual({
      ok: true,
      value: { id: "first.user" },
    });
    expect(normalizeRequestedGatewaySenderAttribution({ id: " " })).toEqual({
      ok: false,
      error: "sender attribution id must not be blank",
    });
    expect(normalizeRequestedGatewaySenderAttribution(undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    const internal = { id: " legacy.user ", agentId: " legacy-agent " };
    const client: GatewayClient = {
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: GATEWAY_CLIENT_IDS.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          platform: "test",
          version: "test",
        },
      },
      internal: { syntheticClient: true, senderAttribution: internal },
    };
    expect(gatewayClientSenderFields(client).sender).toBe(internal);
  });

  it.each([
    { scopes: ["operator.admin"], restricted: false, expected: true },
    { scopes: ["operator.admin"], restricted: true, expected: false },
    { scopes: ["operator.write"], restricted: false, expected: undefined },
    { scopes: ["operator.write"], restricted: true, expected: false },
  ])(
    "retains the explicit owner fact and legacy absence ($scopes/$restricted)",
    ({ scopes, restricted, expected }) => {
      const client: GatewayClient = {
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: GATEWAY_CLIENT_IDS.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
            platform: "test",
            version: "test",
          },
          scopes,
        },
      };
      const sender = {
        id: "first.user",
        agentId: "main",
        ...(restricted ? { isOwner: false as const } : {}),
      };
      const owner = gatewayClientSenderIsOwner(client, sender);
      expect(owner).toBe(expected);
      const recorder = createGatewayChatUserTurnController({
        agentId: "main",
        cfg: {},
        clientRunId: "identity-turn",
        initialSessionId: "identity-session",
        now: 1,
        rawMessage: "hello",
        sender,
        senderIsOwner: owner,
        senderAgentId: sender.agentId,
        sessionKey: "agent:main:main",
        startedAt: 1,
        traceAttributes: {},
        warn: () => {},
      });
      if (expected === undefined) {
        expect(recorder.baseInput).not.toHaveProperty("senderIsOwner");
        expect(recorder.recorder.message).not.toHaveProperty("__openclaw.senderIsOwner");
      } else {
        expect(recorder.recorder.message).toHaveProperty("__openclaw.senderIsOwner", expected);
      }
      const auth = resolveCommandAuthorization({
        cfg: { commands: { ownerAllowFrom: [sender.id] } },
        ctx: {
          Provider: "webchat",
          SenderId: sender.id,
          SenderIsOwner: owner,
          GatewayClientScopes: scopes,
        },
        commandAuthorized: true,
      });
      expect(auth.senderIsOwner).toBe(!restricted);
    },
  );

  it("keeps internal authority restricted while allowing trusted request identity override", () => {
    const client: GatewayClient = {
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: GATEWAY_CLIENT_IDS.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          platform: "test",
          version: "test",
        },
        scopes: ["operator.admin"],
      },
      internal: { syntheticClient: true, senderAttribution: { id: "first.user", isOwner: false } },
    };
    expect(gatewayClientSenderIsOwner(client)).toBe(false);
    expect(gatewayClientSenderIsOwner(client, { id: "legacy.user" })).toBe(false);
    expect(gatewayClientSenderFields(client, { id: "legacy.user" })).toEqual({
      sender: { id: "legacy.user", isOwner: false },
    });
  });

  it("overrides sender attribution without replacing the authorizing identity", () => {
    const client = {
      authenticatedUserProfile: {
        profileId: "owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
      internal: {
        syntheticClient: true,
        senderAttribution: { id: "alice", name: "Suggested by Alice" },
      },
    } as GatewayClient;

    expect(gatewayClientSessionCreator(client)).toEqual({
      type: "human",
      id: "owner",
      label: "Owner",
    });
    expect(gatewayClientSenderFields(client)).toEqual({
      sender: { id: "alice", name: "Suggested by Alice" },
    });
    expect(
      gatewayClientSenderFields(client, {
        id: "first.user",
        name: "First User",
        profileId: "profile-first",
      }),
    ).toEqual({
      sender: { id: "first.user", name: "First User", profileId: "profile-first" },
    });

    const attributed = gatewayClientSenderFields(client, {
      id: "first.user",
      name: "First User",
      profileId: "profile-first",
    });
    expect(buildPersistedUserTurnMessage({ text: "hello", ...attributed })).toMatchObject({
      __openclaw: {
        senderId: "first.user",
        senderName: "First User",
        senderProfileId: "profile-first",
      },
    });
  });
});
