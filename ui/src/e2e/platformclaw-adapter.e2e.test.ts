import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "platformclaw-adapter");

let server: ControlUiE2eServer;
let browser: Browser;
const contexts = new Set<BrowserContext>();

async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    locale: "en-US",
    ...(captureUiProofEnabled
      ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
      : {}),
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
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

function activeSession() {
  return {
    authenticated: true,
    user: {
      accountId: "person.one",
      displayName: "Person One",
      department: "Platform Lab",
      globalRole: "member",
    },
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
      sessionKey: "agent:person_one:main",
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
      ["Usage: understand tokens and cost", "05a-02-usage-guide.png"],
      ["Tasks: follow assigned work", "05a-03-tasks-guide.png"],
      ["Threads: continue an earlier conversation", "05a-04-threads-guide.png"],
      ["Activity: inspect what the Agent did", "05a-05-activity-guide.png"],
      ["Automations: schedule recurring work", "05a-06-automations-guide.png"],
      ["Plugins: extend Agent capabilities", "05a-07-plugins-guide.png"],
    ] as const;
    let previousHighlightTop = -1;
    for (const [heading, screenshot] of sidebarGuideSteps) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect.poll(() => page.getByRole("heading", { name: heading }).isVisible()).toBe(true);
      await expect.poll(() => page.locator(".tour-highlight").isVisible()).toBe(true);
      await expect
        .poll(() => page.locator(".tour-highlight").evaluate((element) => element.clientHeight))
        .toBeGreaterThanOrEqual(40);
      await expect
        .poll(() =>
          page
            .locator(".tour-highlight")
            .evaluate((element) => element.getBoundingClientRect().top),
        )
        .toBeGreaterThan(previousHighlightTop + 10);
      previousHighlightTop = await page
        .locator(".tour-highlight")
        .evaluate((element) => element.getBoundingClientRect().top);
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
      .poll(() => page.getByRole("heading", { name: "Choose where work runs" }).isVisible())
      .toBe(true);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05a-08-work-location-guide.png"),
      });
    }

    await page.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() => page.getByRole("heading", { name: "Understand the Plugins hub" }).isVisible())
      .toBe(true);
    await expect.poll(() => page.url().endsWith("/skills")).toBe(true);
    await expect.poll(() => page.locator(".plugins-hub-tabs-row").isVisible()).toBe(true);
    await expect.poll(() => page.locator(".tour-shade").count()).toBe(4);
    await expect.poll(() => page.getByText("LOOK HERE", { exact: true }).isVisible()).toBe(true);
    await expect
      .poll(() => page.getByText("Skill Hub is the company catalog", { exact: false }).isVisible())
      .toBe(true);

    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05b-plugin-guide.png"),
      });
    }

    await page.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() =>
        page
          .getByRole("heading", { name: "Skills: instructions your Agent can reuse" })
          .isVisible(),
      )
      .toBe(true);
    await expect.poll(() => page.locator("#plugins-tab-skills").isVisible()).toBe(true);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05c-skills-guide.png"),
      });
    }

    await page.getByRole("button", { name: "Next" }).click();
    await expect
      .poll(() =>
        page.getByRole("heading", { name: "Workshop: review skill changes safely" }).isVisible(),
      )
      .toBe(true);
    await expect.poll(() => page.url().endsWith("/skills/workshop")).toBe(true);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05d-workshop-guide.png"),
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
    await expect
      .poll(() => page.getByText("No Skill Hub results", { exact: true }).isVisible())
      .toBe(true);
    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "05e-skill-hub-guide.png"),
      });
    }

    await page.getByRole("button", { name: "Don't show again" }).click();
    await expect.poll(() => page.locator(".tour-popover").count()).toBe(0);
    expect(
      await page.evaluate(() => localStorage.getItem("platformclaw.product-tour.v1.completed")),
    ).toBe("true");

    await page.reload();
    await expect
      .poll(() => quickActions.getByRole("button", { name: "Guide" }).isVisible())
      .toBe(true);
    await expect.poll(() => page.locator(".tour-popover").count()).toBe(0);
    await quickActions.getByRole("button", { name: "Guide" }).click();
    await expect.poll(() => page.locator(".tour-popover").isVisible()).toBe(true);
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
      .poll(() => page.getByText("Person One", { exact: true }).first().isVisible())
      .toBe(true);
    await expect.poll(() => page.getByText("Platform Lab").isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("button", { name: "Files" }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("button", { name: "Skills" }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("button", { name: "Overview" }).count()).toBe(0);
    await expect.poll(() => page.getByRole("button", { name: "Tools" }).count()).toBe(0);
    await expect.poll(() => page.getByRole("button", { name: "Channels" }).count()).toBe(0);
    await page.getByRole("button", { name: "USER" }).click();
    await expect
      .poll(() => page.locator(".agent-file-textarea").inputValue())
      .toContain("Platform Lab employee.");
    await page.getByRole("button", { name: "Skills" }).click();
    await expect.poll(() => page.getByText("Reports").first().isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("button", { name: "Save" }).count()).toBe(0);
    await page.getByRole("button", { name: "Files" }).click();
    await expect.poll(() => page.getByRole("link", { name: "Threads" }).isVisible()).toBe(true);
    await page.getByRole("link", { name: "Plugins" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/skills");
    await expect.poll(() => page.getByText("Reports").first().isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("tab", { name: "Skills" }).isVisible()).toBe(true);
    await expect.poll(() => page.getByRole("tab", { name: "Workshop" }).isVisible()).toBe(true);
    await openPlatformClawMcpSettings(page);
    expect(await gateway.getRequests("config.get")).toHaveLength(0);

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

  it("opens standalone Memory for the assigned agent without config.get", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      featureMethods: [
        "agents.list",
        "doctor.memory.status",
        "doctor.memory.dreamDiary",
        "wiki.overview",
        "wiki.get",
      ],
      methodResponses: {
        "agents.list": {
          agents: [{ id: "person_one", name: "Person One Agent" }],
          defaultId: "person_one",
          mainKey: "person_one",
          scope: "agent",
        },
        "doctor.memory.status": {
          agentId: "person_one",
          provider: "builtin",
          embedding: { ok: true, checked: true },
          dreaming: {
            enabled: true,
            verboseLogging: false,
            storageMode: "inline",
            separateReports: false,
            shortTermCount: 1,
            recallSignalCount: 1,
            dailySignalCount: 1,
            groundedSignalCount: 1,
            totalSignalCount: 3,
            phaseSignalCount: 1,
            lightPhaseHitCount: 1,
            remPhaseHitCount: 0,
            promotedTotal: 4,
            promotedToday: 1,
            shortTermEntries: [],
            signalEntries: [],
            promotedEntries: [],
            phases: {},
          },
        },
        "doctor.memory.dreamDiary": {
          agentId: "person_one",
          found: true,
          path: "DREAMS.md",
          content: "# Dream Diary\n\nAssigned personal memory was consolidated.",
        },
        "wiki.overview": {
          totalItems: 1,
          totalPages: 1,
          pageCounts: { entity: 0, concept: 0, source: 0, synthesis: 1, report: 0 },
          totalClaims: 1,
          totalQuestions: 0,
          totalContradictions: 0,
          clusters: [
            {
              key: "synthesis",
              label: "Syntheses",
              itemCount: 1,
              claimCount: 1,
              questionCount: 0,
              contradictionCount: 0,
              items: [
                {
                  pagePath: "syntheses/person-one.md",
                  title: "Person One knowledge",
                  kind: "synthesis",
                  claimCount: 1,
                  questionCount: 0,
                  contradictionCount: 0,
                  claims: ["Employee browser access stays agent scoped."],
                  questions: [],
                  contradictions: [],
                  snippet: "Compiled knowledge for the assigned personal agent.",
                },
              ],
            },
          ],
        },
        "wiki.get": {
          title: "Person One knowledge",
          path: "syntheses/person-one.md",
          content: "# Person One knowledge\n\nEmployee browser access stays agent scoped.",
          totalLines: 3,
          truncated: false,
        },
      },
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/settings/agents/person_one/files`);
    const settingsSidebar = page.locator(".settings-sidebar");
    await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
    await settingsSidebar.getByRole("link", { name: "Memory", exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/settings/memory");
    await expect.poll(() => page.locator(".page-title").textContent()).toContain("Memory");
    await page.getByRole("tab", { name: "Diary", exact: true }).click();
    const diary = page.locator(".dreams-diary");
    await expect
      .poll(() => diary.textContent())
      .toContain("Assigned personal memory was consolidated.");
    await diary.getByRole("tab", { name: "Memory Wiki", exact: true }).click();
    await expect.poll(() => diary.textContent()).toContain("Person One knowledge");
    await diary.getByRole("button", { name: "Open wiki page" }).click();
    await expect
      .poll(() => page.locator(".dreams-diary__preview-pre").textContent())
      .toContain("Employee browser access stays agent scoped.");

    expect(await gateway.getRequests("config.get")).toHaveLength(0);
    expect(await page.getByText("foreign-agent", { exact: false }).count()).toBe(0);
    for (const method of ["doctor.memory.dreamDiary", "wiki.overview", "wiki.get"]) {
      const requests = await gateway.getRequests(method);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.params).toMatchObject({ agentId: "person_one" });
      }
    }

    if (captureUiProofEnabled) {
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "06-memory-wiki-from-settings.png"),
      });
    }

    await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/dreams`);
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe("/platformclaw/app/settings/memory/dreams");
    await expect.poll(() => page.locator("openclaw-agent-memory-panel").isVisible()).toBe(true);
    expect(await gateway.getRequests("config.get")).toHaveLength(0);
  });

  it("shows the current work location and blocks a proposal for another target", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    await installMockGateway(page, {
      basePath: "/platformclaw/app",
      assistantName: "Person One Agent",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
      methodResponses: {
        "skills.status": {
          agentId: "person_one",
          executionTarget: "platform_server",
          managedSkillsDir: "managed skills",
          skills: [],
          workspaceDir: "personal workspace",
        },
        "skills.proposals.inspect": {
          content: "Create a deterministic VM report workflow.",
          record: {
            createdAt: "2026-08-01T12:00:00.000Z",
            description: "Prepare reports on the assigned VM.",
            id: "proposal-vm-report",
            kind: "create",
            proposedVersion: "v1",
            status: "pending",
            target: {
              skillKey: "vm-report",
              skillName: "VM Report",
              targetLabel: "Development VM",
            },
            title: "VM Report",
            updatedAt: "2026-08-01T12:00:00.000Z",
          },
          supportFiles: [],
        },
        "skills.proposals.list": {
          proposals: [
            {
              createdAt: "2026-08-01T12:00:00.000Z",
              description: "Prepare reports on the assigned VM.",
              id: "proposal-vm-report",
              kind: "create",
              scanState: "clean",
              skillKey: "vm-report",
              skillName: "VM Report",
              status: "pending",
              targetLabel: "Development VM",
              title: "VM Report",
              updatedAt: "2026-08-01T12:00:00.000Z",
            },
          ],
          schema: "openclaw.skill-workshop.proposals-manifest.v1",
          updatedAt: "2026-08-01T12:00:00.000Z",
        },
      },
    });

    const response = await page.goto(`${server.baseUrl}platformclaw/app/skills/workshop`);
    expect(response?.status()).toBe(200);
    await expect
      .poll(() => page.getByText("Current work location: Basic workspace").isVisible())
      .toBe(true);
    await expect
      .poll(() => page.getByText("Target: Development VM").first().isVisible())
      .toBe(true);
    await expect
      .poll(() => page.getByText(/This proposal belongs to Development VM/).isVisible())
      .toBe(true);
    const actions = page.locator(".sw-action-bar button, .sw-today__actions button");
    await expect.poll(() => actions.count()).toBe(4);
    await expect.poll(() => actions.nth(0).isDisabled()).toBe(true);
    await expect.poll(() => actions.nth(1).isDisabled()).toBe(true);
    await expect.poll(() => actions.nth(2).isDisabled()).toBe(true);
    await expect.poll(() => actions.nth(3).isEnabled()).toBe(true);

    if (captureUiProofEnabled) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "01-personal-skill-workshop-target.png"),
      });
    }
  });

  it("gives administrators a discoverable MCP registration screen", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({
        json: {
          ...activeSession(),
          user: { ...activeSession().user, globalRole: "admin" },
        },
        status: 200,
      }),
    );
    const personalServers: Array<Record<string, unknown>> = [];
    await page.route("**/platformclaw/api/mcp", (route) =>
      route.fulfill({ json: { servers: personalServers }, status: 200 }),
    );
    const servers: Array<Record<string, unknown>> = [];
    await page.route("**/platformclaw/api/admin/mcp", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        expect(body).toMatchObject({
          action: "save-server",
          name: "docs",
          url: "https://docs.example/mcp",
          credentialMode: "personal",
          auth: "bearer",
          blockedTools: [],
        });
        personalServers.splice(0, personalServers.length, {
          serverName: "docs",
          auth: "bearer",
          configured: false,
        });
        servers.splice(0, servers.length, {
          name: "docs",
          enabled: true,
          transport: "streamable-http",
          target: "https://docs.example/mcp",
          editable: true,
          credentialMode: "personal",
          personalAuth: "bearer",
          toolPolicy: "all",
          blockedTools: [],
        });
      }
      await route.fulfill({ json: { servers }, status: 200 });
    });
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
      operatorScopes: ["operator.read", "operator.write", "operator.admin"],
    });

    await openPlatformClawMcpSettings(page);
    const admin = page.locator("platformclaw-mcp-administration");
    await expect
      .poll(() => admin.getByRole("heading", { name: "MCP server administration" }).isVisible())
      .toBe(true);
    await admin.getByRole("button", { name: "Add MCP server" }).click();
    await admin.getByLabel("Server name").fill("docs");
    await admin.getByLabel("Server URL").fill("https://docs.example/mcp");
    await admin.getByLabel("Credential policy").selectOption("personal");
    await admin.getByLabel("Credential type").selectOption("bearer");
    const configGetCountBeforeSave = (await gateway.getRequests("config.get")).length;
    await admin.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => admin.getByText("docs", { exact: true }).isVisible()).toBe(true);
    await expect.poll(() => admin.getByText("All tools allowed").isVisible()).toBe(true);
    await expect
      .poll(() => admin.getByText("Each employee connects their own credential").isVisible())
      .toBe(true);
    const personal = page.locator("platformclaw-mcp-settings");
    await expect.poll(() => personal.getByLabel("Bearer token for docs").isVisible()).toBe(true);
    expect(await gateway.getRequests("config.get")).toHaveLength(configGetCountBeforeSave);
    expect(await gateway.getRequests("config.set")).toHaveLength(0);
    expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    expect(await gateway.getRequests("config.apply")).toHaveLength(0);

    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "03-admin-mcp-settings.png"),
      });
    }
  });

  it("gives members a discoverable personal MCP credential screen", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    let configured = false;
    await page.route("**/platformclaw/api/mcp/credential", async (route) => {
      expect(route.request().method()).toBe("PUT");
      expect(route.request().postDataJSON()).toEqual({
        serverName: "docs",
        kind: "api_key",
        secret: "employee-secret",
      });
      configured = true;
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
              configured,
            },
          ],
        },
        status: 200,
      }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
      operatorScopes: ["operator.read", "operator.write"],
    });

    await openPlatformClawMcpSettings(page);
    const settings = page.locator("platformclaw-mcp-settings");
    await expect
      .poll(() => settings.getByRole("heading", { name: "Your MCP credentials" }).isVisible())
      .toBe(true);
    await expect.poll(() => settings.getByLabel("API key for docs").isVisible()).toBe(true);
    await settings.getByLabel("API key for docs").fill("employee-secret");
    await settings.getByRole("button", { name: "Save credentials for docs" }).click();
    await expect
      .poll(() => settings.getByText("Connected", { exact: true }).isVisible())
      .toBe(true);
    expect(await gateway.getRequests("config.get")).toHaveLength(0);

    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "02-personal-mcp-settings.png"),
      });
    }
  });

  it("lets an employee create a personal automation without operator.admin", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({ json: activeSession(), status: 200 }),
    );
    const createdJob = {
      id: "employee-automation",
      name: "Daily workspace summary",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      configRevision: "revision-1",
      agentId: "person_one",
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Summarize my workspace." },
      delivery: { mode: "none" },
    };
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: [
        "cron.add",
        "cron.get",
        "cron.list",
        "cron.remove",
        "cron.run",
        "cron.runs",
        "cron.status",
        "cron.update",
        "models.list",
      ],
      methodResponses: {
        "cron.add": { created: true, job: createdJob },
        "cron.list": { jobs: [], total: 0, offset: 0, hasMore: false },
        "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
        "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
        "models.list": {
          models: [
            { id: "openai/gpt-5.2", name: "GPT-5.2", provider: "openai" },
            { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
          ],
        },
      },
    });

    await page.goto(`${server.baseUrl}platformclaw/app/cron`);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/cron");
    await expect.poll(() => page.getByText("Browsing only").count()).toBe(0);
    await page.locator('[data-test-id="cron-new-task"]').click();
    await page.locator("#cron-name").fill("Daily workspace summary");
    await page.locator("#cron-payload-text").fill("Summarize my workspace.");
    await expect.poll(() => page.locator(".agent-scope-control").count()).toBe(0);
    await expect.poll(() => page.locator("#cron-agent-id").getAttribute("readonly")).toBe("");
    await expect
      .poll(() => page.locator("#cron-payload-model option").allTextContents())
      .toEqual(["Use default", "anthropic/claude-sonnet-4", "openai/gpt-5.2"]);
    await expect
      .poll(() => page.locator("#cron-delivery-mode option").allTextContents())
      .toEqual(["Send to last conversation", "None (internal)"]);
    await page.locator("#cron-payload-model").selectOption("openai/gpt-5.2");

    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "03-personal-automation-editor.png"),
      });
    }

    await page.locator('[data-test-id="cron-submit"]').click();
    const addRequest = await gateway.waitForRequest("cron.add");
    expect(addRequest.params).toMatchObject({
      agentId: "person_one",
      delivery: { mode: "announce" },
      failureAlert: false,
      name: "Daily workspace summary",
      payload: {
        kind: "agentTurn",
        message: "Summarize my workspace.",
        model: "openai/gpt-5.2",
      },
    });
  });

  it("redirects to login when a policy close confirms session expiry", async () => {
    const { page } = await newPage();
    await installPlatformClawDocument(page);
    let sessionActive = true;
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({
        json: sessionActive ? activeSession() : { authenticated: false },
        status: 200,
      }),
    );
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await expect.poll(() => page.getByText("Person One").isVisible()).toBe(true);
    sessionActive = false;
    await gateway.closeLatest(1008, "session expired");

    await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/login");
  });
});
