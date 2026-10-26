import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import {
  setupBrowserGatewayProxyTest as setup,
  NOW,
} from "./browser-gateway-proxy.test-harness.js";
import {
  PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
  PLATFORMCLAW_TALK_OFFER_PREFIX,
} from "./browser-gateway-talk-policy.js";
import { PlatformClawBrowserTalkRelay } from "./browser-talk-http.js";

const SDP_OFFER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Talk test\r\nt=0 0\r\n";
const SDP_ANSWER = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=Talk answer\r\nt=0 0\r\n";
const TICKET = "12345678-1234-1234-1234-123456789abc";

describe("browser Talk SDP relay", () => {
  const servers: Server[] = [];
  const cleanup: Array<() => Promise<void>> = [];

  async function listen(server: Server): Promise<string> {
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(async (close) => await close()));
    await Promise.all(
      servers.splice(0).map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }),
    );
  });

  it("relays one authenticated leased offer without forwarding browser credentials or headers", async () => {
    const { proxy, token, request, binding } = await setup();
    proxy.registerBrowserConnection("web-1", await proxy.resolveAccess(token, false));
    cleanup.push(async () => await proxy.releaseBrowserConnection("web-1"));
    const upstreamRequests: Array<{
      url: string | undefined;
      auth: string | undefined;
      cookie: string | undefined;
      origin: string | undefined;
      body: string;
    }> = [];
    const upstreamOrigin = await listen(
      createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          upstreamRequests.push({
            url: req.url,
            auth: req.headers.authorization,
            cookie: req.headers.cookie,
            origin: req.headers.origin,
            body: Buffer.concat(chunks).toString(),
          });
          res.setHeader("Content-Type", "application/sdp");
          res.setHeader("Set-Cookie", "private-cookie=must-not-escape");
          res.end(SDP_ANSWER);
        })();
      }),
    );
    const publicOrigin = await listen(
      createServer((req, res) => {
        void relay.handle(req, res).then((handled) => {
          if (!handled) {
            res.writeHead(404).end();
          }
        });
      }),
    );
    const relay = new PlatformClawBrowserTalkRelay({
      publicOrigin,
      gatewayOrigin: upstreamOrigin,
      gatewayProxy: proxy,
    });
    request.mockResolvedValueOnce({
      provider: "openai",
      transport: "webrtc",
      voiceSessionId: "voice-offer-1",
      clientSecret: "test-ephemeral-token",
      offerUrl: PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
      expiresAt: NOW + 60_000,
    });
    const created = await proxy.request<{ offerUrl: string }>(
      token,
      "talk.client.create",
      {
        sessionKey: `agent:${binding.agentId}:main`,
      },
      { connectionId: "web-1" },
    );
    const headers = {
      Cookie: `platformclaw_session=${token}`,
      Origin: publicOrigin,
      Authorization: "Bearer browser-chosen-must-not-forward",
      "Content-Type": "application/sdp",
    };
    const answer = await fetch(`${publicOrigin}${created.offerUrl}`, {
      method: "POST",
      headers,
      body: SDP_OFFER,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(await answer.text()).toBe(SDP_ANSWER);
    expect(upstreamRequests).toEqual([
      {
        url: PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
        auth: "Bearer test-ephemeral-token",
        cookie: undefined,
        origin: undefined,
        body: SDP_OFFER,
      },
    ]);
    const replay = await fetch(`${publicOrigin}${created.offerUrl}`, {
      method: "POST",
      headers,
      body: SDP_OFFER,
    });
    expect(replay.status).toBe(403);
    expect(upstreamRequests).toHaveLength(1);
  });

  it("rejects missing cookies, cross-origin requests, and non-SDP bodies before dispatch", async () => {
    const { proxy, token } = await setup();
    const upstreamFetch = vi.fn<typeof fetch>();
    const publicOrigin = await listen(
      createServer((req, res) => {
        void relay.handle(req, res);
      }),
    );
    const relay = new PlatformClawBrowserTalkRelay({
      publicOrigin,
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayProxy: proxy,
      fetchImpl: upstreamFetch,
    });
    for (const [headers, status] of [
      [{ Origin: publicOrigin, "Content-Type": "application/sdp" }, 401],
      [
        {
          Cookie: `platformclaw_session=${token}`,
          Origin: "https://attacker.invalid",
          "Content-Type": "application/sdp",
        },
        403,
      ],
      [
        {
          Cookie: `platformclaw_session=${token}`,
          Origin: publicOrigin,
          "Content-Type": "application/json",
        },
        415,
      ],
    ] as const) {
      const response = await fetch(`${publicOrigin}${PLATFORMCLAW_TALK_OFFER_PREFIX}${TICKET}`, {
        method: "POST",
        headers,
        body: SDP_OFFER,
      });
      expect(response.status).toBe(status);
      await response.arrayBuffer();
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects an answer if its owning browser disconnects during provider setup", async () => {
    const { proxy, token, request, binding } = await setup();
    proxy.registerBrowserConnection("web-1", await proxy.resolveAccess(token, false));
    const upstreamOrigin = await listen(
      createServer((req, res) => {
        req.resume();
        void proxy.releaseBrowserConnection("web-1").then(() => {
          res.setHeader("Content-Type", "application/sdp");
          res.end(SDP_ANSWER);
        });
      }),
    );
    const publicOrigin = await listen(
      createServer((req, res) => {
        void relay.handle(req, res);
      }),
    );
    const relay = new PlatformClawBrowserTalkRelay({
      publicOrigin,
      gatewayOrigin: upstreamOrigin,
      gatewayProxy: proxy,
    });
    request.mockResolvedValueOnce({
      provider: "openai",
      transport: "webrtc",
      voiceSessionId: "disconnected-voice",
      clientSecret: "test-ephemeral-token",
      offerUrl: PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
      expiresAt: NOW + 60_000,
    });
    const created = await proxy.request<{ offerUrl: string }>(
      token,
      "talk.client.create",
      {
        sessionKey: `agent:${binding.agentId}:main`,
      },
      { connectionId: "web-1" },
    );
    const response = await fetch(`${publicOrigin}${created.offerUrl}`, {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        Cookie: `platformclaw_session=${token}`,
        "Content-Type": "application/sdp",
      },
      body: SDP_OFFER,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(SDP_ANSWER);
  });

  it("bounds SDP request bodies before consuming a provider credential", async () => {
    const { proxy, token } = await setup();
    const claimTalkOffer = vi.fn();
    const upstreamFetch = vi.fn<typeof fetch>();
    const publicOrigin = await listen(
      createServer((req, res) => {
        void relay.handle(req, res);
      }),
    );
    const relay = new PlatformClawBrowserTalkRelay({
      publicOrigin,
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayProxy: {
        resolveAccess: async () => await proxy.resolveAccess(token, false),
        claimTalkOffer,
        assertTalkOfferActive: vi.fn(),
      },
      fetchImpl: upstreamFetch,
    });
    const response = await fetch(`${publicOrigin}${PLATFORMCLAW_TALK_OFFER_PREFIX}${TICKET}`, {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        Cookie: `platformclaw_session=${token}`,
        "Content-Type": "application/sdp",
      },
      body: "v=0\r\n".padEnd(256 * 1024 + 1, "x"),
    });
    expect(response.status).toBe(400);
    expect(claimTalkOffer).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("revalidates authentication after awaiting the request body and before claiming the offer", async () => {
    const { proxy, token } = await setup();
    const access = await proxy.resolveAccess(token, false);
    const resolveAccess = vi
      .fn()
      .mockResolvedValueOnce(access)
      .mockRejectedValueOnce(new BrowserGatewayProxyError("unauthenticated", "session revoked"));
    const claimTalkOffer = vi.fn();
    const upstreamFetch = vi.fn<typeof fetch>();
    const publicOrigin = await listen(
      createServer((req, res) => {
        void relay.handle(req, res);
      }),
    );
    const relay = new PlatformClawBrowserTalkRelay({
      publicOrigin,
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayProxy: { resolveAccess, claimTalkOffer, assertTalkOfferActive: vi.fn() },
      fetchImpl: upstreamFetch,
    });
    const response = await fetch(`${publicOrigin}${PLATFORMCLAW_TALK_OFFER_PREFIX}${TICKET}`, {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        Cookie: `platformclaw_session=${token}`,
        "Content-Type": "application/sdp",
      },
      body: SDP_OFFER,
    });
    expect(response.status).toBe(401);
    expect(resolveAccess).toHaveBeenCalledTimes(2);
    expect(claimTalkOffer).not.toHaveBeenCalled();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});
