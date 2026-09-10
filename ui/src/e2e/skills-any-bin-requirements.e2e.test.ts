// Control UI coverage proves alternative skill binaries remain diagnosable and installable.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

let browser: Browser;
let server: ControlUiE2eServer;

function codingAgentSkill(missingAnyBins: string[]) {
  return {
    name: "Coding Agent",
    description: "Delegate coding work to an available coding CLI.",
    source: "openclaw-bundled",
    bundled: true,
    filePath: "/tmp/openclaw-e2e/skills/coding-agent/SKILL.md",
    baseDir: "/tmp/openclaw-e2e/skills/coding-agent",
    skillKey: "coding-agent",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: missingAnyBins.length === 0,
    platformIncompatible: false,
    modelVisible: missingAnyBins.length === 0,
    userInvocable: true,
    commandVisible: missingAnyBins.length === 0,
    requirements: {
      bins: [],
      anyBins: ["claude", "codex", "opencode"],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      anyBins: missingAnyBins,
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [
      {
        id: "node-codex",
        kind: "node",
        label: "Install Codex CLI (npm)",
        bins: ["codex"],
      },
    ],
  };
}

describeControlUiE2e("Control UI alternative skill binary requirements", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("explains alternative missing binaries and installs one through the Gateway", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "skills.install"],
      methodResponses: {
        "skills.status": {
          workspaceDir: "/tmp/openclaw-e2e/workspace",
          managedSkillsDir: "/tmp/openclaw-e2e/skills",
          skills: [codingAgentSkill(["claude", "codex", "opencode"])],
        },
        "skills.install": { message: "Installed Codex CLI" },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: "Open Coding Agent details" }).click();

      const dialog = page.locator("openclaw-modal-dialog", { hasText: "Coding Agent" });
      await expect.poll(async () => await dialog.count()).toBe(1);
      expect(await dialog.textContent()).toContain("bin:any of (claude, codex, opencode)");
      await dialog.getByRole("button", { name: "Install Codex CLI (npm)" }).click();

      const request = await gateway.waitForRequest("skills.install");
      expect(request.params).toMatchObject({
        name: "Coding Agent",
        installId: "node-codex",
        dangerouslyForceUnsafeInstall: false,
      });
    } finally {
      await context.close();
    }
  });

  it("does not show missing alternatives or an installer for an eligible skill", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "skills.status": {
          workspaceDir: "/tmp/openclaw-e2e/workspace",
          managedSkillsDir: "/tmp/openclaw-e2e/skills",
          skills: [codingAgentSkill([])],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: "Open Coding Agent details" }).click();

      const dialog = page.locator("openclaw-modal-dialog", { hasText: "Coding Agent" });
      await expect.poll(async () => await dialog.count()).toBe(1);
      expect(await dialog.getByText("bin:any of", { exact: false }).count()).toBe(0);
      expect(await dialog.getByRole("button", { name: "Install Codex CLI (npm)" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("filters every skill state, searches within it, collapses groups, and dismisses details", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const ready = codingAgentSkill([]);
    const needsSetup = {
      ...codingAgentSkill(["claude", "codex", "opencode"]),
      name: "Needs Setup Agent",
      skillKey: "needs-setup-agent",
    };
    const disabled = {
      ...codingAgentSkill([]),
      name: "Disabled Agent",
      skillKey: "disabled-agent",
      disabled: true,
      eligible: false,
      modelVisible: false,
      commandVisible: false,
    };
    await installMockGateway(page, {
      methodResponses: {
        "skills.status": {
          workspaceDir: "/tmp/openclaw-e2e/workspace",
          managedSkillsDir: "/tmp/openclaw-e2e/skills",
          skills: [ready, needsSetup, disabled],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills`);
      expect(response?.status()).toBe(200);
      await expect
        .poll(() => page.getByText("Coding Agent", { exact: true }).isVisible())
        .toBe(true);

      await page.locator('wa-radio[value="needs-setup"]').click();
      await expect
        .poll(() => page.getByText("Needs Setup Agent", { exact: true }).isVisible())
        .toBe(true);
      expect(await page.getByText("Coding Agent", { exact: true }).count()).toBe(0);

      const search = page.locator('input[name="skills-filter"]');
      await search.fill("missing result");
      await expect
        .poll(() => page.getByText("No skills found.", { exact: true }).isVisible())
        .toBe(true);
      await search.fill("needs setup");
      await expect
        .poll(() => page.getByText("Needs Setup Agent", { exact: true }).isVisible())
        .toBe(true);

      const group = page.locator("details.skills-group");
      expect(await group.getAttribute("open")).not.toBeNull();
      await group.locator("summary").click();
      expect(await group.getAttribute("open")).toBeNull();
      await group.locator("summary").click();

      await page.getByRole("button", { name: "Open Needs Setup Agent details" }).click();
      const dialog = page.locator("openclaw-modal-dialog", { hasText: "Needs Setup Agent" });
      await expect.poll(() => dialog.isVisible()).toBe(true);
      expect(await dialog.textContent()).toContain("bin:any of (claude, codex, opencode)");
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);

      await search.fill("");
      await page.locator('wa-radio[value="disabled"]').click();
      await expect
        .poll(() => page.getByText("Disabled Agent", { exact: true }).isVisible())
        .toBe(true);
      await page.locator('wa-radio[value="ready"]').click();
      await expect
        .poll(() => page.getByText("Coding Agent", { exact: true }).isVisible())
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
