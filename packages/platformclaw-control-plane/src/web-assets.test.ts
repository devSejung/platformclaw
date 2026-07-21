import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPlatformClawWebAssetHandler,
  PLATFORMCLAW_WEB_ASSET_PREFIX,
  PLATFORMCLAW_WEB_LOGIN_PATH,
} from "./web-assets.js";

const tempDirectories: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "platformclaw-web-assets-"));
  tempDirectories.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "platformclaw-login.html"), "<!doctype html><title>Login</title>");
  writeFileSync(join(root, "assets", "login-ABC123.js"), "export const ready = true;");
  return root;
}

async function serveFixture(root: string): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const handler = createPlatformClawWebAssetHandler(root);
  const server = createServer((req, res) => {
    void handler.handle(req, res).then((handled) => {
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
});
