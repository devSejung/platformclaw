import type { IncomingMessage, ServerResponse } from "node:http";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readPlatformClawSessionCookie } from "./browser-auth-http.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import { readBrowserJsonBody, sendBrowserJson as sendJson } from "./browser-http-shared.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { PlatformClawBrowserGatewayPolicy } from "./web-ingress-contracts.js";

const PATH = "/platformclaw/api/composer-predictions";

// Only text already authorized by the browser session policy crosses this boundary.
// Tool output, reasoning, attachments, and personal memory never become prediction context.
function conversationText(history: unknown) {
  const messages = asRecord(history)?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .flatMap((value) => {
      const message = asRecord(value);
      if (!message || (message.role !== "user" && message.role !== "assistant")) {
        return [];
      }
      const content =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .flatMap((contentBlock) => {
                  const block = asRecord(contentBlock);
                  return block?.type === "text" && typeof block.text === "string"
                    ? [block.text]
                    : [];
                })
                .join("\n")
            : "";
      return content.trim()
        ? [{ role: message.role, content: Array.from(content).slice(0, 300).join("") }]
        : [];
    })
    .slice(-6);
}

export function createBrowserComposerHandler(options: {
  gatewayProxy: PlatformClawBrowserGatewayPolicy;
  adminRpc: GatewayAdminRpc;
  isOriginAllowed(req: IncomingMessage): boolean;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== PATH) {
      return false;
    }
    const sendBrowserJson = (response: ServerResponse, status: number, body: unknown) => {
      if (!response.destroyed && !response.writableEnded) {
        sendJson(response, status, body);
      }
    };
    if (!options.isOriginAllowed(req)) {
      sendBrowserJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendBrowserJson(res, 405, { error: "POST required" });
      return true;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const startedAt = performance.now();
    const expire = () => {
      cancel();
      sendBrowserJson(res, 200, { text: null });
    };
    // Settings lookup stays bounded until the Gateway supplies its prediction budget.
    let timer = setTimeout(expire, 10_000);
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      const token = readPlatformClawSessionCookie(req);
      if (!token) {
        sendBrowserJson(res, 401, { error: "active browser session required" });
        return true;
      }
      const access = await options.gatewayProxy.resolveAccess(token, false);
      const body = await readBrowserJsonBody(req, 2048);
      const params = body.ok ? asRecord(body.value) : null;
      if (
        !params ||
        Object.keys(params).some((key) => !["action", "enabled", "sessionKey"].includes(key))
      ) {
        sendBrowserJson(res, 400, { error: "invalid composer request" });
        return true;
      }
      const signal = controller.signal;
      signal.throwIfAborted();
      const userId = access.user.id;
      if (params.action === "preferences") {
        if (params.enabled !== undefined && typeof params.enabled !== "boolean") {
          sendBrowserJson(res, 400, { error: "invalid preference" });
          return true;
        }
        const result = await options.adminRpc.call(
          "platformclaw.composer",
          {
            action: "preferences",
            userId,
            ...(typeof params.enabled === "boolean" ? { enabled: params.enabled } : {}),
          },
          signal,
        );
        await options.gatewayProxy.resolveAccess(token, false);
        sendBrowserJson(res, 200, result);
        return true;
      }
      if (
        params.action !== "predict" ||
        typeof params.sessionKey !== "string" ||
        params.sessionKey.length > 512
      ) {
        sendBrowserJson(res, 400, { error: "invalid prediction request" });
        return true;
      }
      const preference = await options.adminRpc.call<{
        available: boolean;
        enabled: boolean;
        timeoutMs: number;
      }>("platformclaw.composer", { action: "preferences", userId }, signal);
      if (!preference.available || !preference.enabled) {
        sendBrowserJson(res, 200, { text: null });
        return true;
      }
      signal.throwIfAborted();
      clearTimeout(timer);
      // Include authentication/settings time; nested transports must not restart the budget.
      const remainingMs = preference.timeoutMs - (performance.now() - startedAt);
      if (remainingMs <= 0) {
        expire();
        return true;
      }
      timer = setTimeout(expire, remainingMs);
      const sessionKey = params.sessionKey;
      const load = async () =>
        conversationText(
          await options.gatewayProxy.request(token, "chat.history", {
            sessionKey,
            limit: 12,
            maxChars: 2000,
          }),
        );
      const messages = await load();
      signal.throwIfAborted();
      if (
        messages.at(-1)?.role !== "assistant" ||
        !messages.some((message) => message.role === "user")
      ) {
        sendBrowserJson(res, 200, { text: null });
        return true;
      }
      const result = await options.adminRpc.call(
        "platformclaw.composer",
        { action: "predict", userId, messages },
        signal,
        { timeoutMs: preference.timeoutMs },
      );
      // Recheck ACL and the authoritative transcript after inference, including Space membership.
      const current = await load();
      signal.throwIfAborted();
      sendBrowserJson(
        res,
        200,
        JSON.stringify(current) === JSON.stringify(messages) ? result : { text: null },
      );
    } catch (error) {
      const status =
        error instanceof BrowserGatewayProxyError
          ? error.code === "unauthenticated"
            ? 401
            : 403
          : 200;
      sendBrowserJson(res, status, { text: null });
    } finally {
      clearTimeout(timer);
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
    return true;
  };
}
