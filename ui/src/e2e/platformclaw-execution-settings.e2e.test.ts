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
    await screenshot(page, `01-${name}-work-location.png`);
    const locationTab = component.locator("[data-settings-tab='location']");
    await locationTab.focus();
    await page.keyboard.press("ArrowRight");
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

  it("preserves work-location confirmation, credentials, selection, release, and errors", async () => {
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
        settings = { ...settings, activeTarget: body.target, targetRevision: 4 };
      } else if (requestPath.endsWith("/selection")) {
        settings = {
          ...settings,
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
    await component.locator("[data-target='platform_server']").click();
    await component.locator("[data-action='cancel-switch']").click();
    await expect.poll(() => component.locator("[data-action='confirm-switch']").count()).toBe(0);
    await component.locator("[data-target='platform_server']").click();
    await component.locator("[data-action='confirm-switch']").click();
    await component.getByText("Fixture switch failed", { exact: true }).waitFor();
    await expect.poll(() => component.locator("[data-action='confirm-switch']").count()).toBe(1);
    await component.locator("[data-action='confirm-switch']").click();
    await expect
      .poll(() => component.locator("[data-target='assigned_vm']").isEnabled())
      .toBe(true);

    const credentials = component.locator(".credentials-details");
    if ((await credentials.getAttribute("open")) === null) {
      await credentials.locator("summary").click();
    }
    await credentials.locator("[data-password]").fill("fixture-only");
    await credentials.locator("[data-action='credential']").click();
    await expect.poll(() => requests.at(-1)?.path).toContain("/credential");
    expect(requests.at(-1)?.body).toEqual({ password: "fixture-only" });
    await component.locator("[data-action='test']").click();
    await expect.poll(() => requests.at(-1)?.path).toContain("/test");

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
    await expect.poll(() => requests.at(-1)?.path).toContain("/selection");
    expect(requests.at(-1)?.body).toEqual({
      vmHostId: "vm-one",
      linuxAccount: "pc-user",
      password: "fixture-only",
    });

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
});
