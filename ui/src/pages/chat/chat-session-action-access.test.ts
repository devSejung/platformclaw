import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";

function snapshot(params: {
  methods: string[];
  scopes: string[];
  capabilities?: string[];
}): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  return {
    client: {} as ApplicationGatewaySnapshot["client"],
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes: params.scopes },
      features: { methods: params.methods, capabilities: params.capabilities },
    } as ApplicationGatewaySnapshot["hello"],
  };
}

describe("readChatSessionActionAccess", () => {
  const methods = [
    "sessions.compact",
    "chat.abort",
    "sessions.abort",
    "sessions.rewind",
    "sessions.fork",
    "sessions.reset",
    "sessions.branches.switch",
  ];

  it("maps write and admin actions to their exact scopes", () => {
    const write = readChatSessionActionAccess(
      snapshot({ methods, scopes: ["operator.write"] }),
      true,
    );
    expect(write.abort.allowed).toBe(true);
    expect(write.fork.allowed).toBe(true);
    expect(write.compact.allowed).toBe(false);
    expect(write.rewind.allowed).toBe(false);
    expect(write.reset.allowed).toBe(false);
    expect(write.branchSwitch.allowed).toBe(false);

    const admin = readChatSessionActionAccess(
      snapshot({ methods, scopes: ["operator.admin"] }),
      true,
    );
    expect(Object.values(admin).every((access) => access.allowed)).toBe(true);
  });

  it("selects the active-run abort method and rejects explicit method absence", () => {
    expect(
      readChatSessionActionAccess(
        snapshot({ methods: ["chat.abort"], scopes: ["operator.write"] }),
        true,
      ).abort.allowed,
    ).toBe(true);
    expect(
      readChatSessionActionAccess(
        snapshot({ methods: ["chat.abort"], scopes: ["operator.write"] }),
        false,
      ).abort,
    ).toMatchObject({ allowed: false, cause: "method-unavailable" });
  });

  it("allows BFF-authorized owned session actions without granting admin scope", () => {
    const access = readChatSessionActionAccess(
      snapshot({
        methods,
        scopes: ["operator.read", "operator.write"],
        capabilities: ["control-ui.server-authorized-methods"],
      }),
      false,
    );

    expect(access.compact.allowed).toBe(true);
    expect(access.rewind.allowed).toBe(true);
    expect(access.reset.allowed).toBe(true);
    expect(access.branchSwitch.allowed).toBe(true);
  });
});
