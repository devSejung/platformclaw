// Covers outbound identity normalization and configured agent identity/avatar
// projection.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentIdentityMock = vi.hoisted(() => vi.fn());
const resolveAgentAvatarMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/identity.js", () => ({
  resolveAgentIdentity: (...args: unknown[]) => resolveAgentIdentityMock(...args),
}));

vi.mock("../../agents/identity-avatar.js", () => ({
  resolveAgentAvatar: (...args: unknown[]) => resolveAgentAvatarMock(...args),
}));

type IdentityModule = typeof import("./identity.js");

let resolveAgentOutboundIdentity: IdentityModule["resolveAgentOutboundIdentity"];

beforeAll(async () => {
  ({ resolveAgentOutboundIdentity } = await import("./identity.js"));
});

beforeEach(() => {
  resolveAgentIdentityMock.mockReset();
  resolveAgentAvatarMock.mockReset();
});

describe("configured outbound identity normalization", () => {
  it.each([
    {
      input: {
        name: "  Demo Bot  ",
        avatarUrl: " https://example.com/a.png ",
        emoji: "  🤖  ",
        theme: "  ocean  ",
      },
      expected: {
        name: "Demo Bot",
        avatarUrl: "https://example.com/a.png",
        emoji: "🤖",
        theme: "ocean",
      },
    },
    {
      input: {
        name: "  ",
        avatarUrl: "\n",
        emoji: "",
      },
      expected: undefined,
    },
  ])("normalizes outbound identity for %j", ({ input, expected }) => {
    resolveAgentIdentityMock.mockReturnValueOnce(input);
    resolveAgentAvatarMock.mockReturnValueOnce({ kind: "remote", url: input.avatarUrl });
    expect(resolveAgentOutboundIdentity({}, "main")).toEqual(expected);
  });
});

describe("resolveAgentOutboundIdentity", () => {
  it.each([
    {
      identity: {
        name: "  Agent Smith  ",
        emoji: "  🕶️  ",
        theme: "  noir  ",
      },
      avatar: {
        kind: "remote",
        url: "https://example.com/avatar.png",
      },
      expected: {
        name: "Agent Smith",
        emoji: "🕶️",
        avatarUrl: "https://example.com/avatar.png",
        theme: "noir",
      },
    },
    {
      identity: {
        name: "   ",
        emoji: "",
      },
      avatar: {
        kind: "data",
        dataUrl: "data:image/png;base64,abc",
      },
      expected: undefined,
    },
    {
      identity: {
        name: "  Agent Smith  ",
        emoji: "  🕶️  ",
      },
      avatar: {
        kind: "remote",
        url: "   ",
      },
      expected: {
        name: "Agent Smith",
        emoji: "🕶️",
      },
    },
  ])("resolves outbound identity for %j", ({ identity, avatar, expected }) => {
    resolveAgentIdentityMock.mockReturnValueOnce(identity);
    resolveAgentAvatarMock.mockReturnValueOnce(avatar);
    expect(resolveAgentOutboundIdentity({} as never, "main")).toEqual(expected);
  });
});
