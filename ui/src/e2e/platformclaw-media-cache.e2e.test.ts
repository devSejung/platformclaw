import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handlePlatformClawBrowserAuthRequest,
  PLATFORMCLAW_LOGIN_PATH,
  PLATFORMCLAW_LOGOUT_PATH,
  readPlatformClawSessionCookie,
} from "../../../packages/platformclaw-control-plane/src/browser-auth-http.js";
import { BrowserAuthService } from "../../../packages/platformclaw-control-plane/src/browser-auth-service.js";
import { resolveBrowserGatewayAccess } from "../../../packages/platformclaw-control-plane/src/browser-gateway-access.js";
import { PlatformClawBrowserMediaRelay } from "../../../packages/platformclaw-control-plane/src/browser-media-http.js";
import { scopeBrowserMediaDownloadUrl } from "../../../packages/platformclaw-control-plane/src/browser-media-url.js";
import { InMemoryControlPlaneStore } from "../../../packages/platformclaw-control-plane/src/memory-store.js";
import { replaceSessionEntry } from "../../../src/config/sessions/session-accessor.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
  handleManagedOutgoingMediaHttpRequest,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../../src/gateway/managed-image-attachments.js";
import { appendAssistantTranscriptMessage } from "../../../src/gateway/server-methods/chat-transcript-persistence.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowser =
  canRunPlaywrightChromium(executablePath) ||
  process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const proofDirectory = path.join(os.tmpdir(), "platformclaw-browser-media-cache");
const ownerA = "cache_owner_a";
const ownerB = "cache_owner_b";
const sessionKey = `agent:${ownerA}:main`;
const expectedPixel: [number, number, number, number] = [19, 71, 143, 255];

function createAuthFixture() {
  let sequence = 0;
  const nextId = () => `synthetic-cache-${++sequence}`;
  const store = new InMemoryControlPlaneStore({
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    idFactory: {
      nextUserId: nextId,
      nextBindingId: nextId,
      nextSessionId: nextId,
      nextManagedScopeId: nextId,
      nextAuditEventId: nextId,
    },
  });
  const service = new BrowserAuthService({
    store,
    authenticator: {
      async authenticatePassword({ login }) {
        const accountId = login.identifier;
        if (accountId !== ownerA && accountId !== ownerB) {
          return { status: "rejected", message: "Unknown synthetic account" };
        }
        return {
          status: "authenticated",
          principal: { provider: "ldap", subject: accountId, accountId, employeeId: accountId },
          profile: {
            employeeId: accountId,
            accountId,
            subject: accountId,
            displayName: accountId,
            groups: [],
            attributes: {},
          },
        };
      },
    },
    provisioner: { provisionOrRefresh: async () => undefined },
    tokenFactory: nextId,
  });
  return {
    service,
    resolveAccess: (token: string) =>
      resolveBrowserGatewayAccess({
        token,
        touch: false,
        authService: service,
        store,
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
        fail: (_code, message): never => {
          throw new Error(message);
        },
      }),
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function loadPixels(page: Page, mediaUrl: string) {
  return await page.evaluate(async (url) => {
    const image = new Image();
    image.width = 96;
    image.height = 96;
    document.body.append(image);
    return await new Promise<{ loaded: boolean; pixel?: number[] }>((resolve) => {
      image.addEventListener("error", () => resolve({ loaded: false }), { once: true });
      image.addEventListener(
        "load",
        () => {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const drawing = canvas.getContext("2d")!;
          drawing.drawImage(image, 0, 0);
          resolve({ loaded: true, pixel: Array.from(drawing.getImageData(0, 0, 1, 1).data) });
        },
        { once: true },
      );
      image.src = url;
    });
  }, mediaUrl);
}

async function authenticate(page: Page, accountId: string) {
  const received = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === PLATFORMCLAW_LOGIN_PATH &&
      response.request().method() === "POST",
  );
  const status = await page.evaluate(
    async ({ authPath, identifier }) => {
      const response = await fetch(authPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password: "synthetic-password" }),
      });
      return response.status;
    },
    { authPath: PLATFORMCLAW_LOGIN_PATH, identifier: accountId },
  );
  expect(status).toBe(200);
  // Chromium consumes this header before exposing the response to page fetch.
  // Observe the actual network response and independently prove cache eviction.
  expect(await (await received).headerValue("clear-site-data")).toBe('"cache"');
}

describeBrowser("PlatformClaw media cache account isolation", () => {
  let state: OpenClawTestState;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let gatewayServer: Server;
  let frontServer: Server;
  let gatewayOrigin: string;
  let origin: string;
  let imagePath: string;
  let auth: ReturnType<typeof createAuthFixture>;
  let legacyCacheSeed = false;
  const frontRequests: Array<{ actor?: string; status?: number; cacheControl?: string }> = [];
  const gatewayRequests: Array<{ status?: number; cacheControl?: string }> = [];
  const errors: string[] = [];
  const proofs: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    await mkdir(proofDirectory, { recursive: true });
    state = await createOpenClawTestState({ layout: "state-only", prefix: "browser-media-cache-" });
    browser = await chromium.launch({ executablePath });
    const cfg = {
      agents: { entries: { [ownerA]: { default: true, workspace: state.workspaceDir } } },
    };
    await state.writeConfig(cfg);
    const sessionId = "synthetic-managed-cache-session";
    const storePath = path.join(state.sessionsDir(ownerA), "sessions.json");
    await replaceSessionEntry(
      { agentId: ownerA, sessionKey, storePath },
      { sessionId, updatedAt: Date.now() },
    );
    const png = createSolidPngBuffer(2, 2, {
      r: expectedPixel[0],
      g: expectedPixel[1],
      b: expectedPixel[2],
    });
    const blocks = await createManagedOutgoingMediaBlocks({
      sessionKey,
      mediaUrls: [`data:image/png;base64,${png.toString("base64")}`],
      stateDir: state.stateDir,
    });
    const block = blocks.find((entry) => entry.type === "image");
    if (typeof block?.artifactId !== "string") {
      throw new Error("Managed producer did not create an image artifact");
    }
    const appended = await appendAssistantTranscriptMessage({
      sessionKey,
      sessionId,
      storePath,
      agentId: ownerA,
      cfg,
      createIfMissing: true,
      message: "Synthetic cache isolation image",
      content: blocks,
    });
    if (!appended.ok || !appended.messageId) {
      throw new Error(`Transcript fixture failed: ${appended.error}`);
    }
    await attachManagedOutgoingMediaToMessage({
      messageId: appended.messageId,
      blocks,
      stateDir: state.stateDir,
    });
    const artifact = await resolveManagedOutgoingMediaArtifactDownload({
      sessionKey,
      artifactId: block.artifactId,
      stateDir: state.stateDir,
    });
    if (!artifact) {
      throw new Error("Transcript-backed ticket minting returned no artifact");
    }
    imagePath = artifact.url;

    gatewayServer = createServer((req, res) => {
      const entry: (typeof gatewayRequests)[number] = {};
      gatewayRequests.push(entry);
      res.once("finish", () => {
        entry.status = res.statusCode;
        entry.cacheControl = String(res.getHeader("cache-control") ?? "");
      });
      void handleManagedOutgoingMediaHttpRequest(req, res, {
        auth: { mode: "token", token: "synthetic-cache-service", allowTailscale: false },
        stateDir: state.stateDir,
      })
        .then((handled) => {
          if (!handled) {
            res.writeHead(404).end();
          }
        })
        .catch((error: unknown) => {
          errors.push(String(error));
          res.writeHead(500).end();
        });
    });
    gatewayOrigin = await listen(gatewayServer);
    const relay = new PlatformClawBrowserMediaRelay({
      gatewayOrigin,
      gatewayAuth: "synthetic-cache-service",
      resolveAgentIdFromSessionKey: (key) => /^agent:([^:]+):/u.exec(key)?.[1] ?? null,
      gatewayProxy: {
        resolveAccess: async (token) => auth.resolveAccess(token),
        request: async () => {
          throw new Error("Managed media does not request assistant history");
        },
      },
    });
    frontServer = createServer((req, res) => {
      void (async () => {
        if (
          await handlePlatformClawBrowserAuthRequest(req, res, {
            service: auth.service,
            requestIsSecure: false,
            isMutationOriginAllowed: (request) => request.headers.origin === origin,
            rateLimiter: {
              check: () => ({ allowed: true, retryAfterMs: 0 }),
              recordFailure: () => {},
            },
            readJsonBody: async (request) => {
              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                chunks.push(Buffer.from(chunk));
              }
              return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
            },
          })
        ) {
          return;
        }
        if ((req.url ?? "").startsWith("/api/chat/media/outgoing/")) {
          const token = readPlatformClawSessionCookie(req);
          const access = token ? await auth.resolveAccess(token).catch(() => null) : null;
          const entry: (typeof frontRequests)[number] = { actor: access?.binding.agentId };
          frontRequests.push(entry);
          res.once("finish", () => {
            entry.status = res.statusCode;
            entry.cacheControl = String(res.getHeader("cache-control") ?? "");
          });
          if (legacyCacheSeed && access?.binding.agentId === ownerA) {
            legacyCacheSeed = false;
            // Seed only the previous release's cache policy, using the real managed
            // ticket handler and bytes. Later requests take the current BFF route.
            const upstream = await fetch(new URL(req.url!, gatewayOrigin));
            res.statusCode = upstream.status;
            for (const name of ["cache-control", "content-type", "etag"]) {
              const value = upstream.headers.get(name);
              if (value !== null) {
                res.setHeader(name, value);
              }
            }
            res.end(Buffer.from(await upstream.arrayBuffer()));
            return;
          }
        }
        if (await relay.handle(req, res)) {
          return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          "<!doctype html><title>Synthetic account isolation</title><h1>Synthetic account isolation</h1>",
        );
      })().catch((error: unknown) => {
        errors.push(String(error));
        res.writeHead(500).end();
      });
    });
    origin = await listen(frontServer);
  });

  beforeEach(async () => {
    auth = createAuthFixture();
    legacyCacheSeed = false;
    frontRequests.length = 0;
    gatewayRequests.length = 0;
    errors.length = 0;
    // Playwright routing disables the HTTP cache. This context deliberately has none.
    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 900, height: 600 },
      recordVideo: { dir: path.join(proofDirectory, "videos"), size: { width: 900, height: 600 } },
    });
    page = await context.newPage();
    await page.goto(`${origin}/owner-a`);
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    await authenticate(page, ownerA);
  });

  afterEach(async () => {
    await context?.close();
    expect(errors).toEqual([]);
  });

  afterAll(async () => {
    await writeFile(
      path.join(proofDirectory, "verdict.json"),
      JSON.stringify(
        {
          limitations: [
            "Employee credentials, provisioning, and the control-plane store are synthetic in-memory fixtures.",
            "Auth HTTP/service/access policy, managed producer, SQLite transcript, tickets, BFF, and Gateway bytes are product code.",
            "Legacy seeding preserves the previous BFF cache policy around real Gateway bytes; it is not the current media response.",
            "Chromium loopback is a potentially trustworthy context; this is not a deployed HTTPS or cross-browser proof.",
            "Clear-Site-Data is best effort; login-scoped app URLs avoid prior decoded-image keys without claiming to erase bytes already displayed.",
            "No browser routing, mock Gateway, external endpoints, or real user files are used.",
          ],
          proofs,
        },
        null,
        2,
      ),
    );
    await browser?.close();
    await closeServer(frontServer);
    await closeServer(gatewayServer);
    await state?.cleanup();
  });

  async function currentDownloadUrl(): Promise<string> {
    const cookie = (await context.cookies()).find((entry) => entry.name === "platformclaw_session");
    if (!cookie) {
      throw new Error("Synthetic browser session missing");
    }
    const access = await auth.resolveAccess(cookie.value);
    return new URL(scopeBrowserMediaDownloadUrl(imagePath, access), origin).href;
  }

  it("reauthorizes the exact managed URL after a cookie account change", async () => {
    const url = await currentDownloadUrl();
    expect(await loadPixels(page, url)).toEqual({ loaded: true, pixel: expectedPixel });
    expect(frontRequests).toHaveLength(1);
    expect(frontRequests[0]).toMatchObject({
      actor: ownerA,
      status: 200,
      cacheControl: "no-store",
    });
    const login = await auth.service.loginPassword({
      login: { identifier: ownerB, password: "synthetic-password" },
    });
    if (login.status !== "authenticated") {
      throw new Error("Synthetic owner B login failed");
    }
    // Bypass the HTTP login response only here, isolating media no-store from cache clearing.
    await context.addCookies([{ name: "platformclaw_session", value: login.token, url: origin }]);
    await page.goto(`${origin}/owner-b`);
    const result = await loadPixels(page, url);
    expect(result.loaded).toBe(false);
    expect(frontRequests).toHaveLength(2);
    expect(frontRequests[1]).toMatchObject({
      actor: ownerB,
      status: 404,
      cacheControl: "no-store",
    });
    expect(gatewayRequests).toHaveLength(1);
    await page.screenshot({
      path: path.join(proofDirectory, "no-store-owner-change.png"),
      fullPage: true,
    });
    proofs.push({
      scenario: "no-store-cookie-change",
      result,
      frontRequests: [...frontRequests],
      gatewayRequests: [...gatewayRequests],
    });
  });

  it.each(["logout", "login"] as const)(
    "avoids a previously cacheable image across the real %s HTTP boundary",
    async (boundary) => {
      const legacyUrl = new URL(imagePath, origin).href;
      const priorLoginUrl = await currentDownloadUrl();
      expect(priorLoginUrl).not.toBe(legacyUrl);
      legacyCacheSeed = true;
      expect(await loadPixels(page, legacyUrl)).toEqual({ loaded: true, pixel: expectedPixel });
      expect(frontRequests[0]?.cacheControl).toContain("immutable");
      await page.goto(`${origin}/owner-a-cached`);
      expect(await loadPixels(page, legacyUrl)).toEqual({ loaded: true, pixel: expectedPixel });
      expect(frontRequests).toHaveLength(1);
      expect(gatewayRequests).toHaveLength(1);
      await page.evaluate(() => localStorage.setItem("synthetic-preference", "preserved"));
      await context.addCookies([{ name: "unrelated_cookie", value: "preserved", url: origin }]);
      if (boundary === "logout") {
        const received = page.waitForResponse(
          (response) => new URL(response.url()).pathname === PLATFORMCLAW_LOGOUT_PATH,
        );
        const status = await page.evaluate(async (logoutPath) => {
          const response = await fetch(logoutPath, { method: "POST" });
          return response.status;
        }, PLATFORMCLAW_LOGOUT_PATH);
        expect(status).toBe(200);
        expect(await (await received).headerValue("clear-site-data")).toBe('"cache"');
        await page.goto(`${origin}/logged-out`);
        // The current app uses a login-scoped URL rather than the old decoded-image key.
        expect((await loadPixels(page, priorLoginUrl)).loaded).toBe(false);
        expect(frontRequests.at(-1)?.status).toBe(401);
      }
      await authenticate(page, ownerB);
      await page.goto(`${origin}/owner-b`);
      const nextLoginUrl = await currentDownloadUrl();
      expect(nextLoginUrl).not.toBe(priorLoginUrl);
      const result = await loadPixels(page, nextLoginUrl);
      expect(result.loaded).toBe(false);
      expect(frontRequests.at(-1)).toMatchObject({ actor: ownerB, status: 404 });
      expect(gatewayRequests).toHaveLength(1);
      expect(await page.evaluate(() => localStorage.getItem("synthetic-preference"))).toBe(
        "preserved",
      );
      expect(
        (await context.cookies()).find((cookie) => cookie.name === "unrelated_cookie")?.value,
      ).toBe("preserved");
      await page.screenshot({
        path: path.join(proofDirectory, `legacy-cache-${boundary}.png`),
        fullPage: true,
      });
      proofs.push({
        scenario: `legacy-cache-${boundary}`,
        result,
        frontRequests: [...frontRequests],
        gatewayRequests: [...gatewayRequests],
      });
    },
  );
});
