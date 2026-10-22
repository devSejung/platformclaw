// Exercise ui/message through the real SDK and sandbox, including the production pane owner.
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSandboxHostPath } from "../../../src/agents/sandbox-host.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { getFreeGatewayPort } from "../../../src/gateway/test-helpers.e2e.js";
import {
  canRunPlaywrightChromium,
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installFullGatewayMock,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const require = createRequire(import.meta.url);
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const describeBrowser =
  chromiumAvailable || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const sessionKey = "agent:main:mcp-message";
const prompt = "Summarize the selected item.";
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR;
const contexts = new Set<BrowserContext>();
let browser: Browser;
let controlUi: ControlUiE2eServer;
let sandboxServer: Server;
let assetServer: Server;
let sandboxPort: number;
let assetOrigin: string;

function appHtml(): string {
  return `<!doctype html><meta charset="utf-8" />
<style>body { font: 16px system-ui; padding: 16px; } button { padding: 12px; } output { display: block; margin-top: 12px; } #capabilities { display: none; }</style>
<button id="send-message">Ask in chat</button>
<output id="initialized">pending</output><output id="capabilities" hidden></output>
<output id="message">Not sent</output>
<script type="module">
import { App } from ${JSON.stringify(`${assetOrigin}/app.js`)};
const app = new App({ name: "Message proof", version: "1.0.0" });
document.getElementById("send-message").onclick = async () => {
  const output = document.getElementById("message");
  output.textContent = "Sending";
  try {
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: ${JSON.stringify(prompt)} }] });
    output.textContent = result.isError ? "Rejected" : "Accepted";
  } catch { output.textContent = "Rejected"; }
};
await app.connect();
document.getElementById("capabilities").textContent = JSON.stringify(app.getHostCapabilities());
document.getElementById("initialized").textContent = "ready";
</script>`;
}

function appViewPayload() {
  return {
    sandboxUrl: buildSandboxHostPath({ resourceDomains: [assetOrigin] }),
    sandboxPort,
    html: appHtml(),
    csp: { resourceDomains: [assetOrigin] },
    toolInput: {},
    toolResult: { content: [{ type: "text", text: "Selection ready" }] },
    messageSupported: true,
    updateModelContextSupported: false,
  };
}

function boardSnapshot(chatDock = "right") {
  return {
    sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock }],
    widgets: [
      {
        name: "selection",
        tabId: "main",
        title: "Selection app",
        contentKind: "mcp-app",
        sizeW: 12,
        sizeH: 3,
        position: 0,
        grantState: "granted",
        revision: 1,
        instanceId: "selection-instance",
      },
    ],
  };
}

function boardResponses(chatDock = "right") {
  return {
    "board.get": boardSnapshot(chatDock),
    "board.widget.appView": { viewId: "message-view", expiresAtMs: Date.now() + 3_600_000 },
    "mcp.app.view": appViewPayload(),
  };
}

async function withPage(name: string, run: (page: Page) => Promise<void>): Promise<void> {
  const directory = artifactDir ? path.join(artifactDir, name) : undefined;
  if (directory) {
    await mkdir(directory, { recursive: true });
  }
  const context = await browser.newContext({
    locale: "en-US",
    permissions: ["local-network-access"],
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    ...(directory ? { recordVideo: { dir: directory, size: { width: 1280, height: 900 } } } : {}),
  });
  contexts.add(context);
  const page = await context.newPage();
  const diagnostics: string[] = [];
  page.on("pageerror", (error) => diagnostics.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.push(message.text());
    }
  });
  page.on("requestfailed", (request) =>
    diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`),
  );
  try {
    await run(page);
  } catch (error) {
    throw new Error(`${String(error)}; browser=${JSON.stringify(diagnostics)}`, { cause: error });
  } finally {
    if (directory) {
      await page.screenshot({ path: path.join(directory, "final.png"), fullPage: true });
    }
    await context.close();
    contexts.delete(context);
  }
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (artifactDir) {
    await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
  }
}

async function findAppFrame(page: Page): Promise<Frame> {
  await expect
    .poll(async () => {
      for (const frame of page.frames()) {
        if ((await frame.locator("#initialized").count()) > 0) {
          return await frame.locator("#initialized").textContent();
        }
      }
      return null;
    })
    .toBe("ready");
  for (const frame of page.frames()) {
    if ((await frame.locator("#initialized").count()) > 0) {
      return frame;
    }
  }
  throw new Error("Initialized MCP App frame disappeared");
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describeBrowser("MCP App message delivery", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    controlUi = await startControlUiE2eServer(undefined, { source: true });
    sandboxPort = await getFreeGatewayPort();
    sandboxServer = createSandboxHostHttpServer();
    await new Promise<void>((resolve) => {
      sandboxServer.listen(sandboxPort, "127.0.0.1", resolve);
    });
    const moduleSource = await readFile(
      require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
      "utf8",
    );
    assetServer = createServer((request, response) => {
      if (request.url !== "/app.js") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/javascript; charset=utf-8",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      response.end(moduleSource);
    });
    const assetPort = await getFreeGatewayPort();
    await new Promise<void>((resolve) => {
      assetServer.listen(assetPort, "127.0.0.1", resolve);
    });
    assetOrigin = `http://127.0.0.1:${assetPort}`;
    browser = await chromium.launch({ executablePath });
  }, 120_000);

  afterAll(async () => {
    for (const context of contexts) {
      await context.close();
    }
    await browser?.close();
    await closeServer(assetServer);
    await closeServer(sandboxServer);
    await controlUi?.close();
  });

  it("rejects an App message when no conversation owner receives it", async () => {
    await withPage("unowned", async (page) => {
      const gateway = await installFullGatewayMock(page, {
        sessionKey,
        methodResponses: { "mcp.app.view": appViewPayload() },
      });
      await page.route(`${controlUi.baseUrl}mcp-message-unowned`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><h1>App without a conversation owner</h1><main id="mount"></main>
<script type="module">
import { GatewayBrowserClient } from "/src/api/gateway.ts";
import "/src/components/mcp-app-view-registration.ts";
const client = new GatewayBrowserClient({
  url: ${JSON.stringify(controlUiBundledGatewayUrl(controlUi.baseUrl))},
  onHello: () => {
    const view = document.createElement("mcp-app-view");
    Reflect.set(view, "context", {
      gateway: { snapshot: { client }, connection: { gatewayUrl: ${JSON.stringify(controlUiBundledGatewayUrl(controlUi.baseUrl))} } },
      theme: { subscribe: () => () => {} },
    });
    view.sessionKey = ${JSON.stringify(sessionKey)};
    view.viewId = "unowned-view";
    document.getElementById("mount").append(view);
  },
});
client.start();
</script>`,
        }),
      );
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(`${controlUi.baseUrl}mcp-message-unowned`);
      const app = await findAppFrame(page);
      await app.locator("#send-message").click();
      await expect.poll(() => app.locator("#message").textContent()).toBe("Rejected");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("opens the full Workboard dashboard and sends from the same app", async () => {
    await withPage("workboard", async (page) => {
      const board = { id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } };
      const gateway = await installFullGatewayMock(page, {
        sessionKey,
        methodResponses: {
          ...boardResponses(),
          "config.get": { config: { plugins: { entries: { workboard: { enabled: true } } } } },
          "workboard.boards.list": { boards: [board] },
          "workboard.cards.list": {
            cards: [
              {
                id: "selection-card",
                title: "Selection review",
                status: "todo",
                priority: "normal",
                labels: [],
                position: 1000,
                createdAt: 1,
                updatedAt: 1,
                agentId: "main",
                sessionKey,
              },
            ],
            statuses: ["todo", "done"],
            boards: [board],
          },
          "tasks.list": { tasks: [] },
        },
      });
      await page.goto(`${controlUi.baseUrl}workboard`);
      await page.locator(".workboard-card", { hasText: "Selection review" }).click();
      const preview = page.locator(
        "#workboard-card-detail-drawer openclaw-workboard-card-dashboard",
      );
      await preview.locator(".workboard-card-dashboard__message-hint").waitFor();
      const app = await findAppFrame(page);
      const capabilities = JSON.parse((await app.locator("#capabilities").textContent()) ?? "{}");
      expect(capabilities.message).toBeUndefined();
      await screenshot(page, "workboard-preview");
      await app.locator("#send-message").click();
      await expect.poll(() => app.locator("#message").textContent()).toBe("Rejected");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await preview.getByRole("button", { name: "Open full dashboard", exact: true }).click();
      await page.waitForURL((url) =>
        url.pathname.startsWith(new URL("dashboard/", controlUi.baseUrl).pathname),
      );
      await preview.waitFor({ state: "detached" });
      const fullApp = await findAppFrame(page);
      const fullCapabilities = JSON.parse(
        (await fullApp.locator("#capabilities").textContent()) ?? "{}",
      );
      expect(fullCapabilities.message).toEqual({ text: {} });
      expect((await gateway.waitForRequest("chat.startup")).params).toMatchObject({ sessionKey });
      page.on("dialog", (dialog) => dialog.accept());
      await fullApp.locator("#send-message").click();
      await expect.poll(() => fullApp.locator("#message").textContent()).toBe("Accepted");
      expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
        sessionKey,
        message: prompt,
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await page.locator(".chat-group.user", { hasText: prompt }).waitFor({ state: "visible" });
      await screenshot(page, "workboard-open-dashboard");
    });
  });

  it("admits a dashboard App message through the normal chat queue and displays its result", async () => {
    await withPage("dashboard", async (page) => {
      const gateway = await installFullGatewayMock(page, {
        sessionKey,
        deferredMethods: ["chat.send"],
        methodResponses: boardResponses("hidden"),
      });
      await page.addInitScript(
        ({ storageKey, key }) => {
          localStorage.setItem(
            storageKey,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { storageKey: controlUiBundledSettingsStorageKey(controlUi.baseUrl), key: sessionKey },
      );
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(`${controlUi.baseUrl}dashboard`);
      const app = await findAppFrame(page);
      const capabilities = JSON.parse((await app.locator("#capabilities").textContent()) ?? "{}");
      expect(capabilities.message).toEqual({ text: {} });
      await screenshot(page, "dashboard-before-message");
      await app.locator("#send-message").click();
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({ sessionKey, message: prompt, deliver: false });
      // Admission owns the prompt before the remote run starts; ui/message need
      // not wait for a model response, and must never send a second chat turn.
      await expect.poll(() => app.locator("#message").textContent()).toBe("Accepted");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await page.locator(".chat-group.user", { hasText: prompt }).waitFor({ state: "visible" });
      await gateway.resolveDeferred("chat.send");
      const runId = (request.params as { idempotencyKey: string }).idempotencyKey;
      await gateway.emitChatFinal({
        runId,
        sessionKey,
        text: "The selected item is ready for review.",
      });
      await page
        .locator(".chat-thread-inner")
        .getByText("The selected item is ready for review.", { exact: true })
        .waitFor({ state: "visible" });
      await screenshot(page, "dashboard-message-result");
    });
  });

  it("keeps a cancelled confirmation quiet and sends no message", async () => {
    await withPage("cancelled", async (page) => {
      const gateway = await installFullGatewayMock(page, {
        sessionKey,
        methodResponses: boardResponses(),
      });
      page.on("dialog", (dialog) => dialog.dismiss());
      await page.goto(`${controlUi.baseUrl}dashboard`);
      const app = await findAppFrame(page);
      await app.locator("#send-message").click();
      await expect.poll(() => app.locator("#message").textContent()).toBe("Rejected");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await page.locator("mcp-app-view [role=alert]").count()).toBe(0);
    });
  });

  it.each([
    { name: "archived", restriction: { archived: true } },
    { name: "view-only", restriction: { visibility: "private", sharingRole: "viewer" } },
  ])("rejects messages when the owning chat is $name", async ({ name, restriction }) => {
    await withPage(name, async (page) => {
      const session = { key: sessionKey, kind: "direct", ...restriction };
      const gateway = await installFullGatewayMock(page, {
        sessionKey,
        sessionInfo: session,
        methodResponses: {
          ...boardResponses(),
          "sessions.list": { ts: 1, path: "", count: 1, defaults: {}, sessions: [session] },
        },
      });
      page.on("dialog", (dialog) => dialog.accept());
      await page.goto(`${controlUi.baseUrl}dashboard`);
      const app = await findAppFrame(page);
      await app.locator("#send-message").click();
      await expect.poll(() => app.locator("#message").textContent()).toBe("Rejected");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.locator("mcp-app-view [role=alert]").waitFor({ state: "visible" });
    });
  });
});
