import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { createKnoxIngress } from "./ingress.js";
import { normalizeKnoxInbound } from "./normalize.js";
import type { ResolvedKnoxAccount } from "./types.js";
import { verifyKnoxWebhook } from "./webhook-auth.js";

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 5_000;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function createKnoxWebhookHandler(options: {
  account: ResolvedKnoxAccount;
  admit: ReturnType<typeof createKnoxIngress>["admit"];
  log?: { warn?: (message: string) => void; error?: (message: string) => void };
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    const contentType = req.headers["content-type"];
    const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType;
    if (!contentTypeValue?.toLowerCase().startsWith("application/json")) {
      sendJson(res, 415, { ok: false, error: "unsupported_media_type" });
      return;
    }
    let rawText: string;
    try {
      rawText = await readRequestBodyWithLimit(req, {
        maxBytes: MAX_BODY_BYTES,
        timeoutMs: BODY_TIMEOUT_MS,
      });
    } catch (error) {
      const statusCode = isRequestBodyLimitError(error) ? error.statusCode : 400;
      sendJson(res, statusCode, { ok: false, error: "invalid_request_body" });
      return;
    }
    const rawBody = Buffer.from(rawText, "utf8");
    if (
      !verifyKnoxWebhook({
        req,
        rawBody,
        secret: options.account.webhookSecret,
      })
    ) {
      sendJson(res, 401, { ok: false, error: "invalid_signature" });
      return;
    }
    let message;
    try {
      message = normalizeKnoxInbound(JSON.parse(rawText) as unknown);
    } catch (error) {
      options.log?.warn?.(`Invalid Knox inbound payload: ${String(error)}`);
      sendJson(res, 400, { ok: false, error: "invalid_payload" });
      return;
    }
    try {
      const admitted = await options.admit(message);
      sendJson(res, admitted.duplicate ? 200 : 202, {
        ok: true,
        accepted: true,
        duplicate: admitted.duplicate,
        eventId: message.eventId,
        messageId: message.messageId,
      });
    } catch (error) {
      options.log?.error?.(`Knox durable admission failed: ${String(error)}`);
      sendJson(res, 503, { ok: false, error: "admission_unavailable" });
    }
  };
}
