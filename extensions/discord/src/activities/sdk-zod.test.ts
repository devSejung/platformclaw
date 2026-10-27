// @vitest-environment jsdom
// The SDK captures allowed browser origins during module evaluation.
import { Common, DiscordSDK, Responses } from "@discord/embedded-app-sdk";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Discord Activity SDK Zod contract", () => {
  it("retains typed authorization results and unknown enum fallbacks", () => {
    expectTypeOf<Awaited<ReturnType<DiscordSDK["commands"]["authorize"]>>>().toEqualTypeOf<{
      code: string;
    }>();
    expect(Responses.AuthorizeResponse.parse({ code: "synthetic-code" })).toEqual({
      code: "synthetic-code",
    });
    expect(Common.Scopes.parse("identify")).toBe("identify");
    expect(Common.Scopes.parse("future-discord-scope")).toBe(-1);
    expect(Common.Scopes.safeParse(null).success).toBe(false);
    expect(Responses.AuthorizeResponse.safeParse({ code: 7 }).success).toBe(false);
  });

  it("runs the real SDK handshake, authorize, and authenticate validators", async () => {
    const sent: unknown[][] = [];
    let receive: ((event: { origin: string; data: unknown }) => void) | undefined;
    const parent = { postMessage: (message: unknown[]) => sent.push(message) };
    vi.stubGlobal("document", { referrer: "https://discord.com" });
    vi.stubGlobal("window", {
      parent,
      location: {
        origin: "https://activity.example",
        search: "?frame_id=frame&instance_id=instance&platform=desktop",
      },
      addEventListener: (_event: string, listener: typeof receive) => {
        receive = listener;
      },
      removeEventListener: vi.fn(),
    });
    const sdk = new DiscordSDK("123456789", { disableConsoleLogOverride: true });
    const dispatch = (data: unknown) =>
      receive?.({ origin: "https://discord.com", data: [1, data] });
    const reply = (data: unknown) => {
      const frame = sent.at(-1)?.[1] as { cmd: string; nonce: string };
      dispatch({ cmd: frame.cmd, nonce: frame.nonce, evt: null, data });
    };
    expect(sent[0]).toEqual([
      0,
      expect.objectContaining({ client_id: "123456789", frame_id: "frame", v: 1 }),
    ]);
    const ready = sdk.ready();
    dispatch({
      cmd: "DISPATCH",
      evt: "READY",
      nonce: null,
      data: { v: 1, config: { api_endpoint: "//discord.com/api", environment: "production" } },
    });
    await ready;
    const authorize = sdk.commands.authorize({
      client_id: "123456789",
      response_type: "code",
      scope: ["identify"],
    });
    reply({ code: "synthetic-code" });
    await expect(authorize).resolves.toEqual({ code: "synthetic-code" });

    const authenticate = sdk.commands.authenticate({ access_token: "synthetic-token" });
    reply({
      access_token: "synthetic-token",
      user: { id: "1", username: "test", discriminator: "0001", public_flags: 0 },
      scopes: ["identify", "future-discord-scope"],
      expires: "2099-01-01T00:00:00Z",
      application: { id: "123456789", name: "test", description: "test", icon: null },
    });
    await expect(authenticate).resolves.toMatchObject({ scopes: ["identify", -1] });

    const malformed = sdk.commands.authorize({
      client_id: "123456789",
      response_type: "code",
      scope: ["identify"],
    });
    // Discord's transport records invalid frames and retains the pending nonce
    // for a later valid reply; the dependency migration must preserve that flow.
    const parseError = vi.spyOn(console, "error").mockImplementation(() => {});
    reply({ code: 42 });
    expect(parseError).toHaveBeenCalledWith("Failed to parse", expect.anything());
    reply({ code: "validated-code" });
    await expect(malformed).resolves.toEqual({ code: "validated-code" });
    sdk.close(1000, "synthetic test complete");
  });
});
