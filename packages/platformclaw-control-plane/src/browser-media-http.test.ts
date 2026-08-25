import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
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

    query.set("sessionKey", "agent:employee-one:other");
    const replay = await fetch(
      `${runtime.origin}/platformclaw/app/__openclaw__/assistant-media?${query}`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(replay.status).toBe(404);
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
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
        headers: { "Content-Range": "bytes 0-12/13", "Content-Type": "application/pdf" },
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
});
