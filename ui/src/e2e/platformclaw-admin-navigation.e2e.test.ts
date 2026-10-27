import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  installPlatformClawDocument,
  settlePlatformClawRendering,
} from "./platformclaw-document.test-support.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const suite =
  canRunPlaywrightChromium(executablePath) ||
  process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts/control-ui-e2e/platformclaw-admin-navigation",
);
const basePath = "/platformclaw/app";
const pages = [
  {
    routeId: "announcements",
    path: "/settings/announcements",
    tag: "platformclaw-announcement-administration",
  },
  { routeId: "vm-administration", path: "/settings/vms", tag: "platformclaw-vm-administration" },
] as const;
const emptyNotice = () => ({
  revision: 0,
  serverNow: Date.now(),
  announcement: null,
  current: null,
});
let browser: Browser;
let server: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();

async function newPage(role: "admin" | "member", locale = "en") {
  const context = await browser.newContext({
    locale: locale === "ko" ? "ko-KR" : "en-US",
    serviceWorkers: "block",
    viewport: { width: 1440, height: 960 },
  });
  contexts.add(context);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.addInitScript((value) => localStorage.setItem("openclaw.i18n.locale", value), locale);
  await installPlatformClawDocument(page, server.baseUrl);
  const adminRequests: Array<{ path: string; method: string }> = [];
  const user = {
    accountId: "person.one",
    displayName: "Person One",
    department: "Platform Lab",
    globalRole: role,
  };
  await page.route("**/platformclaw/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/admin/")) {
      adminRequests.push({ path: pathname, method: request.method() });
    }
    if (pathname.endsWith("/auth/session")) {
      await route.fulfill({
        json: { authenticated: true, user, agent: { agentId: "person_one", state: "active" } },
      });
    } else if (pathname.includes("announcements")) {
      await route.fulfill({ json: emptyNotice() });
    } else if (pathname.endsWith("/admin/vm")) {
      await route.fulfill({
        json: { endpoints: [], hosts: [], agents: [], allocations: [], auditEvents: [] },
      });
    } else if (pathname.includes("organization")) {
      await route.fulfill({ json: { actor: user, joinPromptEligible: false } });
    } else {
      await route.fulfill({
        json: {
          accountId: user.accountId,
          activeTarget: "platform_server",
          targetRevision: 0,
          credentialStatus: "missing",
          availableVms: [],
          savedVms: [],
          codingAgents: [],
        },
      });
    }
  });
  await installMockGateway(page, {
    basePath,
    defaultAgentId: "person_one",
    sessionKey: "agent:person_one:main",
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    operatorScopes:
      role === "admin"
        ? ["operator.read", "operator.write", "operator.admin"]
        : ["operator.read", "operator.write"],
  });
  return { page, adminRequests, pageErrors };
}

async function visit(page: Page, routeId: string, pathname: string) {
  await page.goto(new URL(`${basePath}${pathname}`, server.baseUrl).href);
  await waitForControlUiRoute(page, { routeId, pathname: `${basePath}${pathname}` });
}

async function screenshot(page: Page, name: string) {
  if (capture) {
    await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
  }
}

suite("PlatformClaw administration settings navigation", () => {
  beforeAll(async () => {
    if (capture) {
      await mkdir(proofDir, { recursive: true });
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close()));
    contexts.clear();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { locale: "en", group: "Administration", titles: ["Web announcements", "VM administration"] },
    { locale: "ko", group: "관리", titles: ["웹 공지 관리", "VM 관리"] },
  ])(
    "opens real administration pages with localized navigation in $locale",
    async ({ locale, group, titles }) => {
      const { page, adminRequests, pageErrors } = await newPage("admin", locale);
      await visit(page, "announcements", "/settings/announcements");
      const sidebar = page.locator(".settings-sidebar");
      await sidebar.waitFor({ state: "visible" });
      await page.locator("platformclaw-announcement-administration [name='title']").waitFor();
      const administration = sidebar.locator(".settings-sidebar__group").filter({
        has: page.locator(".settings-sidebar__group-label", {
          hasText: new RegExp(`^${group}$`),
        }),
      });
      await administration.waitFor({ state: "visible" });
      expect(await administration.locator("a").allTextContents()).toHaveLength(2);
      expect(
        await administration
          .locator("a")
          .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
      ).toEqual(pages.map((entry) => `${basePath}${entry.path}`));
      for (const [index, entry] of pages.entries()) {
        const link = sidebar.getByRole("link", { name: titles[index], exact: true });
        await link.click();
        await waitForControlUiRoute(page, {
          routeId: entry.routeId,
          pathname: `${basePath}${entry.path}`,
        });
        await expect.poll(() => link.getAttribute("aria-current")).toBe("page");
        expect(await page.locator(".content-header .page-title").textContent()).toBe(titles[index]);
        await expect.poll(() => page.locator(entry.tag).isVisible()).toBe(true);
        if (entry.routeId === "vm-administration") {
          const component = page.locator(entry.tag);
          await expect.poll(() => component.locator("[data-refresh]").isEnabled()).toBe(true);
          expect(await component.locator("form").count()).toBe(0);
          expect(
            await component.locator("wa-tab[panel='hosts']").getAttribute("aria-selected"),
          ).toBe("true");
          expect(
            await component
              .locator("[data-admin-modal] dialog")
              .evaluate((dialog) => (dialog as HTMLDialogElement).open),
          ).toBe(false);
        } else {
          expect(await page.locator(`${entry.tag} openclaw-modal-dialog`).count()).toBe(0);
        }
        expect(await link.locator("svg").evaluate((svg) => svg.namespaceURI)).toBe(
          "http://www.w3.org/2000/svg",
        );
        expect((await link.locator("svg").boundingBox())!.width).toBeGreaterThan(0);
        await screenshot(page, `${locale}-${entry.routeId}-desktop.png`);
      }
      expect(
        await page
          .locator(
            "platformclaw-quick-actions platformclaw-vm-administration, platformclaw-quick-actions platformclaw-announcement-administration",
          )
          .count(),
      ).toBe(0);
      await page.goBack();
      await waitForControlUiRoute(page, {
        routeId: "announcements",
        pathname: `${basePath}/settings/announcements`,
      });
      await page.goForward();
      await waitForControlUiRoute(page, {
        routeId: "vm-administration",
        pathname: `${basePath}/settings/vms`,
      });
      await page.reload();
      await waitForControlUiRoute(page, {
        routeId: "vm-administration",
        pathname: `${basePath}/settings/vms`,
      });
      const search = sidebar.locator("input[type='search']");
      await search.fill(titles[0]!);
      await expect.poll(() => sidebar.locator(".settings-sidebar__item").count()).toBe(1);
      expect(await sidebar.getByRole("link", { name: titles[0], exact: true }).count()).toBe(1);
      await search.fill("");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => page.locator(".topbar-nav-toggle").isVisible()).toBe(true);
      await page.locator(".topbar-nav-toggle").click();
      await sidebar.getByRole("link", { name: titles[0], exact: true }).click();
      await waitForControlUiRoute(page, {
        routeId: "announcements",
        pathname: `${basePath}/settings/announcements`,
      });
      await expect
        .poll(() => page.locator("openclaw-modal-dialog.nav-drawer dialog[open]").count())
        .toBe(0);
      for (const entry of pages) {
        if (entry.routeId === "vm-administration") {
          await page.locator(".topbar-nav-toggle").click();
          await sidebar.getByRole("link", { name: titles[1], exact: true }).click();
          await waitForControlUiRoute(page, {
            routeId: entry.routeId,
            pathname: `${basePath}${entry.path}`,
          });
          await expect
            .poll(() => page.locator("openclaw-modal-dialog.nav-drawer dialog[open]").count())
            .toBe(0);
        }
        const dimensions = await page.locator(entry.tag).evaluate((host) => {
          const bounds = host.getBoundingClientRect();
          const content = host.shadowRoot!.querySelector<HTMLElement>(".panel, main")!;
          return {
            left: bounds.left,
            right: bounds.right,
            scrollWidth: content.scrollWidth,
            width: content.clientWidth,
          };
        });
        expect(dimensions.left).toBeGreaterThanOrEqual(0);
        expect(dimensions.right).toBeLessThanOrEqual(390);
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
        await screenshot(page, `${locale}-${entry.routeId}-mobile.png`);
      }
      expect(adminRequests.every((request) => request.method === "GET")).toBe(true);
      expect(pageErrors).toEqual([]);
    },
  );

  it("hides administration and rejects member deep links without reading admin APIs", async () => {
    const { page, adminRequests, pageErrors } = await newPage("member");
    await visit(page, "appearance", "/settings/appearance");
    const sidebar = page.locator(".settings-sidebar");
    await sidebar.waitFor({ state: "visible" });
    expect(
      await sidebar
        .locator(".settings-sidebar__group-label", { hasText: "Administration" })
        .count(),
    ).toBe(0);
    for (const query of ["Web announcements", "VM administration", "Administration"]) {
      await sidebar.locator("input[type='search']").fill(query);
      expect(
        await sidebar
          .locator(
            `a[href='${basePath}/settings/announcements'], a[href='${basePath}/settings/vms']`,
          )
          .count(),
      ).toBe(0);
    }
    for (const entry of pages) {
      await page.goto(new URL(`${basePath}${entry.path}`, server.baseUrl).href);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toMatch(/^\/platformclaw\/app\/chat(?:\/|$)/u);
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").isVisible())
        .toBe(true);
      expect(await page.locator(entry.tag).count()).toBe(0);
    }
    expect(adminRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  it("keeps a new page draft when the previous page's read completes after navigation", async () => {
    const { page, pageErrors } = await newPage("admin");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    await page.route("**/platformclaw/api/admin/announcements", async (route) => {
      if (++reads === 1) {
        await blocked;
      }
      await route.fulfill({ json: emptyNotice() });
    });
    try {
      await visit(page, "announcements", "/settings/announcements");
      await expect.poll(() => reads).toBe(1);
      await page.locator(`.settings-sidebar a[href='${basePath}/settings/appearance']`).click();
      await waitForControlUiRoute(page, {
        routeId: "appearance",
        pathname: `${basePath}/settings/appearance`,
      });
      await page.locator(`.settings-sidebar a[href='${basePath}/settings/announcements']`).click();
      await waitForControlUiRoute(page, {
        routeId: "announcements",
        pathname: `${basePath}/settings/announcements`,
      });
      await expect.poll(() => reads).toBe(2);
      const title = page.locator("platformclaw-announcement-administration [name='title']");
      await title.fill("Keep my new draft");
      const staleResponse = page.waitForResponse("**/platformclaw/api/admin/announcements");
      release();
      await staleResponse;
      await settlePlatformClawRendering(page);
      expect(await title.inputValue()).toBe("Keep my new draft");
      expect(pageErrors).toEqual([]);
    } finally {
      release();
    }
  });
});
