import { describe, expect, it } from "vitest";
import { applyTrustedSenderEnv } from "./bash-tools.exec-request-preparation.js";

describe("applyTrustedSenderEnv", () => {
  it("injects exact trimmed dotted sender identity", () => {
    const env: Record<string, string> = {};
    applyTrustedSenderEnv(env, "  user.name  ");
    expect(env).toEqual({ OPENCLAW_SENDER_ID: "user.name" });
  });

  it("removes inherited spoofed values when sender identity is absent", () => {
    const env = { OpenClaw_Sender_Id: "spoofed", KEEP: "yes" };
    applyTrustedSenderEnv(env, undefined);
    expect(env).toEqual({ KEEP: "yes" });
  });

  it("keeps concurrent request env objects isolated", () => {
    const first: Record<string, string> = {};
    const second: Record<string, string> = {};
    applyTrustedSenderEnv(first, "first.user");
    applyTrustedSenderEnv(second, "second.user");
    expect(first.OPENCLAW_SENDER_ID).toBe("first.user");
    expect(second.OPENCLAW_SENDER_ID).toBe("second.user");
  });
});
