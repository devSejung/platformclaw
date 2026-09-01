import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway as installProjectedMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { runPlatformClawSettingsAndMemoryGuide } from "./platformclaw-guide-flow.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "platformclaw-adapter");

let server: ControlUiE2eServer;
let browser: Browser;
const contexts = new Set<BrowserContext>();

function installMockGateway(page: Page, scenario: ControlUiMockGatewayScenario = {}) {
  return installProjectedMockGateway(page, {
    ...scenario,
    featureMethods: scenario.featureMethods ?? [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
  });
}

async function newPage(
  viewport: { height: number; width: number } = { height: 900, width: 1440 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    locale: "en-US",
    ...(captureUiProofEnabled ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
    serviceWorkers: "block",
    viewport,
  });
  contexts.add(context);
  return { context, page: await context.newPage() };
}

async function installPlatformClawDocument(
  page: Page,
  descriptorValue = PLATFORMCLAW_WEB_DESCRIPTOR,
): Promise<void> {
  const response = await page.request.get(server.baseUrl);
  const source = await response.text();
  const headers = response.headers();
  const status = response.status();
  await page.route("**/platformclaw/app/**", async (route) => {
    const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(descriptorValue)}'>`;
    await route.fulfill({
      body: source.replace("</head>", `${descriptor}</head>`),
      headers,
      status,
    });
  });
}

async function dragAcross(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Expected a visible selection target: ${selector}`);
  }
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.max(3, box.width - 2), y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => globalThis.getSelection()?.toString() ?? "");
}

async function openPlatformClawMcpSettings(page: Page): Promise<void> {
  await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
  const settingsSidebar = page.locator(".settings-sidebar");
  await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
  await settingsSidebar.getByRole("link", { name: "MCP", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/settings/mcp");
}

function activeSession(globalRole: "member" | "admin" = "member") {
  return {
    authenticated: true,
    user: {
      accountId: "person.one",
      displayName: "Person One",
      department: "Platform Lab",
      globalRole,
    },
    agent: { agentId: "person_one", state: "active" },
    session: {
      idleExpiresAt: Date.now() + 60_000,
      absoluteExpiresAt: Date.now() + 120_000,
    },
  };
}

describeControlUiE2e("PlatformClaw Control UI adapter mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
    contexts.clear();
  });

  afterAll(async () => {
    await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  it("waits for the hosted Canvas relay and never navigates a widget to the app shell", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    const documentPath = "/__openclaw__/canvas/documents/cv_hosted_reconnect/index.html";
    const historyMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "canvas",
            preview: {
              kind: "canvas",
              render: "url",
              sandbox: "scripts",
              surface: "assistant_message",
              title: "Hosted reconnect proof",
              url: documentPath,
              viewId: "cv_hosted_reconnect",
            },
          },
        ],
      },
    ];
    const bareRequests: string[] = [];
    await page.route("**/__openclaw__/canvas/**", (route) => {
      bareRequests.push(route.request().url());
      return route.abort();
    });
    const signedSurface = `${server.baseUrl}__openclaw__/cap/signed-hosted`;
    await page.route("**/__openclaw__/cap/**", (route) =>
      route.fulfill({
        body: "<!doctype html><h1 data-hosted-canvas>Hosted Canvas ready</h1>",
        contentType: "text/html",
        headers: {
          "Content-Security-Policy": "sandbox allow-scripts",
          "X-Content-Type-Options": "nosniff",
        },
        status: 200,
      }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      featureMethods: ["chat.metadata", "chat.startup"],
      historyMessages,
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    await preview.getByText("Reconnect to the Gateway", { exact: false }).waitFor();
    expect(await preview.locator("iframe").count()).toBe(0);
    expect(bareRequests).toEqual([]);

    await gateway.setMethodResponse("connect", {
      auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      features: {
        capabilities: ["platformclaw.personal-vm-terminal"],
        events: [],
        methods: ["chat.metadata", "chat.startup"],
      },
      pluginSurfaceUrls: { canvas: signedSurface },
      policy: {
        allowedSessionVisibilities: [],
        hasMultipleSessionSharingIdentities: false,
        maxBufferedBytes: 1_048_576,
        maxPayload: 1_048_576,
        tickIntervalMs: 30_000,
      },
      protocol: PROTOCOL_VERSION,
      server: { connId: "hosted-canvas-reconnect", version: "e2e" },
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "person_one",
          mainKey: "main",
          mainSessionKey: "agent:person_one:main",
          scope: "agent",
        },
      },
      type: "hello-ok",
    });
    const initialConnectCount = (await gateway.getRequests("connect")).length;
    await gateway.deferNext("connect");
    await gateway.closeLatest(1012, "rotate hosted Canvas route");
    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnectCount);
    await preview.getByText("Connecting to the secure widget host", { exact: false }).waitFor();
    expect(await preview.locator("iframe").count()).toBe(0);
    expect(bareRequests).toEqual([]);

    await gateway.resolveDeferred("connect");
    const frame = preview.locator("iframe");
    await frame.waitFor();
    expect(await frame.getAttribute("src")).toBe(`${signedSurface}${documentPath}`);
    await expect
      .poll(() => preview.frameLocator("iframe").locator("[data-hosted-canvas]").textContent())
      .toBe("Hosted Canvas ready");
    expect(bareRequests).toEqual([]);
  });

  it("hides session controls omitted by the projected Gateway hello", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      featureMethods: [
        "chat.startup",
        "sessions.companion.ask",
        "sessions.companion.reset",
        "sessions.companion.state",
        "sessions.fork",
        "sessions.steer",
      ],
      historyMessages: [{ role: "user", content: "Keep this session bounded." }],
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await page.getByText("Keep this session bounded.").waitFor({ timeout: 10_000 });
    expect(await page.locator(".chat-workspace-toggle").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Rewind" }).count()).toBe(0);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
  });

  it("shows the first-run guide and keeps the compact quick actions available", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page, {
      ...PLATFORMCLAW_WEB_DESCRIPTOR,
      vocEnabled: true,
    });
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    await page.route("**/platformclaw/api/execution", (route) =>
      route.fulfill({
        json: {
          accountId: "person.one",
          activeTarget: "platform_server",
          assignment: null,
          availableVms: [],
          credentialStatus: "missing",
          targetRevision: 0,
        },
        status: 200,
      }),
    );
    await page.route("**/platformclaw/api/skill-hub/config", (route) =>
      route.fulfill({
        json: {
          namespaces: ["platform"],
          maxPackageBytes: 10_000_000,
          capabilities: {
            scanner: true,
            forcePublish: false,
            ownerTransfer: false,
            accessControl: false,
            notifications: true,
            zipUpload: true,
          },
          installTargets: [
            { target: "platform_server", available: true, status: "ready" },
            { target: "assigned_vm", available: false, status: "unavailable" },
          ],
          admin: false,
          notifications: { unreadCount: 0 },
        },
        status: 200,
      }),
    );
    await page.route("**/platformclaw/api/skill-hub/search?**", (route) =>
      route.fulfill({ json: { items: [], total: 0 }, status: 200 }),
    );
    await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      featureCapabilities: ["platformclaw.personal-vm-terminal"],
      methodResponses: { "terminal.open": { sessionId: "guide-terminal" } },
      operatorScopes: ["operator.read", "operator.write"],
      sessionKey: "agent:person_one:main",
      terminalEnabled: true,
    });

    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    const quickActions = page.locator("platformclaw-quick-actions");
    await expect.poll(() => quickActions.isVisible()).toBe(true);
    await expect
      .poll(() => quickActions.getByRole("button", { name: "VOC" }).isVisible())
      .toBe(true);
    await expect.poll(() => page.locator(".tour-popover").isVisible()).toBe(true);
    await expect
      .poll(() => page.getByRole("heading", { name: "Welcome to PlatformClaw" }).isVisible())
      .toBe(true);

    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05-first-run-guide.png"),
      });
    }

    const sidebarGuideSteps = [
      ["Home: start a conversation with your Agent", "05a-01-home-guide.png"],
      ["Terminal: run commands while you chat", "05a-01b-terminal-guide.png"],
      ["Usage: understand tokens and cost", "05a-02-usage-guide.png"],
      ["Tasks: follow assigned work", "05a-03-tasks-guide.png"],
      ["Threads: continue an earlier conversation", "05a-04-threads-guide.png"],
      ["Activity: inspect what the Agent did", "05a-05-activity-guide.png"],
      ["Automations: schedule recurring work", "05a-06-automations-guide.png"],
    ] as const;
    for (const [heading, screenshot] of sidebarGuideSteps) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect.poll(() => page.getByRole("heading", { name: heading }).isVisible()).toBe(true);
      await expect.poll(() => page.locator(".tour-highlight").isVisible()).toBe(true);
      await expect
        .poll(() => page.locator(".tour-highlight").evaluate((element) => element.clientHeight))
        .toBeGreaterThanOrEqual(40);
      if (heading.startsWith("Terminal:")) {
        await expect.poll(() => page.locator(".chat-terminal-toggle").isVisible()).toBe(true);
      }
      if (heading.startsWith("Usage:")) {
        await expect
          .poll(() =>
            page
              .getByText("input tokens, output tokens, and cost trends", { exact: false })
              .isVisible(),
          )
          .toBe(true);
      }
      if (captureUiProofEnabled) {
        await page.screenshot({
          fullPage: true,
          path: path.join(proofDir, screenshot),
        });
      }
    }

    await page.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() =>
        page
          .getByRole("heading", { name: "Skills: instructions your Agent can reuse" })
          .isVisible(),
      )
      .toBe(true);
    await expect.poll(() => page.url().endsWith("/skills")).toBe(true);
    await expect.poll(() => page.locator(".plugins-hub-tabs-row").count()).toBe(0);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05a-07-skills-guide.png"),
      });
    }

    await page.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() =>
        page.getByRole("heading", { name: "Workshop: review skill changes safely" }).isVisible(),
      )
      .toBe(true);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05a-08-workshop-guide.png"),
      });
    }

    await page.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() =>
        page
          .getByRole("heading", { name: "Skill Hub: install and share company skills" })
          .isVisible(),
      )
      .toBe(true);
    await expect.poll(() => page.url().endsWith("/skills/hub")).toBe(true);
    await expect.poll(() => page.locator(".plugins-hub-tabs-row").count()).toBe(0);
    await expect
      .poll(() => page.getByText("No Skill Hub results", { exact: true }).isVisible())
      .toBe(true);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05a-09-skill-hub-guide.png"),
      });
    }

    await page.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() => page.getByRole("heading", { name: "Choose where work runs" }).isVisible())
      .toBe(true);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05a-10-work-location-guide.png"),
      });
    }

    await runPlatformClawSettingsAndMemoryGuide({
      captureUiProofEnabled,
      page,
      proofDir,
      quickActions,
    });
  });

  it("renders standalone plugin destinations for members and administrators", async () => {
    for (const globalRole of ["member", "admin"] as const) {
      const { page } = await newPage();
      await installPlatformClawDocument(page);
      await page.route("**/platformclaw/api/auth/session", (route) =>
        route.fulfill({ json: activeSession(globalRole), status: 200 }),
      );
      await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: "person_one",
        featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        operatorScopes: ["operator.read", "operator.write", "operator.admin"],
        sessionKey: "agent:person_one:main",
      });

      await page.goto(`${server.baseUrl}platformclaw/app/chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const destinations = [
        ["skills", "Skills", "/platformclaw/app/skills"],
        ["skill-workshop", "Skill Workshop", "/platformclaw/app/skills/workshop"],
        ["skill-hub", "Skill Hub", "/platformclaw/app/skills/hub"],
      ] as const;
      for (const [route, label, href] of destinations) {
        const entry = sidebar.locator(`[data-sidebar-entry="route:${route}"] > .nav-item`);
        await expect.poll(() => entry.isVisible()).toBe(true);
        await expect.poll(() => entry.locator(".nav-item__text").textContent()).toBe(label);
        await expect.poll(() => entry.getAttribute("href")).toBe(href);
      }
      await expect
        .poll(() => sidebar.locator('[data-sidebar-entry="route:plugins"]').count())
        .toBe(0);
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, `${globalRole}-plugin-destinations.png`),
        });
      }
    }
  });

  it("opens the owned-agent self-service surface through the cookie-authenticated proxy", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    let personalConfigured = false;
    await page.route("**/platformclaw/api/mcp/credential", async (route) => {
      expect(route.request().method()).toBe("PUT");
      expect(route.request().postDataJSON()).toEqual({
        serverName: "docs",
        kind: "api_key",
        secret: "employee-secret",
      });
      personalConfigured = true;
      await route.fulfill({ json: { serverName: "docs", revision: 1 }, status: 200 });
    });
    await page.route("**/platformclaw/api/mcp", (route) =>
      route.fulfill({
        json: {
          servers: [
            {
              serverName: "docs",
              auth: "api_key",
              headerName: "X-Approved-Key",
              configured: personalConfigured,
            },
          ],
        },
      }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      assistantName: "Person One Agent",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
      methodResponses: {
        "agents.files.list": {
          agentId: "person_one",
          workspace: "personal workspace",
          files: [
            { name: "USER.md", path: "USER.md", missing: false, size: 38 },
            { name: "MEMORY.md", path: "MEMORY.md", missing: false, size: 24 },
          ],
        },
        "agents.files.get": {
          agentId: "person_one",
          workspace: "personal workspace",
          file: {
            name: "USER.md",
            path: "USER.md",
            missing: false,
            content: "# Person One\n\nPlatform Lab employee.",
          },
        },
        "skills.status": {
          workspaceDir: "personal workspace",
          managedSkillsDir: "managed skills",
          agentId: "person_one",
          skills: [
            {
              name: "Reports",
              description: "Create and review technical reports.",
              source: "managed",
              skillKey: "reports",
              bundled: false,
              always: false,
              disabled: false,
              blockedByAllowlist: false,
              blockedByAgentFilter: false,
              eligible: true,
              platformIncompatible: false,
              modelVisible: true,
              userInvocable: true,
              commandVisible: true,
              requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
              missing: { bins: [], env: [], config: [], os: [] },
              configChecks: [],
              install: [],
            },
          ],
        },
      },
    });

    await page.goto(`${server.baseUrl}platformclaw/app/agents`);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/agents");
    await expect
      .poll(() => page.getByText("Person One Agent", { exact: true }).first().isVisible())
      .toBe(true);
    await page.getByRole("button", { name: /Person One Agent/ }).click();
    await expect.poll(() => page.getByRole("tab", { name: "Files" }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("tab", { name: "Skills" }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("tab", { name: "Overview" }).count()).toBe(0);
    await expect.poll(() => page.getByRole("tab", { name: "Tools" }).count()).toBe(0);
    await expect.poll(() => page.getByRole("tab", { name: "Channels" }).count()).toBe(0);
    await page.getByRole("tab", { name: "USER" }).click();
    await expect
      .poll(() => page.locator(".agent-file-textarea").inputValue())
      .toContain("Platform Lab employee.");
    await page.getByRole("tab", { name: "Skills" }).click();
    await gateway.waitForRequest("skills.status");
    await expect.poll(() => page.getByRole("button", { name: "Save" }).count()).toBe(0);
    await page.getByRole("tab", { name: "Files" }).click();
    await page.goto(`${server.baseUrl}platformclaw/app/skills`);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/skills");
    await expect.poll(() => page.locator("openclaw-skills-page").isVisible()).toBe(true);
    await expect.poll(() => page.getByText("Reports").first().isVisible()).toBe(true);
    await expect
      .poll(() => page.getByRole("heading", { name: "Skills", exact: true }).isVisible())
      .toBe(true);
    await expect.poll(() => page.locator(".plugins-hub-tabs-row").count()).toBe(0);
    await openPlatformClawMcpSettings(page);
    expect(await gateway.getRequests("config.get")).toHaveLength(1);

    const connect = (await gateway.getRequests("connect"))[0];
    expect(connect).toBeDefined();
    expect(connect?.params).not.toMatchObject({ auth: expect.anything() });
    expect(connect?.params).not.toMatchObject({ device: expect.anything() });
    expect(await gateway.getSocketUrls()).toContain(
      `${server.baseUrl.replace("http:", "ws:")}platformclaw/gateway`,
    );

    const mcpSettings = page.locator("platformclaw-mcp-settings");
    await expect
      .poll(() => mcpSettings.getByRole("heading", { name: "Your MCP credentials" }).isVisible())
      .toBe(true);
    await expect.poll(() => mcpSettings.getByLabel("API key for docs").isVisible()).toBe(true);
    await mcpSettings.getByLabel("API key for docs").fill("employee-secret");
    await mcpSettings.getByRole("button", { name: "Save credentials for docs" }).click();
    await expect
      .poll(() => mcpSettings.getByText("Connected", { exact: true }).isVisible())
      .toBe(true);

    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "02-personal-mcp-settings.png"),
      });
    }
  });

  it("keeps browser diagnostics and settings text selectable", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
    const intro = page.locator(".settings-page__intro");
    await expect.poll(() => intro.isVisible()).toBe(true);
    expect(
      await page.evaluate(() => ({
        hosted: document.documentElement.hasAttribute("data-platformclaw-hosted"),
        selection: getComputedStyle(document.querySelector<HTMLElement>(".content")!).userSelect,
      })),
    ).toEqual({ hosted: true, selection: "text" });
    expect(await dragAcross(page, ".settings-page__intro")).not.toBe("");

    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "04-selectable-settings-text.png"),
      });
    }
  });

  it("uses PlatformClaw identity and mascot across hosted product surfaces", async () => {
    const { page } = await newPage({ height: 844, width: 390 });
    await installPlatformClawDocument(page);
    await page.addInitScript(() => {
      localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
    });
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    await installMockGateway(page, {
      assistantName: "Person One Agent",
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await expect.poll(() => page.title()).toMatch(/PlatformClaw$/u);
    await expect
      .poll(() => page.getByRole("heading", { name: "Person One Agent" }).isVisible())
      .toBe(true);
    await expect
      .poll(() =>
        page.locator(".agent-chat__welcome openclaw-mascot .platformclaw-mascot").isVisible(),
      )
      .toBe(true);
    await expect
      .poll(() => page.locator("openclaw-app-sidebar openclaw-lobster-pet").count())
      .toBe(0);
    if (captureUiProofEnabled) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "06-platformclaw-chat-mobile.png"),
      });
    }

    await page.goto(`${server.baseUrl}platformclaw/app/settings/profile`);
    const topbarBrand = page.locator(".topbar-brand");
    await expect.poll(() => topbarBrand.isVisible()).toBe(true);
    await expect.poll(() => topbarBrand.getAttribute("aria-label")).toBe("PlatformClaw");
    await expect
      .poll(() => topbarBrand.locator(".topbar-brand__title").textContent())
      .toBe("PlatformClaw");
    await expect
      .poll(() => page.locator(".profile-hero__badge").textContent())
      .toBe("PlatformClaw");
    await expect.poll(() => page.locator(".profile-hero__avatar-image--product").count()).toBe(1);
    if (captureUiProofEnabled) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "07-platformclaw-profile-mobile.png"),
      });
    }

    await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
    await expect.poll(() => page.locator("#settings-appearance-theme").count()).toBe(1);
    await expect.poll(() => page.getByText("Lobsterdex", { exact: true }).count()).toBe(0);
    if (captureUiProofEnabled) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "08-platformclaw-appearance-mobile.png"),
      });
    }

    await page.goto(`${server.baseUrl}platformclaw/app/settings/about`);
    await expect.poll(() => page.locator(".about-hero__name").textContent()).toBe("PlatformClaw");
    await expect.poll(() => page.locator(".about-hero__platformclaw-mascot").count()).toBe(1);
    await expect.poll(() => page.locator(".about-hero__clawd svg").count()).toBe(0);

    if (captureUiProofEnabled) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "09-platformclaw-about-mobile.png"),
      });
    }
  });
});
