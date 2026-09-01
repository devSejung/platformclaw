import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePlatformClawWebDescriptor } from "../../../ui/src/platformclaw/web-contract.js";
import {
  createPlatformClawWebAssetHandler,
  PLATFORMCLAW_WEB_APP_PATH,
  PLATFORMCLAW_WEB_ASSET_PREFIX,
  PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME,
  PLATFORMCLAW_WEB_DESCRIPTOR,
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
    '<!doctype html><html><head><!-- OpenClaw upstream compatibility --><title>OpenClaw Control</title><link rel="icon" type="image/svg+xml" href="./favicon.svg"><link rel="icon" type="image/png" href="./favicon-32.png"><link rel="apple-touch-icon" href="./apple-touch-icon.png"><link rel="manifest" href="./manifest.webmanifest"><script>globalThis.ready=true;globalThis.message="OpenClaw will retry"</script></head><body><p>OpenClaw Control UI</p><script type="module" src="./assets/app-ABC123.js"></script></body></html>',
  );
  writeFileSync(join(root, "assets", "login-ABC123.js"), "export const ready = true;");
  writeFileSync(join(root, "assets", "app-ABC123.js"), "export const app = true;");
  writeFileSync(
    join(root, "sw.js"),
    [
      'if (url.pathname.startsWith("/api/") || false) {}',
      'data = { title: "OpenClaw", body: event.data.text() };',
      'const title = data.title || "OpenClaw";',
      "const options = {",
      '  icon: "./apple-touch-icon.png",',
      '  badge: "./favicon-32.png",',
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "manifest.webmanifest"),
    '{"name":"OpenClaw Control","short_name":"OpenClaw","icons":[]}',
  );
  writeFileSync(join(root, "favicon.svg"), "<svg>upstream favicon</svg>");
  writeFileSync(join(root, "favicon-32.png"), "upstream favicon png");
  writeFileSync(join(root, "apple-touch-icon.png"), "upstream touch icon");
  writeFileSync(join(root, "assets", "platformclaw-pixel-ABC123.svg"), "<svg></svg>");
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

async function serveApplicationFixture(
  root: string,
  vocEnabled = false,
): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const handler = createPlatformClawWebAssetHandler(root, {
    publicOrigin: PUBLIC_ORIGIN,
    vocEnabled,
  });
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
  it("keeps the server descriptor compatible with the Control UI parser", () => {
    expect(parsePlatformClawWebDescriptor(PLATFORMCLAW_WEB_DESCRIPTOR)).toEqual(
      PLATFORMCLAW_WEB_DESCRIPTOR,
    );
  });

  it("serves the login contract path with document security headers", async () => {
    const fixture = await serveFixture(fixtureRoot());
    try {
      const response = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_LOGIN_PATH}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Login</title>");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("content-security-policy")).toContain("base-uri 'self'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      await fixture.close();
    }
  });

  it("serves upstream root assets from the mounted application path", async () => {
    const fixture = await serveFixture(fixtureRoot());
    try {
      const serviceWorker = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_APP_PATH}/sw.js`);
      expect(serviceWorker.status).toBe(200);
      expect(serviceWorker.headers.get("content-type")).toContain("text/javascript");
      expect(serviceWorker.headers.get("cache-control")).toBe("no-cache");
      const serviceWorkerText = await serviceWorker.text();
      expect(serviceWorkerText).toContain(
        'data = { title: "PlatformClaw", body: event.data.text() };',
      );
      expect(serviceWorkerText).toContain(
        'data.title === "OpenClaw" || !data.title ? "PlatformClaw" : data.title',
      );
      expect(
        serviceWorkerText.match(/"\/platformclaw\/assets\/platformclaw-pixel-ABC123\.svg"/gu),
      ).toHaveLength(2);
      expect(serviceWorkerText).toContain('url.pathname.startsWith("/platformclaw/api/")');
      expect(serviceWorkerText).toContain(
        'url.pathname.startsWith("/platformclaw/app/__openclaw__/")',
      );
      const serviceWorkerHead = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_APP_PATH}/sw.js`, {
        method: "HEAD",
      });
      expect(serviceWorkerHead.status).toBe(200);
      expect(serviceWorkerHead.headers.get("cache-control")).toBe("no-cache");
      expect(await serviceWorkerHead.text()).toBe("");

      const manifest = await fetch(
        `${fixture.origin}${PLATFORMCLAW_WEB_APP_PATH}/manifest.webmanifest`,
      );
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
      await expect(manifest.json()).resolves.toMatchObject({
        name: "PlatformClaw",
        short_name: "PlatformClaw",
        icons: [
          {
            src: "/platformclaw/assets/platformclaw-pixel-ABC123.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
        ],
      });

      for (const asset of ["favicon.svg", "favicon-32.png", "apple-touch-icon.png"]) {
        const response = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_APP_PATH}/${asset}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-cache");
      }

      const mascot = await fetch(
        `${fixture.origin}${PLATFORMCLAW_WEB_ASSET_PREFIX}platformclaw-pixel-ABC123.svg`,
      );
      expect(mascot.status).toBe(200);
      expect(mascot.headers.get("content-type")).toContain("image/svg+xml");
      expect(mascot.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await mascot.text()).toBe("<svg></svg>");
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
    const fixture = await serveApplicationFixture(fixtureRoot(), true);
    try {
      const response = await fetch(`${fixture.origin}${PLATFORMCLAW_WEB_APP_PATH}/chat`);
      const body = await response.text();
      const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
      const brandedInlineScriptHash = createHash("sha256")
        .update('globalThis.ready=true;globalThis.message="PlatformClaw will retry"')
        .digest("base64");

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(contentSecurityPolicy).toContain(`'sha256-${brandedInlineScriptHash}'`);
      expect(contentSecurityPolicy).toContain("base-uri 'self'");
      expect(contentSecurityPolicy).toContain(
        "connect-src 'self' data: wss://platformclaw.example",
      );
      expect(contentSecurityPolicy).not.toContain("ws:");
      expect(contentSecurityPolicy).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
      expect(contentSecurityPolicy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(body).toContain('<base href="/platformclaw/" />');
      expect(body).toContain('data-openclaw-terminal-enabled="true"');
      expect(body.indexOf('<base href="/platformclaw/" />')).toBeLessThan(
        body.indexOf("<title>PlatformClaw Control</title>"),
      );
      expect(body).toContain("<p>PlatformClaw Control UI</p>");
      expect(body).not.toContain("OpenClaw Control");
      expect(body).toContain("<!-- OpenClaw upstream compatibility -->");
      expect(body).toContain('href="/platformclaw/assets/platformclaw-pixel-ABC123.svg"');
      expect(
        body.match(/href="\/platformclaw\/assets\/platformclaw-pixel-ABC123\.svg"/gu),
      ).toHaveLength(3);
      expect(body).toContain('href="/platformclaw/app/manifest.webmanifest"');
      expect(body).not.toMatch(/href="\/(?:favicon|apple-touch-icon|manifest\.webmanifest)/u);
      expect(body).toContain(`name="${PLATFORMCLAW_WEB_DESCRIPTOR_META_NAME}"`);
      expect(body).toContain("&quot;enabledRoutes&quot;");
      expect(body).toContain("&quot;vocEnabled&quot;:true");
      expect(body).toContain(
        "&quot;enabledRoutes&quot;:[&quot;chat&quot;,&quot;new-session&quot;,&quot;activity&quot;,&quot;sessions&quot;,&quot;usage&quot;,&quot;agents&quot;,&quot;tasks&quot;,&quot;cron&quot;,&quot;appearance&quot;,&quot;credentials&quot;,&quot;memory&quot;,&quot;organization&quot;,&quot;profile&quot;,&quot;notifications&quot;,&quot;about&quot;,&quot;skills&quot;,&quot;skill-workshop&quot;,&quot;skill-hub&quot;,&quot;plugins&quot;,&quot;mcp&quot;]",
      );
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
      '<!doctype html><html><head><title>Control</title><base href="/upstream/"></head><body></body></html>',
    );

    expect(() => createPlatformClawWebAssetHandler(root, { publicOrigin: PUBLIC_ORIGIN })).toThrow(
      "PlatformClaw Control UI document already contains a base element",
    );
  });

  it("fails closed when an upstream bootstrap asset link drifts", () => {
    const root = fixtureRoot();
    const applicationPath = join(root, "index.html");
    writeFileSync(
      applicationPath,
      readFileSync(applicationPath, "utf8").replace(
        'href="./manifest.webmanifest"',
        'href="./changed.webmanifest"',
      ),
    );

    expect(() => createPlatformClawWebAssetHandler(root, { publicOrigin: PUBLIC_ORIGIN })).toThrow(
      "PlatformClaw Control UI document manifest.webmanifest link contract changed",
    );
  });

  it("fails closed when one service worker branding literal drifts", () => {
    const root = fixtureRoot();
    const serviceWorkerPath = join(root, "sw.js");
    writeFileSync(
      serviceWorkerPath,
      readFileSync(serviceWorkerPath, "utf8").replace(
        'badge: "./favicon-32.png",',
        'badge: "./changed.png",',
      ),
    );

    expect(() => createPlatformClawWebAssetHandler(root, { publicOrigin: PUBLIC_ORIGIN })).toThrow(
      "PlatformClaw Control UI service worker notification badge contract changed",
    );
  });

  it("fails closed when the canonical mascot asset is ambiguous", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "assets", "platformclaw-pixel-SECOND.svg"), "<svg></svg>");

    expect(() => createPlatformClawWebAssetHandler(root, { publicOrigin: PUBLIC_ORIGIN })).toThrow(
      "PlatformClaw Control UI must contain one canonical mascot asset",
    );
  });
});
