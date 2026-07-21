import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlatformClawWebAssetHandler,
  PLATFORMCLAW_WEB_APP_PATH,
  PLATFORMCLAW_WEB_ASSET_PREFIX,
  PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME,
  PLATFORMCLAW_WEB_LOGIN_PATH,
} from "./web-assets.js";

const tempDirectories: string[] = [];
const PUBLIC_ORIGIN = "https://platformclaw.example";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "platformclaw-web-assets-"));
  tempDirectories.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "platformclaw-login.html"), "<!doctype html><title>Login</title>");
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><html><head><title>Control</title><script>globalThis.ready=true</script></head><body><script type="module" src="./assets/app-ABC123.js"></script></body></html>',
  );
  writeFileSync(join(root, "assets", "login-ABC123.js"), "export const ready = true;");
  writeFileSync(join(root, "assets", "app-ABC123.js"), "export const app = true;");
  return root;
}

async function serveFixture(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const handler = createPlatformClawWebAssetHandler(root, { publicOrigin: PUBLIC_ORIGIN });
  const server = createServer((req, res) => {
    void handler.handlePublic(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("Not Found");
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function serveApplicationFixture(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const handler = createPlatformClawWebAssetHandler(root, { publicOrigin: PUBLIC_ORIGIN });
  const server = createServer((req, res) => {
    void handler.handleApplication(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("Not Found");
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("createPlatformClawWebAssetHandler", () => {
  it("serves the login contract path with document security headers", async () => {
    const fixture = await serveFixture(fixtureRoot());
    try {
      const response = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_LOGIN_PATH}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Login</title>");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await fixture.close();
    }
  });

  it("serves only indexed build assets with immutable caching", async () => {
    const fixture = await serveFixture(fixtureRoot());
    try {
      const asset = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_ASSET_PREFIX}login-ABC123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect(asset.headers.get("content-type")).toContain("text/javascript");

      const traversal = await fetch(
        `${fixture.origin}${PLATFORMCLAW_WEB_ASSET_PREFIX}%2e%2e%2fplatformclaw-login.html`,
      );
      expect(traversal.status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  it("serves the upstream application document with a bounded descriptor", async () => {
    const fixture = await serveApplicationFixture(fixtureRoot());
    try {
      const response = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_APP_PATH}/chat`);
      const body = await response.text();
      const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(contentSecurityPolicy).toContain("'sha256-");
      expect(contentSecurityPolicy).toContain("base-uri 'self'");
      expect(contentSecurityPolicy).toContain("connect-src 'self' wss://platformclaw.example");
      expect(contentSecurityPolicy).not.toContain("ws:");
      expect(contentSecurityPolicy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(body).toContain('<base href="/platformclaw/" />');
      expect(body.indexOf('<base href="/platformclaw/" />')).toBeLessThan(
        body.indexOf("<title>Control</title>"),
      );
      expect(body).toContain(`name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"`);
      expect(body).toContain("&quot;enabledRoutes&quot;");
      expect(body).not.toContain("agentId");
      expect(body).not.toContain("sessionKey");
      expect(body).not.toContain("test-auth-token");
    } finally {
      await fixture.close();
    }
  });

  it("rejects application document mutations before serving content", async () => {
    const fixture = await serveApplicationFixture(fixtureRoot());
    try {
      const response = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_APP_PATH}/chat`, {
        method: "POST",
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      await fixture.close();
    }
  });

  it("fails closed when upstream owns the application base element", () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, "index.html"),
      '<!doctype html><html><head><base href="/upstream/"></head><body></body></html>',
    );

    expect(() => createPlatformClawWebAssetHandler(root, { publicOrigin: PUBLIC_ORIGIN })).toThrow(
      "PlatformClaw Control UI document already contains a base element",
    );
  });
});
