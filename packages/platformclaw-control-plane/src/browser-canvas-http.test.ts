import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlatformClawBrowserCanvasRelay,
  type PlatformClawBrowserCanvasPolicy,
} from "./browser-canvas-http.js";

const SESSION_COOKIE = "platformclaw_session=browser-token";
const CANVAS_LEASE_EXPIRED_MESSAGE_TYPE = "openclaw:canvas-lease-expired";

function createPolicy(agentId = "employee-one"): PlatformClawBrowserCanvasPolicy {
  return {
    resolveAccess: vi.fn(async () => ({ binding: { agentId } })),
  };
}

async function listen(
  relay: PlatformClawBrowserCanvasRelay,
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

describe("PlatformClaw browser Canvas relay", () => {
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

  it("issues, refreshes, and serves an agent-bound Canvas capability", async () => {
    const policy = createPolicy();
    const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer service-secret");
      expect(headers.get("x-openclaw-canvas-owner-agent-id")).toBe("employee-one");
      expect(headers.has("cookie")).toBe(false);
      return new Response("<html>owned widget</html>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "sandbox allow-scripts",
          "Set-Cookie": "private=must-not-escape",
        },
      });
    }) as typeof fetch;
    const relay = new PlatformClawBrowserCanvasRelay({
      publicOrigin: "https://platform.example.test",
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      fetchImpl: upstreamFetch,
      now: () => 1_000,
    });
    const first = relay.issueSurface({ binding: { agentId: "employee-one" } });
    expect(first.pluginSurfaceUrls.canvas).toMatch(
      /^https:\/\/platform\.example\.test\/__openclaw__\/cap\/v1\./u,
    );
    expect(first.expiresAtMs).toBe(601_000);
    const refreshed = (await relay.refresh("browser-token", {
      surface: "canvas",
      observedUrl: first.pluginSurfaceUrls.canvas,
    })) as ReturnType<typeof relay.issueSurface>;
    expect(refreshed.pluginSurfaceUrls.canvas).not.toBe(first.pluginSurfaceUrls.canvas);

    const runtime = await listen(relay);
    servers.push(runtime.server);
    const capabilityPath = new URL(refreshed.pluginSurfaceUrls.canvas).pathname;
    const response = await fetch(
      `${runtime.origin}${capabilityPath}/__openclaw__/canvas/documents/cv_owned/index.html`,
      { headers: { Cookie: SESSION_COOKIE } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("owned widget");
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps invalid and foreign capabilities opaque while signaling owned expiry", async () => {
    let now = 1_000;
    const policy = createPolicy();
    const upstreamFetch = vi.fn() as unknown as typeof fetch;
    const relay = new PlatformClawBrowserCanvasRelay({
      publicOrigin: "https://platform.example.test",
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
      fetchImpl: upstreamFetch,
      now: () => now,
    });
    const surface = relay.issueSurface({ binding: { agentId: "employee-one" } });
    const capabilityPath = new URL(surface.pluginSurfaceUrls.canvas).pathname;
    const runtime = await listen(relay);
    servers.push(runtime.server);
    const documentUrl = `${runtime.origin}${capabilityPath}/__openclaw__/canvas/documents/cv_owned/index.html`;

    expect((await fetch(documentUrl)).status).toBe(401);
    const resolveAccess = vi.mocked(policy.resolveAccess);
    resolveAccess.mockResolvedValueOnce({
      binding: { agentId: "employee-two" },
    });
    expect((await fetch(documentUrl, { headers: { Cookie: SESSION_COOKIE } })).status).toBe(404);
    const tampered = await fetch(documentUrl.replace("v1.", "v1.x"), {
      headers: { Cookie: SESSION_COOKIE },
    });
    expect(tampered.status).toBe(404);
    expect(tampered.headers.get("content-type")).toContain("application/json");
    expect(await tampered.text()).not.toContain(CANVAS_LEASE_EXPIRED_MESSAGE_TYPE);
    now = 700_000;
    const missingSession = await fetch(documentUrl);
    expect(missingSession.status).toBe(401);
    expect(await missingSession.text()).not.toContain(CANVAS_LEASE_EXPIRED_MESSAGE_TYPE);

    resolveAccess.mockRejectedValueOnce(new Error("expired browser session"));
    const deadSession = await fetch(documentUrl, { headers: { Cookie: SESSION_COOKIE } });
    expect(deadSession.status).toBe(401);
    expect(await deadSession.text()).not.toContain(CANVAS_LEASE_EXPIRED_MESSAGE_TYPE);

    resolveAccess.mockResolvedValueOnce({ binding: { agentId: "employee-two" } });
    const foreignExpired = await fetch(documentUrl, { headers: { Cookie: SESSION_COOKIE } });
    expect(foreignExpired.status).toBe(404);
    expect(foreignExpired.headers.get("content-type")).toContain("application/json");
    expect(await foreignExpired.text()).not.toContain(CANVAS_LEASE_EXPIRED_MESSAGE_TYPE);

    const expired = await fetch(documentUrl, { headers: { Cookie: SESSION_COOKIE } });
    expect(expired.status).toBe(404);
    expect(expired.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(expired.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const expiredHtml = await expired.text();
    expect(expiredHtml).toContain(CANVAS_LEASE_EXPIRED_MESSAGE_TYPE);
    expect(expiredHtml).not.toContain("cv_owned");
    expect(expiredHtml).not.toContain("employee-one");

    const expiredHead = await fetch(documentUrl, {
      method: "HEAD",
      headers: { Cookie: SESSION_COOKIE },
    });
    expect(expiredHead.status).toBe(404);
    expect(await expiredHead.text()).toBe("");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects refresh of another agent's lease", async () => {
    const policy = createPolicy("employee-two");
    const relay = new PlatformClawBrowserCanvasRelay({
      publicOrigin: "https://platform.example.test",
      gatewayOrigin: "http://private-gateway.invalid",
      gatewayAuth: "service-secret",
      gatewayProxy: policy,
    });
    const foreign = relay.issueSurface({ binding: { agentId: "employee-one" } });
    await expect(
      relay.refresh("browser-token", {
        surface: "canvas",
        observedUrl: foreign.pluginSurfaceUrls.canvas,
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });
});
