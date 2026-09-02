import { describe, expect, it } from "vitest";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import {
  gatewayClientSenderFields,
  gatewayClientSessionCreator,
} from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

describe("gateway client identity", () => {
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
