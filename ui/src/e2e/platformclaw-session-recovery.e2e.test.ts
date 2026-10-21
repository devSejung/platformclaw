import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(".artifacts/control-ui-e2e/platformclaw-session-recovery");
const proxyHeaderBlocklist = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);
const employeeSession = {
  authenticated: true,
  user: {
    accountId: "person.one",
    displayName: "Person One",
    department: "Platform",
    globalRole: "member",
  },
  agent: { agentId: "person_one", state: "active" },
};

type SessionState = "inactive" | "unavailable";
type RecoveryOrigin = ControlUiE2eServer & {
  sessionRequests: number;
  rejectedUpgrades: number;
  sessionState: SessionState;
};

let uiServer: ControlUiE2eServer;
let browser: Browser;
let context: BrowserContext | undefined;
let origin: RecoveryOrigin | undefined;

async function newPage(): Promise<Page> {
  const viewport = { width: 1440, height: 900 };
  context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureProof ? { recordVideo: { dir: path.join(proofDir, "video"), size: viewport } } : {}),
  });
  return context.newPage();
}

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({
      path: path.join(proofDir, `${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
}

async function startRecoveryOrigin(sessionState: SessionState): Promise<RecoveryOrigin> {
  const fixture: RecoveryOrigin = {
    baseUrl: "",
    close: async () => {},
    sessionRequests: 0,
    rejectedUpgrades: 0,
    sessionState,
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://employee.test");
      if (url.pathname === "/platformclaw/api/auth/session") {
        fixture.sessionRequests++;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        if (fixture.sessionRequests === 1) {
          response.end(JSON.stringify(employeeSession));
        } else if (fixture.sessionState === "unavailable") {
          response.writeHead(503).end(JSON.stringify({ error: "temporarily unavailable" }));
        } else {
          response.end(JSON.stringify({ authenticated: false }));
        }
        return;
      }
      if (url.pathname.startsWith("/platformclaw/api/")) {
        response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      const applicationDocument = url.pathname.startsWith("/platformclaw/app/");
      const sourcePath = applicationDocument
        ? "/"
        : url.pathname === "/platformclaw/login"
          ? "/platformclaw-login.html"
          : (request.url ?? "/");
      const upstream = await fetch(new URL(sourcePath, uiServer.baseUrl), {
        headers: { Accept: request.headers.accept ?? "*/*" },
        redirect: "manual",
      });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!proxyHeaderBlocklist.has(name)) {
          response.setHeader(name, value);
        }
      }
      let body = Buffer.from(await upstream.arrayBuffer());
      if (applicationDocument) {
        const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
        body = Buffer.from(body.toString("utf8").replace("</head>", `${descriptor}</head>`));
      }
      response.end(body);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
  });
  server.on("upgrade", (request, socket) => {
    if (new URL(request.url ?? "/", "http://employee.test").pathname === "/platformclaw/gateway") {
      fixture.rejectedUpgrades++;
      // Match the ingress's expired-session rejection before a WebSocket exists.
      // Chromium must generate the close code; this fixture never replaces WebSocket.
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Employee recovery origin did not bind a TCP port");
  }
  fixture.baseUrl = `http://127.0.0.1:${address.port}/`;
  fixture.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  return fixture;
}

describeE2e("PlatformClaw native WebSocket session recovery", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    if (captureProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    uiServer = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterEach(async () => {
    await context?.close();
    context = undefined;
    await origin?.close();
    origin = undefined;
  });
  afterAll(async () => {
    await browser?.close();
    await uiServer?.close();
  });

  it("returns to sign-in after an expired session rejects the HTTP upgrade", async () => {
    origin = await startRecoveryOrigin("inactive");
    const page = await newPage();
    await page.goto(`${origin.baseUrl}platformclaw/app/chat?draft=1#composer`);

    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/login");
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
      "/platformclaw/app/chat?draft=1#composer",
    );
    expect(origin.rejectedUpgrades).toBeGreaterThan(0);
    expect(origin.sessionRequests).toBeGreaterThan(1);
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await capture(page, "01-expired-upgrade-sign-in");
  });

  it("keeps the employee shell during a session-service outage, then recovers without refresh", async () => {
    origin = await startRecoveryOrigin("unavailable");
    const page = await newPage();
    await page.goto(`${origin.baseUrl}platformclaw/app/chat`);
    await expect.poll(() => origin!.sessionRequests, { timeout: 10_000 }).toBeGreaterThan(2);
    expect(origin.rejectedUpgrades).toBeGreaterThan(1);
    expect(new URL(page.url()).pathname).toBe("/platformclaw/app/chat");
    expect(await page.getByText("Person One", { exact: true }).isVisible()).toBe(true);
    const lastError = await page.evaluate(() => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime: { context: { gateway: { snapshot: { lastError: string | null } } } };
      };
      return app.runtime.context.gateway.snapshot.lastError;
    });
    expect(lastError).toContain("(1006)");
    await capture(page, "02-session-service-outage-shell");

    origin.sessionState = "inactive";
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
      .toBe("/platformclaw/login");
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await capture(page, "03-session-service-recovered-sign-in");
  });
});
