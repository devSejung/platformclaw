import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const KNOX_WEBHOOK_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function verifyKnoxWebhook(params: {
  req: IncomingMessage;
  rawBody: Buffer;
  secret: string;
  now?: number;
}): boolean {
  const timestamp = header(params.req, "x-platformclaw-timestamp");
  const signature = header(params.req, "x-platformclaw-signature");
  if (!/^\d{13}$/u.test(timestamp) || !/^sha256=[0-9a-f]{64}$/u.test(signature)) {
    return false;
  }
  const timestampMs = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs((params.now ?? Date.now()) - timestampMs) > KNOX_WEBHOOK_CLOCK_SKEW_MS
  ) {
    return false;
  }
  const expected = createHmac("sha256", params.secret)
    .update(timestamp, "utf8")
    .update(".", "utf8")
    .update(params.rawBody)
    .digest("hex");
  const actualBuffer = Buffer.from(signature.slice("sha256=".length), "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
