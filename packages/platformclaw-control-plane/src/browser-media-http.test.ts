import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { createDeferred } from "../../../src/shared/deferred.js";
import {
  PlatformClawBrowserMediaRelay,
  type PlatformClawBrowserMediaPolicy,
} from "./browser-media-http.js";

const SESSION_COOKIE = "platformclaw_session=browser-token";
const OWN_SESSION = "agent:employee-one:main";
const SOURCE = "media://inbound/upload-1";

function resolveAgentIdFromSessionKey(sessionKey: string): string | null {
  return /^agent:([^:]+):/u.exec(sessionKey)?.[1] ?? null;
}

async function listen(
  relay: PlatformClawBrowserMediaRelay,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    void relay.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function createPolicy(history: unknown): PlatformClawBrowserMediaPolicy & {
  requestMock: Mock<(token: string, method: string, params?: unknown) => Promise<unknown>>;
} {
  const requestMock = vi.fn(
    async (_token: string, _method: string, _params?: unknown): Promise<unknown> => history,
  );
  return {
    resolveAccess: vi.fn(async () => ({ binding: { agentId: "employee-one" } })),
    request: async <T = unknown>(token: string, method: string, params?: unknown) =>
      (await requestMock(token, method, params)) as T,
    requestMock,
  };
}

describe("PlatformClaw browser media relay", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("mints a session-bound ticket and streams an owned inbound upload", async () => {
    const policy = createPolicy({
      sessionKey: OWN_SESSION,
      messages: [
        {
          role: "user",
          __openclaw: { media: [{ url: SOURCE, path: "/state/media/upload-1.pdf" }] },
        },
      ],
    });
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      expect(init?.headers).not.toEqual(expect.objectContaining({ Cookie: expect.anything() }));
      expect(new Headers(init?.headers).get("x-openclaw-agent-id")).toBe("employee-one");
      if (url.searchParams.get("meta") === "1") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-secret");
        return Response.json({
          available: true,
          mimeType: "application/pdf",
          mediaTicket: "upstream-ticket-must-not-escape",
        });
      }
      expect(url.searchParams.get("mediaTicket")).toBeNull();
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-secret");
      return new Response("owned-bytes", {
        headers: {
          "Content-Disposition": 'inline; filename="upload.pdf"',
          "Content-Type": "application/pdf",
          "Cache-Control": "private, max-age=31536000, immutable",
          "Set-Cookie": "gateway-secret=must-not-escape",
        },
      });
    }) as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
      now: () => 1_000,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const query = new URLSearchParams({ source: SOURCE, sessionKey: OWN_SESSION, meta: "1" });
    const meta = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE, "X-OpenClaw-Agent-Id": "employee-two" } },
    );
    expect(meta.status).toBe(200);
    const payload = (await meta.json()) as { mediaTicket: string; mediaTicketExpiresAt: string };
    expect(payload.mediaTicket).toMatch(/^v1\./u);
    expect(payload.mediaTicket).not.toContain("upstream-ticket");
    expect(payload.mediaTicketExpiresAt).toBe(new Date(301_000).toISOString());
    expect(policy.requestMock).toHaveBeenCalledWith("browser-token", "chat.history", {
      sessionKey: OWN_SESSION,
      limit: 1000,
      maxChars: 500_000,
    });

    query.delete("meta");
    query.set("mediaTicket", payload.mediaTicket);
    const bytes = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE, "X-OpenClaw-Agent-Id": "employee-two" } },
    );
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("owned-bytes");
    expect(bytes.headers.get("content-disposition")).toBe('inline; filename="upload.pdf"');
    expect(bytes.headers.get("set-cookie")).toBeNull();
    expect(bytes.headers.get("cache-control")).toBe("no-store");

    query.set("sessionKey", "agent:employee-one:other");
    const replay = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(replay.status).toBe(404);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it("authorizes a freshly persisted upload by its exact transcript message", async () => {
    const messageId = "upload-message-1";
    const message = {
      role: "user",
      __openclaw: {
        id: messageId,
        media: [{ url: SOURCE, path: "/state/media/upload-1.pdf" }],
      },
    };
    const policy = createPolicy(null);
    policy.requestMock.mockImplementation(async (_token, method) => {
      if (method === "chat.message.get") {
        return { ok: true, message };
      }
      throw new Error("broad history must not be queried");
    });
    const upstreamFetch = vi.fn(async () =>
      Response.json({ available: true, mimeType: "application/pdf" }),
    ) as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const query = new URLSearchParams({
      source: SOURCE,
      sessionKey: OWN_SESSION,
      messageId,
      meta: "1",
    });
    const metadata = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );

    expect(metadata.status).toBe(200);
    expect(policy.requestMock).toHaveBeenCalledTimes(1);
    expect(policy.requestMock).toHaveBeenCalledWith("browser-token", "chat.message.get", {
      sessionKey: OWN_SESSION,
      messageId,
      maxChars: 500_000,
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);

    policy.requestMock.mockResolvedValue({ ok: false, unavailableReason: "not_found" });
    const missing = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(missing.status).toBe(404);
    expect(policy.requestMock).toHaveBeenCalledTimes(2);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("serves an assistant attachment only when its inbound claim-check belongs to the user", async () => {
    const source = "media://inbound/report---123.pdf";
    const privatePath = "/srv/private/media/inbound/report---123.pdf";
    const policy = createPolicy({
      sessionKey: OWN_SESSION,
      messages: [
        {
          role: "user",
          __openclaw: { media: [{ path: privatePath, url: source, fileName: "report.pdf" }] },
        },
        {
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: { kind: "document", label: "report.pdf", url: source },
            },
          ],
        },
      ],
    });
    const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      expect(url.searchParams.get("source")).toBe(source);
      return url.searchParams.get("meta") === "1"
        ? Response.json({ available: true, mimeType: "application/pdf" })
        : new Response("owned-file");
    }) as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const query = new URLSearchParams({ source, sessionKey: OWN_SESSION, meta: "1" });
    const metadata = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(metadata.status).toBe(200);
    const { mediaTicket } = (await metadata.json()) as { mediaTicket: string };

    query.delete("meta");
    query.set("mediaTicket", mediaTicket);
    const downloaded = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(await downloaded.text()).toBe("owned-file");

    query.set("source", "/srv/private/media/inbound/other-employee.pdf");
    query.set("meta", "1");
    expect(
      await fetch(`${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`, {
        headers: { Cookie: SESSION_COOKIE },
      }),
    ).toMatchObject({ status: 404 });
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["image/png", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"])(
    "reopens an older %s attachment by its persisted message identity",
    async (contentType) => {
      const messageId = "older-upload-message";
      const message = {
        role: "user",
        __openclaw: { id: messageId, media: [{ url: SOURCE, contentType }] },
      };
      const policy = createPolicy({ messages: [], hasMore: true, nextOffset: 1000 });
      policy.requestMock.mockImplementation(async (_token, method, params) =>
        method === "chat.message.get" && (params as { messageId?: string }).messageId === messageId
          ? { ok: true, message }
          : { messages: [], hasMore: true, nextOffset: 1000 },
      );
      const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.searchParams.get("meta") === "1"
          ? Response.json({ available: true, mimeType: contentType })
          : new Response("persisted-upload", { headers: { "Content-Type": contentType } });
      }) as typeof fetch;
      const relay = new PlatformClawBrowserMediaRelay({
        gatewayOrigin: "http://private-gateway.invalid",
        gatewayAuth: "service-secret",
        gatewayProxy: policy,
        resolveAgentIdFromSessionKey,
        fetchImpl: upstreamFetch,
      });
      const runtime = await listen(relay);
      servers.push(runtime.server);
      const query = new URLSearchParams({
        source: SOURCE,
        sessionKey: OWN_SESSION,
        messageId,
        meta: "1",
      });
      const metadata = await fetch(
        `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
        {
          headers: { Cookie: SESSION_COOKIE },
        },
      );
      expect(metadata.status).toBe(200);
      const { mediaTicket } = (await metadata.json()) as { mediaTicket: string };
      expect(policy.requestMock).toHaveBeenCalledExactlyOnceWith(
        "browser-token",
        "chat.message.get",
        {
          sessionKey: OWN_SESSION,
          messageId,
          maxChars: 500_000,
        },
      );
      query.delete("meta");
      query.delete("messageId");
      query.set("mediaTicket", mediaTicket);
      const downloaded = await fetch(
        `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
        {
          headers: { Cookie: SESSION_COOKIE },
        },
      );
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe("persisted-upload");

      query.set("meta", "1");
      query.set("messageId", "missing-message");
      const missing = await fetch(
        `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
        {
          headers: { Cookie: SESSION_COOKIE },
        },
      );
      expect(missing.status).toBe(404);
      expect(policy.requestMock).toHaveBeenCalledTimes(2);
      expect(upstreamFetch).toHaveBeenCalledTimes(2);
    },
  );

  it("fails closed before Gateway media fetch for foreign or unproven sources", async () => {
    const policy = createPolicy({
      sessionKey: OWN_SESSION,
      messages: [{ role: "assistant", content: [{ type: "text", text: `MEDIA:${SOURCE}` }] }],
    });
    const upstreamFetch = vi.fn() as unknown as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const foreign = new URLSearchParams({
      source: SOURCE,
      sessionKey: "agent:employee-two:main",
      meta: "1",
    });
    expect(
      await fetch(`${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${foreign}`, {
        headers: { Cookie: SESSION_COOKIE },
      }),
    ).toMatchObject({ status: 404 });
    const unproven = new URLSearchParams({ source: SOURCE, sessionKey: OWN_SESSION, meta: "1" });
    expect(
      await fetch(`${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${unproven}`, {
        headers: { Cookie: SESSION_COOKIE },
      }),
    ).toMatchObject({ status: 404 });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "assistant-generated PDF attachment",
      source: "/srv/personal/workspace/report.pdf",
      message: {
        role: "assistant",
        content: [
          {
            type: "attachment",
            url: "/srv/personal/workspace/report.pdf",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            attachment: {
              kind: "document",
              label: "report.pdf",
              mimeType: "application/pdf",
              url: "/srv/personal/workspace/report.pdf",
            },
          },
        ],
      },
    },
    {
      name: "assistant-generated HTML attachment",
      source: "file:///srv/personal/workspace/index.html",
      message: {
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: "index.html",
              mimeType: "text/html",
              url: "file:///srv/personal/workspace/index.html",
            },
          },
        ],
      },
    },
    {
      name: "assistant persisted media fact",
      source: "/srv/personal/workspace/generated.csv",
      message: {
        role: "assistant",
        __openclaw: { media: [{ path: "/srv/personal/workspace/generated.csv" }] },
      },
    },
    {
      name: "typed assistant audio source",
      source: "/srv/personal/workspace/voice.ogg",
      message: {
        role: "assistant",
        content: [{ type: "audio", source: { url: "/srv/personal/workspace/voice.ogg" } }],
      },
    },
    {
      name: "typed assistant image source",
      source: "/srv/personal/workspace/diagram.png",
      message: {
        role: "assistant",
        content: [{ type: "image", url: "/srv/personal/workspace/diagram.png" }],
      },
    },
    {
      name: "typed assistant video source",
      source: "/srv/personal/workspace/preview.mp4",
      message: {
        role: "assistant",
        content: [{ type: "video", path: "/srv/personal/workspace/preview.mp4" }],
      },
    },
    {
      name: "typed assistant file source",
      source: "/srv/personal/workspace/export.json",
      message: {
        role: "assistant",
        content: [{ type: "file", url: "/srv/personal/workspace/export.json" }],
      },
    },
  ])("mints a same-session capability for $name", async ({ source, message }) => {
    const policy = createPolicy({ sessionKey: OWN_SESSION, messages: [message] });
    const upstreamFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      expect(url.searchParams.get("source")).toBe(source);
      expect(new Headers(init?.headers).get("x-openclaw-agent-id")).toBe("employee-one");
      return url.searchParams.get("meta") === "1"
        ? Response.json({ available: true, mimeType: "application/octet-stream" })
        : new Response("owned-generated-file");
    }) as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const query = new URLSearchParams({ source, sessionKey: OWN_SESSION, meta: "1" });
    const metadata = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(metadata.status).toBe(200);
    const { mediaTicket } = (await metadata.json()) as { mediaTicket: string };

    query.delete("meta");
    query.set("mediaTicket", mediaTicket);
    const downloaded = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(await downloaded.text()).toBe("owned-generated-file");

    query.set("source", "/srv/personal/workspace/another-file.pdf");
    expect(
      await fetch(`${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`, {
        headers: { Cookie: SESSION_COOKIE },
      }),
    ).toMatchObject({ status: 404 });
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "assistant text-only path",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "MEDIA:/srv/personal/workspace/secret.pdf" }],
      },
    },
    {
      name: "assistant untyped tool payload",
      message: {
        role: "assistant",
        content: [{ type: "tool_result", url: "/srv/personal/workspace/secret.pdf" }],
      },
    },
    {
      name: "unrelated assistant attachment",
      message: {
        role: "assistant",
        content: [
          { type: "attachment", attachment: { url: "/srv/personal/workspace/public.pdf" } },
        ],
      },
    },
    {
      name: "sensitive assistant message",
      message: {
        role: "assistant",
        sensitiveMedia: true,
        content: [{ type: "file", url: "/srv/personal/workspace/secret.pdf" }],
      },
    },
    {
      name: "sensitive assistant media block",
      message: {
        role: "assistant",
        content: [{ type: "file", url: "/srv/personal/workspace/secret.pdf", sensitive: true }],
      },
    },
    {
      name: "sensitive assistant attachment",
      message: {
        role: "assistant",
        content: [
          {
            type: "attachment",
            url: "/srv/personal/workspace/secret.pdf",
            attachment: { url: "/srv/personal/workspace/secret.pdf", sensitive: true },
          },
        ],
      },
    },
    {
      name: "sensitive persisted media fact",
      message: {
        role: "assistant",
        __openclaw: {
          media: [{ path: "/srv/personal/workspace/secret.pdf", sensitiveMedia: true }],
        },
      },
    },
    {
      name: "sensitive persisted media envelope",
      message: {
        role: "assistant",
        __openclaw: {
          sensitive: true,
          media: [{ path: "/srv/personal/workspace/secret.pdf" }],
        },
      },
    },
    {
      name: "tool-role structured media",
      message: {
        role: "tool",
        __openclaw: { media: [{ path: "/srv/personal/workspace/secret.pdf" }] },
      },
    },
  ])("never grants a download from $name", async ({ message }) => {
    const source = "/srv/personal/workspace/secret.pdf";
    const policy = createPolicy({ sessionKey: OWN_SESSION, messages: [message] });
    policy.requestMock.mockImplementation(async (_token, method) =>
      method === "chat.message.get"
        ? { ok: true, message }
        : { sessionKey: OWN_SESSION, messages: [message] },
    );
    const upstreamFetch = vi.fn() as unknown as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const query = new URLSearchParams({ source, sessionKey: OWN_SESSION, meta: "1" });
    for (const messageId of [undefined, "persisted-message"]) {
      if (messageId) {
        query.set("messageId", messageId);
      }
      const response = await fetch(
        `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
        { headers: { Cookie: SESSION_COOKIE } },
      );
      expect(response.status).toBe(404);
    }
    expect(policy.requestMock).toHaveBeenCalledTimes(2);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    "/srv/personal/workspace/../employee-two/secret.pdf",
    "/srv/personal/workspace/./secret.pdf",
    "file:///srv/personal/workspace/../employee-two/secret.pdf",
    "file:///srv/personal/workspace/%2e%2e/employee-two/secret.pdf",
    "file://remote-host/srv/personal/workspace/secret.pdf",
    "//remote-host/srv/personal/workspace/secret.pdf",
    "https://remote-host.example/secret.pdf",
    "media://inbound/..",
    "media://inbound/%2e%2e",
    "media://inbound/nested%2Fsecret.pdf",
    "media://inbound/nested%5Csecret.pdf",
  ])("rejects unsafe transcript source %s before querying history", async (source) => {
    const policy = createPolicy({
      sessionKey: OWN_SESSION,
      messages: [{ role: "assistant", content: [{ type: "file", url: source }] }],
    });
    const upstreamFetch = vi.fn() as unknown as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const query = new URLSearchParams({ source, sessionKey: OWN_SESSION, meta: "1" });
    const response = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(response.status).toBe(404);
    expect(policy.requestMock).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("relays only signed managed media for the active agent session", async () => {
    const policy = createPolicy({ messages: [] });
    const upstreamFetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response("managed-bytes", {
        status: 206,
        headers: {
          "Content-Range": "bytes 0-12/13",
          "Content-Type": "application/pdf",
          "Cache-Control": "private, max-age=300, immutable",
        },
      });
    });
    const upstreamFetch = upstreamFetchMock as typeof fetch;
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const ownPath = `/api/chat/media/outgoing/${encodeURIComponent(OWN_SESSION)}/attachment-1/full`;
    const own = await fetch(`${runtime.origin}${ownPath}?mediaTicket=signed-upstream`, {
      headers: { Cookie: SESSION_COOKIE, Range: "bytes=0-12" },
    });
    expect(own.status).toBe(206);
    expect(own.headers.get("cache-control")).toBe("no-store");
    expect(await own.text()).toBe("managed-bytes");
    const forwardedHeaders = new Headers(upstreamFetchMock.mock.calls[0]?.[1]?.headers);
    expect(forwardedHeaders.has("authorization")).toBe(false);
    expect(forwardedHeaders.has("x-openclaw-agent-id")).toBe(false);
    expect(forwardedHeaders.get("range")).toBe("bytes=0-12");
    const foreignPath = `/api/chat/media/outgoing/${encodeURIComponent("agent:employee-two:main")}/attachment-1/full`;
    const foreign = await fetch(`${runtime.origin}${foreignPath}?mediaTicket=signed-upstream`, {
      headers: { Cookie: SESSION_COOKIE },
    });
    expect(foreign.status).toBe(404);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("requires an active PlatformClaw browser cookie", async () => {
    const policy = createPolicy({ messages: [] });
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);

    const response = await fetch(
      `${runtime.origin}/api/chat/media/outgoing/${encodeURIComponent(OWN_SESSION)}/attachment-1/full?mediaTicket=signed`,
    );
    expect(response.status).toBe(401);
    expect(vi.mocked(policy.resolveAccess)).not.toHaveBeenCalled();
  });

  it("preserves an owned HTML preview's isolation policy and request identity", async () => {
    const policy = createPolicy({ messages: [] });
    const csp = "sandbox allow-scripts; default-src 'none'; script-src 'nonce-bootstrap'";
    const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      expect(url.searchParams.get("mediaTicket")).toBe("signed-upstream");
      expect(url.searchParams.get("preview")).toBe("1");
      expect(url.searchParams.get("previewNonce")).toBe("request-1234567890");
      expect(url.searchParams.get("previewMode")).toBe("strict");
      return new Response("<!doctype html><h1>Report</h1>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": "inline",
          "Content-Security-Policy": csp,
          "Set-Cookie": "private=must-not-escape",
        },
      });
    });
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      resolveAgentIdFromSessionKey,
      fetchImpl: upstreamFetch,
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);
    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(OWN_SESSION)}/attachment-1/full?mediaTicket=signed-upstream&preview=1&previewNonce=request-1234567890&previewMode=strict`;
    const response = await fetch(`${runtime.origin}${pathName}`, {
      headers: { Cookie: SESSION_COOKIE },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(csp);
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("Report");
  });

  it.each([
    { method: "HEAD", upstreamStatus: 200 },
    { method: "GET", upstreamStatus: 304 },
    { method: "GET", upstreamStatus: 404 },
    { method: "POST", upstreamStatus: 200 },
  ])("prevents cached media for $method and upstream $upstreamStatus", async (scenario) => {
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: createPolicy({ messages: [] }),
      resolveAgentIdFromSessionKey,
      fetchImpl: vi.fn(
        async () =>
          new Response(null, {
            status: scenario.upstreamStatus,
            headers: { "Cache-Control": "private, max-age=300, immutable" },
          }),
      ),
    });
    const runtime = await listen(relay);
    servers.push(runtime.server);
    const response = await fetch(
      `${runtime.origin}/api/chat/media/outgoing/${encodeURIComponent(OWN_SESSION)}/attachment-1/full?mediaTicket=signed`,
      { method: scenario.method, headers: { Cookie: SESSION_COOKIE } },
    );
    expect(response.status).toBe(scenario.method === "POST" ? 405 : scenario.upstreamStatus);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(
    ["metadata-proof", "metadata-upstream", "assistant-bytes", "managed-bytes"].flatMap((phase) =>
      ["revoked", "reassigned"].map((change) => ({ phase, change })),
    ),
  )("rejects $change authority while $phase is pending", async ({ phase, change }) => {
    let reachedPending!: () => void;
    let finishPending!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedPending = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishPending = resolve;
    });
    const pause = async () => {
      reachedPending();
      await pending;
    };
    let currentAgent: string | null = "employee-one";
    const policy = createPolicy({
      messages: [{ role: "assistant", content: [{ type: "attachment", url: SOURCE }] }],
    });
    vi.mocked(policy.resolveAccess).mockImplementation(async () => {
      if (!currentAgent) {
        throw new Error("synthetic session revoked");
      }
      return { binding: { agentId: currentAgent } };
    });
    policy.requestMock.mockImplementation(async () => {
      if (phase === "metadata-proof") {
        await pause();
      }
      return { messages: [{ role: "assistant", content: [{ type: "attachment", url: SOURCE }] }] };
    });
    const upstreamFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.searchParams.get("meta") === "1") {
        if (phase === "metadata-upstream") {
          await pause();
        }
        return Response.json({ available: true, mimeType: "application/pdf" });
      }
      await pause();
      return new Response("must-not-escape");
    });
    const runtime = await listen(
      new PlatformClawBrowserMediaRelay({
        gatewayOrigin: "http://private-gateway.invalid",
        gatewayAuth: "service-secret",
        gatewayProxy: policy,
        resolveAgentIdFromSessionKey,
        fetchImpl: upstreamFetch,
      }),
    );
    servers.push(runtime.server);
    const query = new URLSearchParams({ source: SOURCE, sessionKey: OWN_SESSION, meta: "1" });
    let url = `${runtime.origin}/__openclaw__/assistant-media?${query}`;
    if (phase === "managed-bytes") {
      url = `${runtime.origin}/api/chat/media/outgoing/${encodeURIComponent(OWN_SESSION)}/attachment-1/full?mediaTicket=signed`;
    } else if (phase === "assistant-bytes") {
      const meta = await fetch(url, { headers: { Cookie: SESSION_COOKIE } });
      const ticket = (await meta.json()) as { mediaTicket: string };
      query.delete("meta");
      query.set("mediaTicket", ticket.mediaTicket);
      url = `${runtime.origin}/__openclaw__/assistant-media?${query}`;
    }
    const operation = fetch(url, { headers: { Cookie: SESSION_COOKIE } });
    await reached;
    currentAgent = change === "revoked" ? null : "employee-two";
    finishPending();
    const response = await operation;
    expect(response.status).toBe(change === "revoked" ? 401 : 404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain("must-not-escape");
    expect(body).not.toContain("mediaTicket");
    if (phase === "metadata-proof") {
      expect(upstreamFetch).not.toHaveBeenCalled();
    }
  });
  it.each(["revoked", "reassigned"] as const)(
    "rejects %s access after headers but before the first streamed byte",
    async (change) => {
      const bodyPending = createDeferred();
      const headersChecked = createDeferred();
      const releaseBody = createDeferred();
      let owner: string | null = "employee-one";
      let checks = 0;
      const policy = createPolicy({ messages: [] });
      vi.mocked(policy.resolveAccess).mockImplementation(async () => {
        const checkedOwner = owner;
        if (++checks === 2) {
          headersChecked.resolve();
        }
        if (!checkedOwner) {
          throw new Error("session revoked");
        }
        return { binding: { agentId: checkedOwner } };
      });
      const runtime = await listen(
        new PlatformClawBrowserMediaRelay({
          gatewayOrigin: "http://private-gateway.invalid",
          gatewayAuth: "service-secret",
          gatewayProxy: policy,
          resolveAgentIdFromSessionKey,
          fetchImpl: vi.fn(
            async () =>
              new Response(
                new ReadableStream({
                  async pull(controller) {
                    bodyPending.resolve();
                    await releaseBody.promise;
                    controller.enqueue(new TextEncoder().encode("must-not-escape"));
                    controller.close();
                  },
                }),
                {
                  headers: {
                    "Content-Type": "application/pdf",
                    "Content-Length": "15",
                    "Content-Disposition": "attachment; filename=private.pdf",
                  },
                },
              ),
          ),
        }),
      );
      servers.push(runtime.server);
      const pending = fetch(
        `${runtime.origin}/api/chat/media/outgoing/${encodeURIComponent(OWN_SESSION)}/attachment-1/full?mediaTicket=signed`,
        { headers: { Cookie: SESSION_COOKIE } },
      );
      await Promise.all([bodyPending.promise, headersChecked.promise]);
      owner = change === "revoked" ? null : "employee-two";
      releaseBody.resolve();
      const response = await pending;
      expect(response.status).toBe(change === "revoked" ? 401 : 404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("must-not-escape");
    },
  );
});
