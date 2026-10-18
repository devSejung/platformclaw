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
import { createTweakcnThemePayload } from "../test-helpers/custom-theme.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "coding-agent-settings");

const detectedEnvironment = {
  ANTHROPIC_BASE_URL:
    "https://gateway-preview.example.test/api/anthropic/long-organization-routing-path",
  ADMIN_API_URL: "https://gateway-admin.example.test/platform/administration/v2",
  OIDC_ISSUER_URL: "https://identity.example.test/realms/platform-engineering",
  OIDC_CLIENT_ID: "platformclaw-claude-code-personal-vm",
};

let browser: Browser;
let server: ControlUiE2eServer;

const themeCases = ["platformclaw", "claw", "knot", "dash", "custom"].flatMap((family) =>
  (["light", "dark"] as const).map((mode) => ({ family, mode })),
);

async function mount(page: Page, locale = "ko"): Promise<void> {
  await page.goto(new URL("sw.js", server.baseUrl).href);
  await page.setContent(
    `<!doctype html><html><head><link rel="stylesheet" href="${server.baseUrl}src/styles.css"></head><body></body></html>`,
  );
  await page.evaluate((value) => localStorage.setItem("openclaw.i18n.locale", value), locale);
  await page.addScriptTag({
    type: "module",
    url: `${server.baseUrl}src/platformclaw/execution-settings.ts`,
  });
  await page.evaluate(async () => {
    await customElements.whenDefined("platformclaw-execution-settings");
    document.body.replaceChildren(document.createElement("platformclaw-execution-settings"));
  });
}

async function screenshot(page: Page, name: string): Promise<void> {
  if (!captureProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
}

suite("PlatformClaw coding agent settings", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    if (captureProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    { name: "mobile", viewport: { width: 390, height: 844 } },
  ])("renders and edits all independent agent cards on $name", async ({ name, viewport }) => {
    const context = await browser.newContext({
      locale: "ko-KR",
      viewport,
      ...(captureProof
        ? { recordVideo: { dir: path.join(proofDir, "video"), size: viewport } }
        : {}),
    });
    const page = await context.newPage();
    let settings = {
      activeTarget: "assigned_vm",
      targetRevision: 8,
      credentialStatus: "current",
      accountId: "person.one",
      availableVms: [{ id: "vm-one", label: "Development VM" }],
      assignment: {
        id: "allocation-one",
        vmHostId: "vm-one",
        status: "ready",
        vmLabel: "Development VM",
        safeConnectLabel: "Corporate access",
        linuxAccount: "person.one",
        remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
      },
      codingAgents: [
        {
          hasSavedConfiguration: false,
          configuration: {
            agent: "claude",
            enabled: false,
            executablePath: "",
            environment: {
              ANTHROPIC_BASE_URL: "",
              ADMIN_API_URL: "",
              OIDC_ISSUER_URL: "",
              OIDC_CLIENT_ID: "",
            },
          },
        },
        {
          hasSavedConfiguration: true,
          configuration: { agent: "codex", enabled: true, executablePath: "/usr/bin/codex" },
        },
        {
          hasSavedConfiguration: false,
          configuration: { agent: "opencode", enabled: false, executablePath: "" },
        },
      ],
    };
    const requests: unknown[] = [];
    await page.route("**/platformclaw/api/execution**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({ json: settings });
        return;
      }
      const body = request.postDataJSON();
      requests.push(body);
      if (body.action === "detect") {
        await route.fulfill({
          json: {
            agent: "claude",
            executablePath: "/home/person.one/.local/bin/claude",
            environment: detectedEnvironment,
            diagnostics: [
              { stage: "executable", status: "passed", message: "Executable detected" },
            ],
          },
        });
        return;
      }
      if (body.action === "save") {
        settings = {
          ...settings,
          codingAgents: settings.codingAgents.map((item) =>
            item.configuration.agent === body.configuration.agent
              ? { hasSavedConfiguration: true, configuration: body.configuration }
              : item,
          ),
        };
        await route.fulfill({ json: settings });
        return;
      }
      await route.fulfill({
        json: {
          agent: body.configuration.agent,
          executablePath: body.configuration.executablePath,
          reportedVersion: "Claude Code 2.4.1",
          diagnostics: [
            { stage: "executable", status: "passed", message: "Claude Code 2.4.1 installed" },
            {
              stage: "helper",
              status: "skipped",
              message: "Helper status is not observed separately",
            },
            { stage: "acp", status: "passed", message: "ACP prompt completed" },
          ],
        },
      });
    });
    await mount(page);
    const component = page.locator("platformclaw-execution-settings");
    await component.locator("[data-action='open']").click();
    const dialog = component.getByRole("dialog");
    const panel = component.locator(".panel");
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.x).toBeGreaterThanOrEqual(0);
    expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width);
    const settingsTabs = component.locator(".settings-tabs");
    await expect
      .poll(() =>
        settingsTabs.evaluate((element) => {
          const group = element as HTMLElement;
          return Boolean(
            group.shadowRoot?.querySelector('[part="tabs"]') &&
            group
              .querySelector<HTMLElement>("[data-settings-tab='location']")
              ?.shadowRoot?.querySelector('[part="base"]'),
          );
        }),
      )
      .toBe(true);
    // Compare one animation frame while the modal scales into view.
    const tabBoxes = await settingsTabs.evaluate((group) =>
      ["location", "agents"].map((id) => {
        const tab = group.querySelector<HTMLElement>(`[data-settings-tab='${id}']`);
        return tab && tab.getClientRects().length > 0
          ? { width: tab.getBoundingClientRect().width }
          : null;
      }),
    );
    expect(tabBoxes[0]).not.toBeNull();
    expect(tabBoxes[1]).not.toBeNull();
    expect(Math.abs(tabBoxes[0]!.width - tabBoxes[1]!.width)).toBeLessThan(1);
    const tabSurface = await settingsTabs.evaluate((element) => {
      const group = element as HTMLElement & { shadowRoot: ShadowRoot | null };
      const activeTab = group.querySelector<HTMLElement>("[data-settings-tab='location']");
      const tabsPart = group.shadowRoot?.querySelector<HTMLElement>('[part="tabs"]');
      const activeBase = activeTab?.shadowRoot?.querySelector<HTMLElement>('[part="base"]');
      return {
        trackWidth: getComputedStyle(group).getPropertyValue("--track-width").trim(),
        trackColor: getComputedStyle(group).getPropertyValue("--track-color").trim(),
        tabsDisplay: tabsPart ? getComputedStyle(tabsPart).display : "",
        activeBackground: activeBase ? getComputedStyle(activeBase).backgroundColor : "",
      };
    });
    expect(tabSurface.trackWidth).toBe("0");
    expect(tabSurface.trackColor).toBe("transparent");
    expect(tabSurface.tabsDisplay).toBe("flex");
    expect(tabSurface.activeBackground).not.toBe("rgba(0, 0, 0, 0)");
    await screenshot(page, `01-${name}-work-location.png`);
    const locationTab = component.locator("[data-settings-tab='location']");
    await locationTab.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => component.locator("[data-settings-tab='agents']").getAttribute("aria-selected"))
      .toBe("true");
    for (const agent of ["claude", "codex", "opencode"]) {
      await expect
        .poll(() => component.locator(`[data-coding-agent='${agent}']`).isVisible())
        .toBe(true);
    }
    await screenshot(page, `02-${name}-agents-collapsed.png`);

    const claude = component.locator("[data-coding-agent='claude']");
    await claude.locator("[data-agent-expand='claude']").click();
    await claude.locator("[data-agent-action='claude-detect']").click();
    await expect
      .poll(() => claude.locator("[data-agent-field='claude-ADMIN_API_URL']").inputValue())
      .toBe(detectedEnvironment.ADMIN_API_URL);
    await component.locator("[data-settings-tab='location']").click();
    await component.locator("[data-settings-tab='agents']").click();
    await expect
      .poll(() => claude.locator("[data-agent-field='claude-ADMIN_API_URL']").inputValue())
      .toBe(detectedEnvironment.ADMIN_API_URL);
    const toggle = claude.locator("[data-agent-toggle='claude']");
    await claude.locator("label.switch").click();
    await expect.poll(() => toggle.isChecked()).toBe(true);
    await expect
      .poll(() =>
        claude.getByText("저장하지 않은 변경 사항 · 저장해야 적용됩니다", { exact: true }).count(),
      )
      .toBe(1);
    await claude.locator("[data-agent-action='claude-check']").click();
    await expect.poll(() => claude.getByText("인증", { exact: true }).count()).toBe(1);
    await expect.poll(() => claude.getByText("ACP 연결", { exact: true }).count()).toBe(1);
    const gateway = claude.locator("[data-claude-gateway]");
    await claude.locator("h3").scrollIntoViewIfNeeded();
    await screenshot(page, `02a-${name}-claude-heading-ready.png`);
    await claude.locator("[data-agent-field='claude-OIDC_CLIENT_ID']").scrollIntoViewIfNeeded();
    await screenshot(page, `02b-${name}-claude-long-values.png`);
    await claude.locator("[data-agent-action='claude-save']").click();
    await expect
      .poll(() => claude.locator(".agent-heading").textContent())
      .toContain("저장된 사용 권한: 켬");
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ action: "detect", agent: "claude", expectedRevision: 8 });
    expect(requests[2]).toMatchObject({
      action: "save",
      configuration: { agent: "claude", enabled: true },
    });
    await expect.poll(() => dialog.isVisible()).toBe(true);
    await screenshot(page, `03-${name}-claude-saved.png`);
    if ((await gateway.getAttribute("open")) !== null) {
      await gateway.locator("summary").click();
    }
    await expect.poll(() => gateway.getAttribute("open")).toBeNull();
    await claude.scrollIntoViewIfNeeded();
    await screenshot(page, `04-${name}-claude-collapsed.png`);
    const codex = component.locator("[data-coding-agent='codex']");
    await codex.scrollIntoViewIfNeeded();
    const codexToggle = codex.locator("[data-agent-toggle='codex']");
    await codex.locator("label.switch").click();
    await expect.poll(() => codexToggle.isChecked()).toBe(false);
    await expect
      .poll(() => codex.locator("[data-agent-quick-save='codex']").isVisible())
      .toBe(true);
    await screenshot(page, `04b-${name}-codex-off-pending-save.png`);
    await codex.locator("[data-agent-quick-save='codex']").click();
    await expect
      .poll(() => codex.getByText("저장된 사용 권한: 끔", { exact: true }).count())
      .toBe(1);
    await component.locator("[data-action='refresh']").click();
    await expect.poll(() => codexToggle.isChecked()).toBe(false);
    await expect.poll(() => codexToggle.isEnabled()).toBe(true);
    await codex.locator("label.switch").click();
    await expect.poll(() => codexToggle.isChecked()).toBe(true);
    await expect
      .poll(() => codex.locator("[data-agent-quick-save='codex']").isVisible())
      .toBe(true);
    await codex.locator("[data-agent-quick-save='codex']").click();
    await expect
      .poll(() => codex.getByText("저장된 사용 권한: 켬", { exact: true }).count())
      .toBe(1);
    await context.close();
  });

  it("preserves direct work-location switching, credentials, selection, release, and errors", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    const emptyAgents = [
      {
        hasSavedConfiguration: false,
        configuration: {
          agent: "claude",
          enabled: false,
          executablePath: "",
          environment: {
            ANTHROPIC_BASE_URL: "",
            ADMIN_API_URL: "",
            OIDC_ISSUER_URL: "",
            OIDC_CLIENT_ID: "",
          },
        },
      },
      {
        hasSavedConfiguration: false,
        configuration: { agent: "codex", enabled: false, executablePath: "" },
      },
      {
        hasSavedConfiguration: false,
        configuration: { agent: "opencode", enabled: false, executablePath: "" },
      },
    ];
    let settings: Record<string, unknown> = {
      activeTarget: "assigned_vm",
      targetRevision: 3,
      credentialStatus: "current",
      accountId: "person.one",
      availableVms: [{ id: "vm-one", label: "Development VM" }],
      assignment: {
        id: "allocation-one",
        vmHostId: "vm-one",
        status: "ready",
        vmLabel: "Development VM",
        safeConnectLabel: "Corporate access",
        linuxAccount: "person.one",
      },
      codingAgents: emptyAgents,
    };
    let failTargetOnce = true;
    let failRefreshOnce = false;
    const requests: Array<{ path: string; body: unknown }> = [];
    await page.route("**/platformclaw/api/execution**", async (route) => {
      const request = route.request();
      const requestPath = new URL(request.url()).pathname;
      if (request.method() === "GET") {
        if (failRefreshOnce) {
          failRefreshOnce = false;
          await route.fulfill({ status: 503, json: { error: "Fixture unavailable" } });
        } else {
          await route.fulfill({ json: settings });
        }
        return;
      }
      const body = request.postData() ? request.postDataJSON() : undefined;
      requests.push({ path: requestPath, body });
      if (requestPath.endsWith("/target") && failTargetOnce) {
        failTargetOnce = false;
        await route.fulfill({ status: 503, json: { error: "Fixture switch failed" } });
        return;
      }
      if (requestPath.endsWith("/target")) {
        expect(body.expectedRevision).toBe(settings.targetRevision);
        settings = {
          ...settings,
          activeTarget: body.target,
          targetRevision: Number(settings.targetRevision) + 1,
        };
      } else if (requestPath.endsWith("/selection")) {
        settings = {
          ...settings,
          targetRevision: Number(settings.targetRevision) + 1,
          assignment: {
            id: "allocation-two",
            vmHostId: body.vmHostId,
            status: "ready",
            vmLabel: "Development VM",
            safeConnectLabel: "Corporate access",
            linuxAccount: body.linuxAccount,
          },
        };
      } else if (requestPath.endsWith("/release")) {
        const { assignment: _assignment, ...rest } = settings;
        settings = { ...rest, availableVms: [] };
      }
      await route.fulfill({ json: settings });
    });
    await mount(page, "en");
    const component = page.locator("platformclaw-execution-settings");
    await component.locator("[data-action='open']").click();
    await expect
      .poll(() => component.getByRole("dialog", { name: "Work environment settings" }).isVisible())
      .toBe(true);
    await component.locator("[data-target='platform_server']").click();
    await component.getByText("Fixture switch failed", { exact: true }).waitFor();
    expect(await component.locator("[data-action='confirm-switch']").count()).toBe(0);
    await component.locator("[data-target='platform_server']").click();
    await expect
      .poll(() => component.locator("[data-target='assigned_vm']").isEnabled())
      .toBe(true);

    const credentials = component.locator(".credentials-details");
    if ((await credentials.getAttribute("open")) === null) {
      await credentials.locator("summary").click();
    }
    await credentials.locator("[data-password]").fill("fixture-only");
    await credentials.locator("[data-action='credential']").click();
    await expect
      .poll(() => requests.find((item) => item.path.endsWith("/credential"))?.body)
      .toEqual({
        password: "fixture-only",
      });
    await expect.poll(() => component.locator("[data-action='test']").isEnabled()).toBe(true);
    await component.locator("[data-action='test']").click();
    await expect.poll(() => requests.some((item) => item.path.endsWith("/test"))).toBe(true);
    await expect.poll(() => component.locator("[data-action='test']").isEnabled()).toBe(true);
    if (settings.activeTarget === "assigned_vm") {
      await component.locator("[data-target='platform_server']").click();
    }

    const form = component.locator("form[data-action='select-vm']");
    await form.locator("input[name='linuxAccount']").fill("pc-user");
    await form.locator("button").click();
    expect(
      await form
        .locator("input[name='password']")
        .evaluate((input) => (input as HTMLInputElement).validity.valueMissing),
    ).toBe(true);
    await form.locator("input[name='password']").fill("fixture-only");
    await form.locator("button").click();
    await expect
      .poll(() => requests.find((item) => item.path.endsWith("/selection"))?.body)
      .toEqual({
        vmHostId: "vm-one",
        linuxAccount: "pc-user",
        password: "fixture-only",
      });
    await expect
      .poll(() => component.locator("[data-action='open']").textContent())
      .toContain("My development VM");
    await component.locator("[data-target='platform_server']").click();
    await expect.poll(() => component.locator("[data-action='release']").isEnabled()).toBe(true);

    await component.locator("[data-action='release']").click();
    await component.locator("[data-action='cancel-release']").click();
    await expect.poll(() => component.locator("[data-action='confirm-release']").count()).toBe(0);
    failRefreshOnce = true;
    await component.locator("[data-action='refresh']").click();
    await component.getByText("Fixture unavailable", { exact: true }).waitFor();
    await component.locator("[data-action='refresh']").click();
    await component.locator("[data-action='release']").click();
    await component.locator("[data-action='confirm-release']").click();
    await expect.poll(() => component.locator(".credentials-details").count()).toBe(0);
    await screenshot(page, "05-desktop-empty-after-release.png");
    await page.close();
  });

  it("opens credentials and gates VM/probe actions when credentials are missing", async () => {
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 360, height: 640 } });
    await page.route("**/platformclaw/api/execution**", (route) =>
      route.fulfill({
        json: {
          activeTarget: "platform_server",
          targetRevision: 1,
          credentialStatus: "missing",
          accountId: "person.one",
          availableVms: [],
          assignment: {
            id: "allocation-one",
            vmHostId: "vm-one",
            status: "connection_required",
            vmLabel: "Development VM",
            safeConnectLabel: "Corporate access",
            linuxAccount: "person.one",
          },
          codingAgents: [],
        },
      }),
    );
    await mount(page, "en");
    const component = page.locator("platformclaw-execution-settings");
    await component.locator("[data-action='open']").click();
    await expect
      .poll(() => component.locator(".credentials-details").getAttribute("open"))
      .not.toBeNull();
    await expect
      .poll(() => component.locator("[data-target='assigned_vm']").isDisabled())
      .toBe(true);
    await expect.poll(() => component.locator("[data-action='test']").isDisabled()).toBe(true);
    const closeBox = await component.locator("[data-action='close']").boundingBox();
    const footerBox = await component.locator("[data-confirmation-footer]").boundingBox();
    expect(closeBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    expect(closeBox!.y).toBeGreaterThanOrEqual(0);
    expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(640);
    await screenshot(page, "06-mobile-missing-credentials.png");
    await component.locator("[data-settings-tab='agents']").click();
    await expect
      .poll(() => component.locator("[data-agent-action$='-check']:enabled").count())
      .toBe(0);
    await page.close();
  });

  it.each(themeCases)(
    "connects and activates the VM with visible progress on mobile $family $mode",
    async ({ family, mode }) => {
      const context = await browser.newContext({
        colorScheme: mode,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      let releaseSelection = () => {};
      let releaseActivation = () => {};
      const selectionGate = new Promise<void>((resolve) => {
        releaseSelection = resolve;
      });
      const activationGate = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const requests: Array<{ path: string; body: unknown }> = [];
      const initialSettings = {
        activeTarget: "platform_server",
        targetRevision: 3,
        credentialStatus: "missing",
        accountId: "person.one",
        availableVms: [{ id: "development", label: "Development VM" }],
        codingAgents: [],
      };
      const selectedSettings = {
        ...initialSettings,
        targetRevision: 4,
        credentialStatus: "current",
        assignment: {
          id: "allocation-development",
          vmHostId: "development",
          status: "ready",
          vmLabel: "Development VM",
          safeConnectLabel: "Corporate access",
          linuxAccount: "person.one",
          remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
          lastConnectionSucceededAt: 1_787_642_400_000,
        },
      };
      const activeSettings = {
        ...selectedSettings,
        activeTarget: "assigned_vm",
        targetRevision: 5,
      };
      let currentSettings: typeof initialSettings | typeof selectedSettings = initialSettings;

      await page.route("**/platformclaw/api/execution**", async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "POST") {
          requests.push({ path: pathname, body: request.postDataJSON() });
          if (pathname.endsWith("/selection")) {
            await selectionGate;
            currentSettings = selectedSettings;
          } else if (pathname.endsWith("/target")) {
            await activationGate;
            currentSettings = activeSettings;
          } else {
            throw new Error(`Unexpected execution mutation: ${pathname}`);
          }
        }
        await route.fulfill({ json: currentSettings });
      });

      try {
        await mount(page, "en");
        if (family === "custom") {
          // Browser-owned module source avoids Vitest rewriting imports inside evaluate callbacks.
          await page.addScriptTag({
            type: "module",
            content: `
              import { importCustomThemeFromUrl, syncCustomThemeStyleTag } from ${JSON.stringify(`${server.baseUrl}src/app/custom-theme.ts`)};
              const theme = await importCustomThemeFromUrl(
                "https://tweakcn.com/themes/connection-proof",
                async () => new Response(JSON.stringify(${JSON.stringify(createTweakcnThemePayload())}), {
                  headers: { "Content-Type": "application/json" },
                }),
              );
              syncCustomThemeStyleTag(theme);
            `,
          });
          await page.locator("#openclaw-custom-theme").waitFor({ state: "attached" });
        }
        await page.evaluate(
          ({ family: themeFamily, mode: themeMode }) => {
            const resolvedFamily =
              themeFamily === "claw" ? "" : themeFamily === "knot" ? "openknot" : themeFamily;
            const resolvedTheme = resolvedFamily
              ? `${resolvedFamily}${themeMode === "light" ? "-light" : ""}`
              : themeMode;
            document.documentElement.dataset.theme = resolvedTheme;
            document.documentElement.dataset.themeMode = themeMode;
          },
          { family, mode },
        );
        const component = page.locator("platformclaw-execution-settings");
        const badge = component.getByRole("button", { name: "Open work location settings" });
        await expect.poll(() => badge.textContent()).toContain("Basic workspace");
        await badge.click();
        await expect
          .poll(() =>
            component.getByRole("dialog", { name: "Work environment settings" }).isVisible(),
          )
          .toBe(true);
        const form = component.locator("form[data-action='select-vm']");
        await form.locator("select[name='vmHostId']").selectOption("development");
        await form.locator("input[name='linuxAccount']").fill("person.one");
        await form.locator("input[name='password']").fill("test-password");
        await component.getByRole("button", { name: "Connect and use VM", exact: true }).click();

        const progress = component.locator("[data-connection-progress]");
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0]).toEqual({
          path: "/platformclaw/api/execution/selection",
          body: {
            vmHostId: "development",
            linuxAccount: "person.one",
            password: "test-password",
          },
        });
        await expect.poll(() => progress.getAttribute("role")).toBe("status");
        await expect
          .poll(() => progress.locator("[data-step='connection']").getAttribute("data-state"))
          .toBe("active");
        expect(await progress.locator("[data-step='activation']").getAttribute("data-state")).toBe(
          "pending",
        );
        expect(
          (await progress.locator("[data-state='active']").textContent())?.trim(),
        ).toBeTruthy();
        expect(await progress.locator("[data-state='active']").isVisible()).toBe(true);
        expect(await component.locator("input:not(:disabled), select:not(:disabled)").count()).toBe(
          0,
        );
        expect(await component.locator("[data-action='close']").isEnabled()).toBe(true);
        expect(await badge.getAttribute("aria-busy")).toBe("true");
        const progressBox = await progress.boundingBox();
        expect(progressBox).not.toBeNull();
        expect(progressBox!.x).toBeGreaterThanOrEqual(0);
        expect(progressBox!.x + progressBox!.width).toBeLessThanOrEqual(390);
        expect(progressBox!.y + progressBox!.height).toBeLessThanOrEqual(844);
        const colors = await progress.evaluate((element) => {
          const root = getComputedStyle(document.documentElement);
          const probe = document.createElement("span");
          probe.style.color = "var(--text)";
          element.append(probe);
          const expectedText = getComputedStyle(probe).color;
          probe.remove();
          return {
            text: getComputedStyle(element).color,
            expectedText,
            run: root.getPropertyValue("--run").trim(),
            theme: document.documentElement.dataset.theme,
          };
        });
        expect(colors.text).toBe(colors.expectedText);
        expect(colors.run).not.toBe("");
        expect(colors.theme).toContain(
          family === "claw" ? mode : family === "knot" ? "openknot" : family,
        );
        await screenshot(page, `connect-${family}-${mode}-01-connection.png`);

        releaseSelection();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[1]).toEqual({
          path: "/platformclaw/api/execution/target",
          body: { target: "assigned_vm", expectedRevision: 4 },
        });
        await expect
          .poll(() => progress.locator("[data-step='connection']").getAttribute("data-state"))
          .toBe("complete");
        expect(await progress.locator("[data-step='activation']").getAttribute("data-state")).toBe(
          "active",
        );
        expect(
          (await progress.locator("[data-state='active']").textContent())?.trim(),
        ).toBeTruthy();
        expect(await badge.getAttribute("aria-busy")).toBe("true");
        await screenshot(page, `connect-${family}-${mode}-02-activation.png`);

        releaseActivation();
        await expect.poll(() => badge.textContent()).toContain("My development VM");
        expect(requests).toHaveLength(2);
        expect(await component.locator("[data-action='confirm-switch']").count()).toBe(0);
        await expect.poll(() => badge.getAttribute("aria-busy")).not.toBe("true");
        await screenshot(page, `connect-${family}-${mode}-03-active.png`);
      } finally {
        releaseSelection();
        releaseActivation();
        await context.close();
      }
    },
  );
});
