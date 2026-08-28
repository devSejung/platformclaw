import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
        "memory.search",
        "platformclaw.memory.lifecycle",
        "wiki.search",
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
        "platformclaw.memory.lifecycle": {
          scopes: [],
          personalTargets: [],
          claims: [],
          submitted: [],
          reviewable: [],
          canApproveGlobal: false,
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
    const memoryTabs = page.locator(".platformclaw-memory-page__tabs");
    await expect.poll(() => memoryTabs.getByRole("tab").count()).toBe(5);
    await memoryTabs.getByRole("tab", { name: "Dreaming", exact: true }).click();
    await page.getByRole("tab", { name: "Dream Diary", exact: true }).click();
    const diary = page.locator(".dreams-diary");
    await expect
      .poll(() => diary.textContent())
      .toContain("Assigned personal memory was consolidated.");
    await memoryTabs.getByRole("tab", { name: "Personal Wiki", exact: true }).click();
    const wiki = page.locator(".memory-wiki-page");
    await expect.poll(() => wiki.textContent()).toContain("Person One knowledge");
    await wiki.getByRole("button", { name: "Open wiki page" }).click();
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
      .poll(() =>
        page
          .locator("platformclaw-memory-page")
          .evaluate((element) => (element as HTMLElement & { initialTab: string }).initialTab),
      )
      .toBe("dreaming");
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
    expect(await gateway.getRequests("config.get")).toHaveLength(1);

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
    await page.addInitScript(() => {
      localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
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
      .poll(async () =>
        (await page.locator("#cron-payload-model option").allTextContents()).map((label) =>
          label.trim(),
        ),
      )
      .toEqual(["Use default", "anthropic/claude-sonnet-4", "openai/gpt-5.2"]);
    await expect
      .poll(async () =>
        (await page.locator("#cron-delivery-mode option").allTextContents()).map((label) =>
          label.trim(),
        ),
      )
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
