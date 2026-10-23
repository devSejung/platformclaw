import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(executablePath);
const runE2e =
  chromiumAvailable || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-mcp-settings",
);
let browser: Browser;
let server: ControlUiE2eServer;

async function install(
  page: Page,
  kind: "mcp-settings" | "mcp-administration" | "mcp-page",
  theme = "platformclaw",
  locale: "en" | "ko" = "en",
) {
  await page.goto(new URL("sw.js", server.baseUrl).href);
  await page.setContent("<!doctype html><html><body></body></html>");
  // The BFF is mocked, while production components inherit the real product
  // tokens. Do not copy the approved prototype's fixed demonstration palette.
  await page.addStyleTag({ url: `${server.baseUrl}src/styles/base.css?direct` });
  await page.addStyleTag({ url: `${server.baseUrl}src/styles/layout.css?direct` });
  await page.addStyleTag({ url: `${server.baseUrl}src/styles/platformclaw-theme.css?direct` });
  await page.addStyleTag({
    content:
      ".mcp-proof-page{width:min(1480px,100%);margin:0 auto;padding:24px 20px;box-sizing:border-box}",
  });
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme;
  }, theme);
  await page.addScriptTag({
    type: "module",
    content: `const { i18n } = await import(${JSON.stringify(`${server.baseUrl}src/i18n/index.ts`)}); await i18n.setLocale(${JSON.stringify(locale)});`,
  });
  await page.addScriptTag({ type: "module", url: `${server.baseUrl}src/platformclaw/${kind}.ts` });
  await page.evaluate(async (tag) => {
    await customElements.whenDefined(tag);
    // Production deliberately clips document scrolling. Match the app shell's
    // bounded .content scroll owner so long editors remain keyboard-accessible.
    const scrollOwner = document.createElement("main");
    scrollOwner.id = "control-ui-main";
    scrollOwner.className = "content";
    scrollOwner.style.height = "100dvh";
    const pageContent = document.createElement("div");
    pageContent.className = "mcp-proof-page";
    const component = document.createElement(tag);
    if (tag === "platformclaw-mcp-page") {
      component.setAttribute("admin", "");
    }
    pageContent.append(component);
    scrollOwner.append(pageContent);
    document.body.replaceChildren(scrollOwner);
  }, `platformclaw-${kind}`);
}
async function screenshot(page: Page, name: string) {
  if (captureProof) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
  }
}

runE2e("PlatformClaw MCP responsive settings", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${executablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("switches administrator panels through shared tabs with pointer and Arrow, Home, and End keys", async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.route("**/platformclaw/api/**", (route) => route.fulfill({ json: { servers: [] } }));
    try {
      await install(page, "mcp-page");
      const administration = page.getByRole("tab", { name: "Server administration", exact: true });
      const settings = page.getByRole("tab", { name: "My settings", exact: true });
      await administration.waitFor();
      await administration.focus();
      for (const [key, expected] of [
        ["ArrowRight", "settings"],
        ["ArrowRight", "administration"],
        ["End", "settings"],
        ["Home", "administration"],
        ["ArrowLeft", "settings"],
      ] as const) {
        await page.keyboard.press(key);
        const tab = expected === "settings" ? settings : administration;
        await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
        expect(await tab.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(await page.locator(`#mcp-panel-${expected}`).isVisible()).toBe(true);
      }
      await administration.click();
      await expect.poll(() => page.locator("#mcp-panel-administration").isVisible()).toBe(true);
      await settings.click();
      await expect.poll(() => page.locator("#mcp-panel-settings").isVisible()).toBe(true);
      expect(await page.locator("platformclaw-mcp-settings").count()).toBe(1);
      expect(await page.locator("platformclaw-mcp-administration").count()).toBe(1);
      await screenshot(page, "admin-shared-tabs-fhd.png");
    } finally {
      await context.close();
    }
  });

  it("displays the saved OAuth policy and keeps the selected authentication aligned with the submitted draft", async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();
    const servers = [
      {
        name: "docs",
        enabled: true,
        transport: "streamable-http",
        target: "https://docs.example/mcp",
        editable: true,
        credentialMode: "personal",
        personalAuth: "oauth",
        sharedConfigured: false,
        headerGuides: [],
        toolPolicy: "all",
        blockedTools: [],
      },
    ];
    let saved: Record<string, unknown> | undefined;
    await page.route("**/platformclaw/api/admin/mcp", async (route) => {
      if (route.request().method() === "POST") {
        saved = route.request().postDataJSON() as Record<string, unknown>;
      }
      await route.fulfill({ json: { servers } });
    });
    try {
      await install(page, "mcp-administration");
      const component = page.locator("platformclaw-mcp-administration");
      const form = component.locator("form");
      const auth = form.locator("[name='auth']");
      await expect.poll(() => auth.inputValue()).toBe("oauth");
      await form.locator("[name='credentialMode']").selectOption("shared");
      await expect.poll(() => auth.inputValue()).toBe("bearer");
      expect(await auth.locator("option[value='oauth']").count()).toBe(0);
      await form.locator("[name='credentialMode']").selectOption("personal");
      await expect.poll(() => auth.inputValue()).toBe("bearer");
      await auth.selectOption("oauth");
      expect(await auth.inputValue()).toBe("oauth");
      await form.locator("[type='submit']").click();
      await expect.poll(() => saved?.auth).toBe("oauth");
      expect(saved).toMatchObject({
        action: "save-server",
        name: "docs",
        credentialMode: "personal",
        auth: "oauth",
      });
      expect(saved).not.toHaveProperty("secret");
      await expect.poll(() => auth.inputValue()).toBe("oauth");
    } finally {
      await context.close();
    }
  });

  it.each(["platformclaw", "platformclaw-light"])(
    "shows the actual Korean administrator and user labels in %s at FHD",
    async (theme) => {
      for (const kind of ["mcp-administration", "mcp-settings"] as const) {
        const context = await browser.newContext({
          viewport: { width: 1920, height: 1080 },
          locale: "ko-KR",
        });
        const page = await context.newPage();
        const servers = Array.from({ length: 30 }, (_, index) => {
          const name = `server-${String(index).padStart(2, "0")}`;
          const headerGuides = [
            { name: "X-Tenant-ID", description: "서비스에서 안내받은 테넌트 ID" },
          ];
          return kind === "mcp-administration"
            ? {
                name,
                enabled: true,
                transport: "streamable-http",
                target: `https://${name}.example/mcp`,
                editable: true,
                credentialMode: "none",
                sharedConfigured: false,
                headerGuides,
                toolPolicy: "all",
                blockedTools: [],
              }
            : {
                serverName: name,
                origin: "organization",
                credentialMode: "shared",
                globalEnabled: true,
                userEnabled: true,
                settingsRevision: 1,
                policyFingerprint: "policy-original",
                credentialStored: false,
                credentialFingerprint: null,
                configured: false,
                headerGuides,
                headers: [],
              };
        });
        await page.route(
          `**/platformclaw/api/${kind === "mcp-administration" ? "admin/" : ""}mcp`,
          (route) => route.fulfill({ json: { servers } }),
        );
        try {
          await install(page, kind, theme, "ko");
          const component = page.locator(`platformclaw-${kind}`);
          await expect
            .poll(() => component.locator("h2").textContent())
            .toBe(kind === "mcp-administration" ? "MCP 서버 관리" : "내 MCP 연결");
          await expect.poll(() => component.locator(".server-row").count()).toBe(6);
          const guideDescription =
            kind === "mcp-administration"
              ? await component.locator("[name='guide-description']").inputValue()
              : await component.locator(".detail").textContent();
          expect(guideDescription).toContain("서비스에서 안내받은 테넌트 ID");
          await screenshot(page, `${kind}-${theme}-1920-ko.png`);
        } finally {
          await context.close();
        }
      }
    },
  );

  it.each([
    { width: 1920, height: 1080, theme: "platformclaw" },
    { width: 1920, height: 1080, theme: "platformclaw-light" },
    { width: 1280, height: 800, theme: "platformclaw" },
    { width: 1280, height: 800, theme: "platformclaw-light" },
    { width: 800, height: 700, theme: "platformclaw" },
    { width: 800, height: 700, theme: "platformclaw-light" },
  ])(
    "renders 30 servers with six visible rows at $width × $height in $theme",
    async ({ width, height, theme }) => {
      for (const kind of ["mcp-administration", "mcp-settings"] as const) {
        const context = await browser.newContext({ viewport: { width, height }, locale: "en-US" });
        const page = await context.newPage();
        const servers = Array.from({ length: 30 }, (_, index) => {
          const name = `server-${String(index).padStart(2, "0")}`;
          return kind === "mcp-administration"
            ? {
                name,
                enabled: true,
                transport: "streamable-http",
                target: `https://${name}.example/mcp`,
                editable: true,
                credentialMode: "none",
                sharedConfigured: false,
                headerGuides: [
                  { name: "X-Tenant-ID", description: "Optional tenant assigned by your service" },
                ],
                toolPolicy: "all",
                blockedTools: [],
              }
            : {
                serverName: name,
                origin: "organization",
                credentialMode: "shared",
                globalEnabled: true,
                userEnabled: true,
                settingsRevision: 1,
                policyFingerprint: "policy-original",
                credentialStored: false,
                credentialFingerprint: null,
                configured: false,
                headerGuides: [
                  { name: "X-Tenant-ID", description: "Optional tenant assigned by your service" },
                ],
                headers: [],
              };
        });
        await page.route(
          `**/platformclaw/api/${kind === "mcp-administration" ? "admin/" : ""}mcp`,
          (route) => route.fulfill({ json: { servers } }),
        );
        try {
          await install(page, kind, theme);
          const component = page.locator(`platformclaw-${kind}`);
          await expect.poll(() => component.locator(".server-row").count()).toBe(6);
          expect(
            await page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
            ),
          ).not.toBe("");
          if (width > 900) {
            const catalog = await component.locator(".catalog").boundingBox();
            const detail = await component.locator(".detail").boundingBox();
            expect(detail!.x).toBeGreaterThan(catalog!.x + catalog!.width);
            await screenshot(page, `${kind}-${theme}-${width}.png`);
          } else {
            expect(await component.locator(".catalog").isVisible()).toBe(false);
            await screenshot(page, `${kind}-${theme}-${width}-detail.png`);
            await component.locator("[data-action='picker']").click();
            await expect.poll(() => component.locator(".catalog").isVisible()).toBe(true);
            expect(await component.locator(".detail").isVisible()).toBe(false);
            await screenshot(page, `${kind}-${theme}-${width}-picker.png`);
            await component.locator("[data-action='select'][data-server='server-03']").click();
            await expect.poll(() => component.locator(".detail").isVisible()).toBe(true);
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
        } finally {
          await context.close();
        }
      }
    },
  );

  it("keeps a six-row catalog alongside the selected administrator editor at FHD and retains failed drafts", async () => {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
    });
    const page = await context.newPage();
    const servers = Array.from({ length: 30 }, (_, index) => ({
      name: `server-${String(index).padStart(2, "0")}`,
      enabled: true,
      transport: "streamable-http",
      target: `https://server-${index}.example/mcp`,
      editable: true,
      credentialMode: "none",
      sharedConfigured: false,
      headerGuides: [],
      toolPolicy: "all",
      blockedTools: [],
    }));
    let attempts = 0;
    let saved: Record<string, unknown> | undefined;
    await page.route("**/platformclaw/api/admin/mcp", async (route) => {
      if (route.request().method() === "POST") {
        attempts++;
        saved = route.request().postDataJSON() as Record<string, unknown>;
        if (attempts === 1) {
          await route.fulfill({
            status: 503,
            json: { error: "Save failed. Retry these changes." },
          });
          return;
        }
      }
      await route.fulfill({ json: { servers } });
    });
    try {
      await install(page, "mcp-administration");
      const component = page.locator("platformclaw-mcp-administration");
      await expect.poll(() => component.locator(".server-row").count()).toBe(6);
      const catalog = await component.locator(".catalog").boundingBox();
      const detail = await component.locator(".detail").boundingBox();
      expect(detail!.x).toBeGreaterThan(catalog!.x + catalog!.width);
      await component.locator("[data-action='next']").click();
      await expect
        .poll(() => component.locator(".pagination").textContent())
        .toContain("7–12 / 30");
      await component.locator("[name='search']").fill("server-29");
      await expect.poll(() => component.locator(".server-row").count()).toBe(1);
      await component.locator("[data-action='add-header']").click();
      await component.locator("[name='guide-name']").fill("X-Tenant-ID");
      await component.locator("[name='guide-description']").fill("Tenant provided by the service");
      await component.locator("[type='submit']").click();
      await expect
        .poll(() => component.locator("[role='alert']").textContent())
        .toContain("Save failed");
      expect(await component.locator("[name='guide-name']").inputValue()).toBe("X-Tenant-ID");
      await screenshot(page, "admin-fhd-failed-draft.png");
      await component.locator("[type='submit']").click();
      await expect.poll(() => attempts).toBe(2);
      expect(saved?.headerGuides).toEqual([
        { name: "X-Tenant-ID", description: "Tenant provided by the service" },
      ]);
      expect(saved).not.toHaveProperty("secret");
    } finally {
      await context.close();
    }
  });

  it("switches between picker and user details on narrow screens and saves optional headers without exposing secrets", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "en-US",
    });
    const page = await context.newPage();
    let saved: Record<string, unknown> | undefined;
    const servers = ["docs", "shared"].map((serverName) => ({
      serverName,
      origin: "organization",
      credentialMode: "shared",
      globalEnabled: serverName !== "docs",
      userEnabled: true,
      configured: false,
      settingsRevision: 1,
      policyFingerprint: "policy-original",
      credentialStored: false,
      credentialFingerprint: null,
      headerGuides: [{ name: "X-Tenant-ID", description: "Your tenant ID" }],
      headers: [{ name: "X-Tenant-ID", configured: true }],
    }));
    await page.route("**/platformclaw/api/mcp", async (route) => {
      if (route.request().method() === "PUT") {
        saved = route.request().postDataJSON() as Record<string, unknown>;
      }
      await route.fulfill({ json: { servers } });
    });
    try {
      await install(page, "mcp-settings");
      const component = page.locator("platformclaw-mcp-settings");
      await expect.poll(() => component.locator(".detail").isVisible()).toBe(true);
      expect(await component.locator(".catalog").isVisible()).toBe(false);
      await component.locator("[data-action='picker']").click();
      await expect.poll(() => component.locator(".catalog").isVisible()).toBe(true);
      expect(await component.locator("[data-toggle='docs']").isDisabled()).toBe(true);
      await component.locator("[data-action='select'][data-server='shared']").click();
      await expect.poll(() => component.locator(".detail").isVisible()).toBe(true);
      expect(await component.locator("[name='guide-value']").inputValue()).toBe("");
      expect(await component.locator("[name='guide-value']").isDisabled()).toBe(true);
      await component.locator("[data-action='remove-header']").click();
      await component.locator("[data-action='add-header']").click();
      await component.locator("[name='custom-name']").fill("X-Project");
      await component.locator("[name='custom-value']").fill("project-value");
      await screenshot(page, "user-narrow-header-draft.png");
      await component.locator("[data-action='save']").click();
      await expect.poll(() => saved).toBeDefined();
      expect(saved).toEqual({
        serverName: "shared",
        expectedRevision: 1,
        expectedPolicyFingerprint: "policy-original",
        enabled: true,
        headers: [
          { name: "X-Tenant-ID", value: "" },
          { name: "X-Project", value: "project-value" },
        ],
      });
      expect(await component.locator("[name='guide-value']").inputValue()).toBe("");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});
