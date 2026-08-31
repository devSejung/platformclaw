import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  controlUiBundledGatewayUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "memory-product-experience",
);
const assignedAgentId = "assigned-personal";

let browser: Browser;
let server: ControlUiE2eServer;

const memoryMethods = [
  "agents.list",
  "agents.workspace.get",
  "agents.workspace.list",
  "doctor.memory.dreamDiary",
  "doctor.memory.status",
  "memory.search",
  "platformclaw.memory.get",
  "platformclaw.memory.lifecycle",
  "wiki.get",
  "wiki.overview",
  "wiki.search",
];

const personalRoster = {
  agents: [{ id: assignedAgentId, name: "Assigned Personal Agent" }],
  defaultId: assignedAgentId,
  mainKey: assignedAgentId,
  scope: "agent",
};

const populatedResponses: NonNullable<ControlUiMockGatewayScenario["methodResponses"]> = {
  "agents.list": personalRoster,
  "agents.workspace.get": {
    cases: [
      {
        match: { agentId: assignedAgentId, path: "MEMORY.md" },
        response: {
          file: {
            path: "MEMORY.md",
            name: "MEMORY.md",
            encoding: "utf8",
            content:
              "# Long-term memory\n\nThe release checklist starts with a bounded canary and an owner check.",
            updatedAtMs: 1_778_457_600_000,
          },
        },
      },
      {
        match: { agentId: assignedAgentId, path: "memory/2026-08-31.md" },
        response: {
          file: {
            path: "memory/2026-08-31.md",
            name: "2026-08-31.md",
            encoding: "utf8",
            content:
              "# 2026-08-31\n\nRelease preflight completed. Canary stayed healthy for thirty minutes.",
            updatedAtMs: 1_778_457_600_000,
          },
        },
      },
    ],
  },
  "agents.workspace.list": {
    entries: Array.from({ length: 9 }, (_, index) => {
      const day = 31 - index;
      return {
        path: `memory/2026-08-${String(day).padStart(2, "0")}.md`,
        name: `2026-08-${String(day).padStart(2, "0")}.md`,
        updatedAtMs: 1_778_457_600_000 - index * 86_400_000,
      };
    }),
    hasAdditionalFolders: true,
  },
  "memory.search": {
    agentId: assignedAgentId,
    provider: "builtin",
    searchMode: "hybrid",
    stale: true,
    results: [
      {
        source: "memory",
        corpus: "workspace-memory",
        path: "memory/2026-08-31.md",
        snippet: "Release preflight completed. Canary stayed healthy.",
        score: 0.98,
        startLine: 2,
        endLine: 3,
      },
      {
        source: "organization",
        corpus: "platformclaw-organization",
        path: "organization/group/group-platform",
        title: "Platform release policy",
        kind: "group",
        provenanceLabel: "Platform",
        snippet: "Two approvals are required before production rollout.",
        score: 0.91,
        startLine: 1,
        endLine: 1,
      },
    ],
  },
  "wiki.search": [
    {
      path: "syntheses/release-preflight.md",
      title: "Release preflight synthesis",
      kind: "synthesis",
      score: 0.94,
      snippet: "Canary health and owner checks should be recorded together.",
      startLine: 1,
      endLine: 2,
    },
  ],
  "wiki.get": {
    content: "# Release preflight synthesis\n\nRecord canary health and the responsible owner.",
    fromLine: 1,
    lineCount: 3,
  },
  "platformclaw.memory.get": {
    content: "# Platform release policy\n\nTwo approvals are required before production rollout.",
    fromLine: 1,
    lineCount: 3,
  },
  "platformclaw.memory.lifecycle": {
    scopes: [{ kind: "part", id: "part-runtime", name: "Runtime", canAdminister: false }],
    personalTargets: [
      { kind: "part", scopeId: "part-runtime", scopeName: "Runtime", mode: "request" },
    ],
    claims: [],
    submitted: [],
    reviewable: [],
    canApproveGlobal: false,
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
            pagePath: "syntheses/release-preflight.md",
            title: "Release preflight synthesis",
            kind: "synthesis",
            claimCount: 1,
            questionCount: 0,
            contradictionCount: 0,
            claims: ["Record canary health and its owner."],
            questions: [],
            contradictions: [],
            snippet: "Canary and owner checks stay together.",
          },
        ],
      },
    ],
  },
  "doctor.memory.status": {
    agentId: assignedAgentId,
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
    agentId: assignedAgentId,
    found: true,
    path: "DREAMS.md",
    content: "# Dream diary\n\nThe release checklist was consolidated safely.",
  },
};

async function installPlatformClawDocument(page: Page, role: "admin" | "member" = "member") {
  const response = await page.request.get(server.baseUrl);
  const source = await response.text();
  const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      body: source.replace("</head>", `${descriptor}</head>`),
      headers: response.headers(),
      status: response.status(),
    }),
  );
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: `${role}.one`,
          displayName: role === "admin" ? "Admin One" : "Member One",
          department: "Platform",
          globalRole: role,
        },
        agent: { agentId: assignedAgentId, state: "active" },
      },
      status: 200,
    }),
  );
}

async function createContext(params: {
  locale: "en-US" | "ko-KR";
  mode: "dark" | "light";
  viewport: { height: number; width: number };
}) {
  const bundledGatewayUrl = controlUiBundledGatewayUrl(server.baseUrl);
  const appGatewayUrl = `${bundledGatewayUrl}/platformclaw/app`;
  const gatewayUrl = new URL(PLATFORMCLAW_WEB_DESCRIPTOR.gatewayPath, server.baseUrl);
  gatewayUrl.protocol = gatewayUrl.protocol === "https:" ? "wss:" : "ws:";
  const context = await browser.newContext({
    colorScheme: params.mode,
    locale: params.locale,
    serviceWorkers: "block",
    viewport: params.viewport,
  });
  await context.addInitScript(
    ({ appGatewayUrl, bundledGatewayUrl, gatewayUrl, mode }) => {
      for (const scopedGatewayUrl of [appGatewayUrl, bundledGatewayUrl, gatewayUrl]) {
        localStorage.setItem(
          `openclaw.control.settings.v1:${scopedGatewayUrl}`,
          JSON.stringify({
            gatewayUrl: scopedGatewayUrl,
            theme: "platformclaw",
            themeMode: mode,
          }),
        );
      }
      localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
    },
    {
      appGatewayUrl,
      bundledGatewayUrl,
      gatewayUrl: gatewayUrl.href.replace(/\/$/u, ""),
      mode: params.mode,
    },
  );
  return context;
}

async function openMemory(
  context: BrowserContext,
  scenario: ControlUiMockGatewayScenario,
  role: "admin" | "member" = "member",
) {
  const page = await context.newPage();
  await installPlatformClawDocument(page, role);
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: assignedAgentId,
    featureMethods: memoryMethods,
    ...scenario,
  });
  const response = await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/memories`);
  expect(response?.status()).toBe(200);
  await waitForControlUiRoute(page, {
    routeId: "memory",
    pathname: "/platformclaw/app/settings/memory/memories",
  });
  const surface = page.locator("openclaw-memory-memories");
  await expect.poll(() => surface.textContent()).toContain("MEMORY.md");
  return { gateway, page, surface };
}

async function captureScreenshot(page: Page, name: string) {
  if (!capture) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toEqual(expect.objectContaining({ clientWidth: 390, scrollWidth: 390 }));
}

async function expectTheme(page: Page, mode: "dark" | "light") {
  const rendered = await page.evaluate(() => ({
    background: getComputedStyle(document.body).backgroundColor,
    mode: document.documentElement.dataset.themeMode,
    theme: document.documentElement.dataset.theme,
  }));
  expect(rendered).toEqual(
    mode === "dark"
      ? { background: "rgb(24, 23, 21)", mode: "dark", theme: "platformclaw" }
      : { background: "rgb(250, 249, 245)", mode: "light", theme: "platformclaw-light" },
  );
}

async function gatewayPhase(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { gateway: { snapshot: { phase: string } } } };
    };
    return app.runtime?.context.gateway.snapshot.phase;
  });
}

function requestParams(request: { params?: unknown }) {
  return request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? request.params
    : {};
}

suite("PlatformClaw browse-first Memory product experience", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("routes all five tabs with browser history and an accessible shared panel", async () => {
    const context = await createContext({
      locale: "en-US",
      mode: "light",
      viewport: { height: 900, width: 1440 },
    });
    try {
      const page = await context.newPage();
      await installPlatformClawDocument(page);
      const gateway = await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: assignedAgentId,
        featureMethods: memoryMethods,
        methodResponses: populatedResponses,
      });
      await page.goto(`${server.baseUrl}platformclaw/app/settings/memory`);
      await waitForControlUiRoute(page, {
        routeId: "memory",
        pathname: "/platformclaw/app/settings/memory",
      });

      const panel = page.locator("#platformclaw-memory-panel");
      const memoryTabs = page.locator(".platformclaw-memory-page__tabs");
      const expectActive = async (label: string, value: string, pathname: string) => {
        await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
        const tab = memoryTabs.getByRole("tab", { name: label, exact: true });
        await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
        await expect
          .poll(() => panel.getAttribute("aria-labelledby"))
          .toBe(`platformclaw-memory-tab-${value}`);
      };

      await expectActive("Overview", "overview", "/platformclaw/app/settings/memory");
      await memoryTabs.getByRole("tab", { name: "Memory", exact: true }).click();
      await expectActive("Memory", "memory", "/platformclaw/app/settings/memory/memories");
      await expect
        .poll(() => page.locator("openclaw-memory-memories").textContent())
        .toContain("MEMORY.md");

      await memoryTabs.getByRole("tab", { name: "Personal Wiki", exact: true }).click();
      await expectActive("Personal Wiki", "wiki", "/platformclaw/app/settings/memory/wiki");
      await expect
        .poll(() => page.locator("openclaw-agent-memory-panel").textContent())
        .toContain("Release preflight synthesis");

      await memoryTabs.getByRole("tab", { name: "Organization", exact: true }).click();
      await expectActive(
        "Organization",
        "organization",
        "/platformclaw/app/settings/memory/organization",
      );
      await expect
        .poll(() => page.locator("openclaw-memory-promotions").textContent())
        .toContain("Runtime");

      await memoryTabs.getByRole("tab", { name: "Dreaming", exact: true }).click();
      await expectActive("Dreaming", "dreaming", "/platformclaw/app/settings/memory/dreams");
      await expect
        .poll(() => page.locator("openclaw-agent-memory-panel").textContent())
        .toContain("Dreaming");
      const dreamingToggle = page.locator(".dreams__phase-toggle");
      await expect.poll(() => dreamingToggle.isDisabled()).toBe(true);
      await page.locator('.dreams__topbar wa-tab[panel="diary"]').click();
      await expect
        .poll(() => page.locator(".dreams-diary").textContent())
        .toContain("consolidated safely");
      await captureScreenshot(page, "11-dreaming-member-desktop-light.png");

      await memoryTabs.getByRole("tab", { name: "Overview", exact: true }).click();
      await expectActive("Overview", "overview", "/platformclaw/app/settings/memory");
      await page.goBack();
      await expectActive("Dreaming", "dreaming", "/platformclaw/app/settings/memory/dreams");
      await page.goBack();
      await expectActive(
        "Organization",
        "organization",
        "/platformclaw/app/settings/memory/organization",
      );
      await page.goForward();
      await expectActive("Dreaming", "dreaming", "/platformclaw/app/settings/memory/dreams");

      expect(await gateway.getRequests("wiki.get")).toHaveLength(0);
      expect(await gateway.getRequests("platformclaw.memory.get")).toHaveLength(0);
      expect(await gateway.getRequests("config.get")).toHaveLength(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(JSON.stringify(await gateway.getRequests())).not.toContain("foreign-agent");
    } finally {
      await context.close();
    }
  }, 120_000);

  it("renders assigned personal memory at desktop and mobile in light and dark", async () => {
    const scenarios = [
      {
        locale: "en-US" as const,
        mode: "light" as const,
        name: "01-memory-desktop-light.png",
        viewport: { height: 900, width: 1440 },
      },
      {
        locale: "en-US" as const,
        mode: "dark" as const,
        name: "02-memory-desktop-dark.png",
        viewport: { height: 900, width: 1440 },
      },
      {
        locale: "ko-KR" as const,
        mode: "light" as const,
        name: "03-memory-mobile-light.png",
        viewport: { height: 844, width: 390 },
      },
      {
        locale: "ko-KR" as const,
        mode: "dark" as const,
        name: "04-memory-mobile-dark.png",
        viewport: { height: 844, width: 390 },
      },
    ];

    for (const scenario of scenarios) {
      const context = await createContext(scenario);
      try {
        const { gateway, page, surface } = await openMemory(context, {
          methodResponses: populatedResponses,
        });
        await expect.poll(() => surface.textContent()).toContain("2026-08-31.md");
        await expect.poll(() => surface.locator(".memory-memories__result").count()).toBe(8);
        await expectTheme(page, scenario.mode);

        if (scenario.viewport.width === 390) {
          await expectNoHorizontalOverflow(page);
        }
        await captureScreenshot(page, scenario.name);

        const memoryRow = surface.getByRole("button", { name: /^MEMORY\.md/u });
        await memoryRow.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => memoryRow.getAttribute("aria-expanded")).toBe("true");
        await expect
          .poll(() => surface.locator("#memory-long-term-detail").textContent())
          .toContain("bounded canary");

        const search = surface.locator("#memory-search-input");
        await search.fill("release");
        await search.press("Enter");
        await expect
          .poll(() => surface.locator(".memory-memories__results").textContent())
          .toContain("Release preflight");
        await expect
          .poll(() =>
            surface.locator(".memory-memories__results-heading").getAttribute("aria-label"),
          )
          .toMatch(/out of date|최신/iu);
        const firstResult = surface.locator(".memory-memories__results button").first();
        await firstResult.focus();
        await page.keyboard.press("Space");
        await expect.poll(() => firstResult.getAttribute("aria-expanded")).toBe("true");
        await expect
          .poll(() => surface.locator("#memory-detail-0").textContent())
          .toContain("Canary stayed healthy");
        if (scenario.name === "01-memory-desktop-light.png") {
          await captureScreenshot(page, "05-memory-search-detail-desktop-light.png");
        }
        if (scenario.name === "04-memory-mobile-dark.png") {
          await expectNoHorizontalOverflow(page);
          await captureScreenshot(page, "06-memory-search-detail-mobile-dark.png");
        }

        const browseGets = await gateway.getRequests("agents.workspace.get");
        expect(requestParams(browseGets[0] ?? {})).toEqual({
          agentId: assignedAgentId,
          path: "MEMORY.md",
        });
        expect(await gateway.getRequests("agents.workspace.list")).toEqual([
          expect.objectContaining({
            params: { agentId: assignedAgentId, path: "memory" },
          }),
        ]);
        expect(
          (await gateway.getRequests()).some(
            (request) => request.method === "config.get" || request.method === "config.patch",
          ),
        ).toBe(false);
        expect(JSON.stringify(await gateway.getRequests())).not.toContain("foreign-agent");
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  it("keeps cached Memory readable offline without mobile overflow", async () => {
    const context = await createContext({
      locale: "ko-KR",
      mode: "dark",
      viewport: { height: 844, width: 390 },
    });
    try {
      const { gateway, page, surface } = await openMemory(context, {
        methodResponses: populatedResponses,
      });
      await expect.poll(() => surface.textContent()).toContain("2026-08-31.md");
      const cachedRecent = surface.locator('button[aria-controls="memory-browse-detail-2"]');
      await cachedRecent.click();
      await expect
        .poll(() => surface.textContent())
        .toContain("Canary stayed healthy for thirty minutes");
      await cachedRecent.click();
      const refreshButton = surface.getByRole("button", {
        name: "개인 Memory 새로고침",
        exact: true,
      });
      const searchInput = surface.locator("#memory-search-input");
      const searchButton = surface.locator(".memory-memories__search button[type='submit']");
      await searchInput.fill("release");
      expect(await refreshButton.isEnabled()).toBe(true);
      expect(await searchButton.isEnabled()).toBe(true);
      await gateway.setOnline(false);
      await gateway.closeLatest(1001, "proof reconnect");
      await expect
        .poll(() => gatewayPhase(page), { timeout: 10_000 })
        .toMatch(/offline|reconnecting/u);
      await expect
        .poll(
          () =>
            surface.evaluate(
              (element) => (element as HTMLElement & { connectionPhase?: string }).connectionPhase,
            ),
          { timeout: 10_000 },
        )
        .toMatch(/offline|reconnecting/u);
      await expect
        .poll(
          () => surface.locator(".memory-memories > .settings-empty[role='status']").textContent(),
          { timeout: 10_000 },
        )
        .toMatch(/offline|reconnect|오프라인|다시 연결/iu);
      expect(
        await surface.locator(".memory-memories > .settings-empty[role='status']").count(),
      ).toBe(1);
      expect(await surface.textContent()).toContain("MEMORY.md");
      expect(await surface.textContent()).toContain("2026-08-31.md");
      expect(await surface.locator('button[aria-controls="memory-browse-detail-2"]').count()).toBe(
        1,
      );
      expect(await surface.locator('button[aria-controls="memory-browse-detail-3"]').count()).toBe(
        0,
      );
      await cachedRecent.click();
      await expect
        .poll(() => surface.textContent())
        .toContain("Canary stayed healthy for thirty minutes");
      const cachedMemory = surface.locator('button[aria-controls="memory-long-term-detail"]');
      expect(await cachedMemory.isVisible()).toBe(true);
      await cachedMemory.click();
      await expect
        .poll(() => surface.textContent())
        .toContain("The release checklist starts with a bounded canary");
      expect(await refreshButton.isDisabled()).toBe(true);
      expect(await searchButton.isDisabled()).toBe(true);
      await expectNoHorizontalOverflow(page);
      expect(await surface.locator(".settings-status").count()).toBe(0);
      await cachedMemory.click();
      await page.locator("#control-ui-main").evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() => page.locator("#control-ui-main").evaluate((element) => element.scrollTop))
        .toBe(0);
      await captureScreenshot(page, "07-memory-cached-offline-mobile-dark.png");
      await cachedMemory.click();
      await expect
        .poll(() => surface.textContent())
        .toContain("The release checklist starts with a bounded canary");
      await captureScreenshot(page, "07b-memory-cached-detail-mobile-dark.png");
      await gateway.setOnline(true);
      await expect.poll(() => gatewayPhase(page), { timeout: 10_000 }).toBe("connected");
      await expect
        .poll(() =>
          surface.evaluate(
            (element) => (element as HTMLElement & { connectionPhase?: string }).connectionPhase,
          ),
        )
        .toBe("connected");
      await expect.poll(() => refreshButton.isEnabled()).toBe(true);
      await searchInput.fill("release");
      await expect.poll(() => searchButton.isEnabled()).toBe(true);
      expect(
        await surface.locator(".memory-memories > .settings-empty[role='status']").count(),
      ).toBe(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("shows independent long-term and recent errors with a visible retry", async () => {
    const context = await createContext({
      locale: "en-US",
      mode: "light",
      viewport: { height: 844, width: 390 },
    });
    try {
      const failure = {
        __mockError: { code: "UNAVAILABLE", message: "Temporary personal memory outage" },
      };
      const { page, surface } = await openMemory(context, {
        methodResponses: {
          "agents.list": personalRoster,
          "agents.workspace.get": failure,
          "agents.workspace.list": failure,
          "memory.search": populatedResponses["memory.search"],
          "wiki.search": populatedResponses["wiki.search"],
        },
      });
      await expect.poll(() => surface.getByRole("alert").count()).toBe(2);
      await expect
        .poll(() => surface.getByRole("button", { name: "Refresh personal memory" }).isVisible())
        .toBe(true);
      await expectNoHorizontalOverflow(page);
      await captureScreenshot(page, "08-memory-dual-error-mobile-light.png");
    } finally {
      await context.close();
    }
  }, 60_000);

  it("preserves server-projected member and admin organization states", async () => {
    const roles = [
      {
        role: "member" as const,
        mode: "light" as const,
        name: "09-organization-member-desktop-light.png",
        lifecycle: {
          scopes: [{ kind: "part", id: "part-runtime", name: "Runtime", canAdminister: false }],
          personalTargets: [
            { kind: "part", scopeId: "part-runtime", scopeName: "Runtime", mode: "request" },
          ],
          claims: [],
          submitted: [],
          reviewable: [],
          canApproveGlobal: false,
        },
      },
      {
        role: "admin" as const,
        mode: "dark" as const,
        name: "10-organization-admin-desktop-dark.png",
        lifecycle: {
          scopes: [{ kind: "global", name: "Global", canAdminister: true }],
          personalTargets: [{ kind: "global", scopeName: "Global", mode: "direct" }],
          claims: [
            {
              id: "claim-1",
              scopeKind: "global",
              scopeName: "Global",
              title: "Release policy",
              text: "Two approvals are required before production rollout.",
              revision: 1,
              status: "active",
              createdAt: 1,
              updatedAt: 1,
              promotionTargets: [],
              canRetire: true,
              canPurge: false,
            },
            {
              id: "claim-2",
              scopeKind: "global",
              scopeName: "Global",
              title: "Retired incident note",
              text: "Legacy incident note pending privacy cleanup.",
              revision: 2,
              status: "retired",
              createdAt: 1,
              updatedAt: 2,
              promotionTargets: [],
              canRetire: false,
              canPurge: true,
            },
          ],
          submitted: [],
          reviewable: [
            {
              id: "request-1",
              sourceKind: "personal",
              sourceClaimId: "runbooks/release.md",
              sourceRevision: 1,
              targetKind: "global",
              targetScopeName: "Global",
              proposedText: "Keep rollback owners on call.",
              evidence: ["incident-1"],
              reason: "Reusable release policy",
              status: "pending",
              createdAt: 1,
              canReview: true,
            },
          ],
          canApproveGlobal: true,
        },
      },
    ];

    for (const scenario of roles) {
      const context = await createContext({
        locale: "en-US",
        mode: scenario.mode,
        viewport: { height: 900, width: 1440 },
      });
      try {
        const { gateway, page } = await openMemory(
          context,
          {
            featureMethods: [...memoryMethods, "platformclaw.memory.lifecycle"],
            methodResponses: {
              ...populatedResponses,
              "platformclaw.memory.lifecycle": scenario.lifecycle,
            },
          },
          scenario.role,
        );
        await page
          .locator(".platformclaw-memory-page__tabs")
          .getByRole("tab", { name: "Organization", exact: true })
          .click();
        const organization = page.locator("openclaw-memory-promotions");
        await expect
          .poll(() => organization.textContent())
          .toContain(scenario.role === "admin" ? "Keep rollback owners" : "Runtime");
        await organization
          .getByRole("combobox", { name: "Target scope" })
          .selectOption(scenario.role === "admin" ? "global" : "part-runtime");
        await expectTheme(page, scenario.mode);
        if (scenario.role === "admin") {
          const publishDirect = organization.getByRole("button", {
            name: "Publish directly as administrator",
          });
          const retire = organization.getByRole("button", { name: "Retire" });
          const hardPurge = organization.getByRole("button", { name: "Hard purge" });
          await expect.poll(() => publishDirect.isVisible()).toBe(true);
          await expect.poll(() => retire.isVisible()).toBe(true);
          await expect.poll(() => hardPurge.isVisible()).toBe(true);
          await publishDirect.scrollIntoViewIfNeeded();
          await captureScreenshot(page, scenario.name);
          await hardPurge.scrollIntoViewIfNeeded();
          await captureScreenshot(page, "12-organization-admin-lifecycle-controls-dark.png");
        } else {
          const requestPromotion = organization.getByRole("button", { name: "Request promotion" });
          await expect.poll(() => requestPromotion.isVisible()).toBe(true);
          expect(
            await organization
              .getByRole("button", { name: "Publish directly as administrator" })
              .count(),
          ).toBe(0);
          expect(await organization.getByRole("button", { name: "Retire" }).count()).toBe(0);
          expect(await organization.getByRole("button", { name: "Hard purge" }).count()).toBe(0);
          await requestPromotion.scrollIntoViewIfNeeded();
          await captureScreenshot(page, scenario.name);
        }
        expect(await gateway.getRequests("platformclaw.memory.lifecycle")).toEqual([
          expect.objectContaining({ params: {} }),
        ]);
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
      } finally {
        await context.close();
      }
    }
  }, 120_000);
});
