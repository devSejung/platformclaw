import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { verifyKnoxWebhook } from "./webhook-auth.js";

function request(timestamp: string, signature: string): IncomingMessage {
  return {
    headers: {
      "x-platformclaw-timestamp": timestamp,
      "x-platformclaw-signature": signature,
    },
  } as unknown as IncomingMessage;
}

describe("verifyKnoxWebhook", () => {
  it("verifies timestamp dot exact-body HMAC", () => {
    const timestamp = "1785456000000";
    const body = Buffer.from('{"text":"안녕"}', "utf8");
    const digest = createHmac("sha256", "s".repeat(32))
      .update(timestamp)
      .update(".")
      .update(body)
      .digest("hex");
    expect(
      verifyKnoxWebhook({
        req: request(timestamp, `sha256=${digest}`),
        rawBody: body,
        secret: "s".repeat(32),
        now: Number(timestamp),
      }),
    ).toBe(true);
  });

  it("rejects stale or mutated requests", () => {
    const timestamp = "1785456000000";
    const body = Buffer.from("{}", "utf8");
    const digest = createHmac("sha256", "s".repeat(32))
      .update(timestamp)
      .update(".")
      .update(body)
      .digest("hex");
    expect(
      verifyKnoxWebhook({
        req: request(timestamp, `sha256=${digest}`),
        rawBody: Buffer.from('{"x":1}'),
        secret: "s".repeat(32),
        now: Number(timestamp),
      }),
    ).toBe(false);
    expect(
      verifyKnoxWebhook({
        req: request(timestamp, `sha256=${digest}`),
        rawBody: body,
        secret: "s".repeat(32),
        now: Number(timestamp) + 300_001,
      }),
    ).toBe(false);
  });
});
