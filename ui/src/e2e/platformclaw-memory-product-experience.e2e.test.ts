import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createPlatformClawMemoryContext,
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
  platformClawMemoryMethods,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";

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
const assignedAgentId = platformClawMemoryAgentId;
const memoryMethods = [...platformClawMemoryMethods];
const populatedResponses = platformClawMemoryResponses;

let browser: Browser;
let server: ControlUiE2eServer;
async function installPlatformClawDocument(page: Page, role: "admin" | "member" = "member") {
  await installPlatformClawMemoryDocument(page, server.baseUrl, role);
}
async function createContext(params: {
  locale: "en-US" | "ko-KR";
  mode: "dark" | "light";
  viewport: { height: number; width: number };
}) {
  return createPlatformClawMemoryContext(browser, server.baseUrl, params);
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

suite("PlatformClaw search-first Memory product experience", () => {
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

  it("routes all four tabs with browser history and an accessible shared panel", async () => {
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

      await expectActive("Memory", "memory", "/platformclaw/app/settings/memory");
      await expect
        .poll(() => page.locator("openclaw-memory-memories").textContent())
        .toContain("MEMORY.md");
      await expect
        .poll(async () =>
          (
            await page
              .locator("openclaw-memory-memories .settings-section__heading")
              .allTextContents()
          ).map((text) => text.trim()),
        )
        .toEqual(["Search all knowledge", "Long-term memory", "Recent daily memory"]);

      await memoryTabs.getByRole("tab", { name: "Personal Wiki", exact: true }).click();
      await expectActive("Personal Wiki", "wiki", "/platformclaw/app/settings/memory/wiki");
      const wikiPanel = page.locator("openclaw-agent-memory-panel");
      await expect.poll(() => wikiPanel.textContent()).toContain("Release preflight synthesis");
      await wikiPanel.getByRole("button", { name: "Graph", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("wiki.graph")).length).toBe(1);
      await expect.poll(() => wikiPanel.locator(".memory-wiki-graph svg").count()).toBe(1);
      await expect.poll(() => wikiPanel.locator(".memory-wiki-graph__edges line").count()).toBe(1);
      await wikiPanel.locator('[data-wiki-node="syntheses/release-preflight.md"] circle').click();
      await expect
        .poll(async () => (await gateway.getRequests("wiki.document.get")).length)
        .toBe(1);
      await expect
        .poll(() => page.locator(".wiki-document__reader").textContent())
        .toContain("Record canary health and the responsible owner.");
      await page.getByRole("button", { name: "Close" }).click();

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

      await page.setViewportSize({ height: 844, width: 390 });
      const dreamingTab = memoryTabs.getByRole("tab", { name: "Dreaming", exact: true });
      await expect
        .poll(() =>
          dreamingTab.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < globalThis.innerHeight &&
              rect.left < globalThis.innerWidth
            );
          }),
        )
        .toBe(true);
      await page.setViewportSize({ height: 900, width: 1440 });

      await memoryTabs.getByRole("tab", { name: "Memory", exact: true }).click();
      await expectActive("Memory", "memory", "/platformclaw/app/settings/memory/memories");
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
          "agents.list": populatedResponses["agents.list"],
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
          scopes: [
            {
              kind: "part",
              id: "part-runtime",
              name: "Runtime",
              canRead: true,
              canAdminister: false,
            },
          ],
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
          scopes: [{ kind: "global", name: "Global", canRead: true, canAdminister: true }],
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
