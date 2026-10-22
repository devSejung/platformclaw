import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAuthService } from "./browser-auth-service.js";
import type { PlatformClawGatewayBackend } from "./gateway-runtime-client.js";
import { InMemoryControlPlaneStore } from "./memory-store.js";
import { PlatformClawWebIngressServer } from "./web-ingress-server.js";
import { upstreamHello } from "./web-ingress-test-harness.js";

const PUBLIC_ORIGIN = "https://platformclaw.example";
const BOOTSTRAP_PATH = "/platformclaw/app/control-ui-config.json";
const servers: PlatformClawWebIngressServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function fixture(config: Record<string, unknown>) {
  const authService = new BrowserAuthService({
    store: new InMemoryControlPlaneStore({
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    }),
    authenticator: {
      async authenticatePassword() {
        return {
          status: "authenticated",
          principal: {
            provider: "ldap",
            subject: "person.one",
            accountId: "person.one",
            employeeId: "1001",
          },
          profile: {
            subject: "person.one",
            accountId: "person.one",
            employeeId: "1001",
            groups: [],
            attributes: {},
          },
        };
      },
    },
    provisioner: { provisionOrRefresh: async () => {} },
  });
  const configGet = vi.fn(async () => ({
    valid: true,
    config,
    raw: "private raw",
    hash: "private hash",
  }));
  const identity = {
    agentId: "person_one",
    name: "Personal assistant",
    avatar: "P",
    avatarStatus: "none",
    avatarReason: "not-configured",
  };
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "config.get") {
      return await configGet();
    }
    if (method === "agent.identity.get") {
      return identity;
    }
    throw new Error("Unexpected private Gateway request");
  });
  const gateway: PlatformClawGatewayBackend = {
    start: () => {},
    stop: () => {},
    getHello: upstreamHello,
    request,
    subscribe: () => () => {},
    subscribeDisconnect: () => () => {},
  };
  const fallback = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>SPA fallback</title>");
    return true;
  });
  const server = new PlatformClawWebIngressServer({
    publicOrigin: PUBLIC_ORIGIN,
    authService,
    gateway,
    gatewayProxy: {
      resolveAccess: async () => {
        throw new Error("Not used by HTTP bootstrap");
      },
      request: async () => {
        throw new Error("Not used by HTTP bootstrap");
      },
      filterEvent: async () => null,
    },
    loginRateLimiter: {
      check: () => ({ allowed: true, retryAfterMs: 0 }),
      recordFailure: () => {},
    },
    webAssets: { handlePublic: async () => false, handleApplication: fallback },
  });
  servers.push(server);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${origin}/platformclaw/api/auth/login`, {
    method: "POST",
    headers: { Origin: PUBLIC_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "person.one", password: "test-password" }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  await login.arrayBuffer();
  return { origin, cookie, configGet, identity, request, fallback };
}

describe("PlatformClaw browser bootstrap HTTP route", () => {
  it("serves agent-bound JSON before SPA fallback after ordinary login", async () => {
    const current = await fixture({
      gateway: { auth: { token: "private operator token" }, terminal: { enabled: false } },
      agents: { entries: { other_agent: { workspace: "/private/other-agent" } } },
      ui: { seamColor: "123abc" },
    });
    const url = `${current.origin}${BOOTSTRAP_PATH}?agentId=other_agent`;
    expect((await fetch(url)).status).toBe(401);
    expect(current.configGet).not.toHaveBeenCalled();
    const response = await fetch(url, { headers: { Cookie: current.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      basePath: "/platformclaw/app",
      assistantAgentId: "person_one",
      assistantName: "Personal assistant",
      assistantAvatar: "P",
      serverVersion: "test",
      embedSandbox: "scripts",
      allowExternalEmbedUrls: false,
      terminalEnabled: true,
      seamColor: "123abc",
      localMediaPreviewRoots: [],
      pluginFrameGrants: [],
    });
    expect(current.request).toHaveBeenCalledWith("config.get", {});
    expect(current.request).toHaveBeenCalledWith("agent.identity.get", { agentId: "person_one" });
    expect(current.fallback).not.toHaveBeenCalled();
    for (const privateValue of [
      "private",
      "other_agent",
      "other-agent",
      '"config":',
      '"hash":',
      '"raw":',
    ]) {
      expect(JSON.stringify(body)).not.toContain(privateValue);
    }
    const head = await fetch(url, { method: "HEAD", headers: { Cookie: current.cookie } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await head.text()).toBe("");
    const post = await fetch(url, { method: "POST", headers: { Cookie: current.cookie } });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    const adjacent = await fetch(`${current.origin}${BOOTSTRAP_PATH}.other`, {
      headers: { Cookie: current.cookie },
    });
    expect(await adjacent.text()).toContain("SPA fallback");
    await fetch(`${current.origin}/platformclaw/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: current.cookie, Origin: PUBLIC_ORIGIN },
    });
    expect((await fetch(url, { headers: { Cookie: current.cookie } })).status).toBe(401);
  });

  it.each([
    ["strict", false],
    ["scripts", false],
    ["trusted", true],
  ] as const)(
    "preserves operator embed policy %s and external URLs %s",
    async (embedSandbox, allowExternalEmbedUrls) => {
      const current = await fixture({
        gateway: { controlUi: { embedSandbox, allowExternalEmbedUrls } },
      });
      const response = await fetch(`${current.origin}${BOOTSTRAP_PATH}`, {
        headers: { Cookie: current.cookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ embedSandbox, allowExternalEmbedUrls });
    },
  );

  it("reports unavailable configuration without a permissive payload or private error", async () => {
    const current = await fixture({});
    current.configGet.mockRejectedValueOnce(new Error("private Gateway configuration failure"));
    const unavailable = await fetch(`${current.origin}${BOOTSTRAP_PATH}`, {
      headers: { Cookie: current.cookie },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "Control UI configuration unavailable" });
    current.configGet.mockResolvedValueOnce({ valid: false, config: {}, raw: "", hash: "" });
    const invalid = await fetch(`${current.origin}${BOOTSTRAP_PATH}`, {
      headers: { Cookie: current.cookie },
    });
    expect(invalid.status).toBe(503);
    current.identity.agentId = "other_agent";
    const foreign = await fetch(`${current.origin}${BOOTSTRAP_PATH}`, {
      headers: { Cookie: current.cookie },
    });
    expect(foreign.status).toBe(503);
    expect(await foreign.text()).not.toContain("other_agent");
  });
});
