import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
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
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "vm-skillhub-publish");

let server: ControlUiE2eServer;
let browser: Browser;
const contexts = new Set<BrowserContext>();

function vmWorkspaceSkill() {
  const requirements = { bins: [], anyBins: [], env: [], config: [], os: [] };
  return {
    name: "VM Release",
    description: "Publish release notes directly from the assigned VM.",
    source: "platformclaw-vm-workspace",
    bundled: false,
    filePath: "/home/person.one/.platformclaw/workspace/skills/vm-release/SKILL.md",
    baseDir: "/home/person.one/.platformclaw/workspace/skills/vm-release",
    skillKey: "vm-release",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    platformIncompatible: false,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    requirements,
    missing: requirements,
    configChecks: [],
    install: [],
  };
}

async function installPlatformClawDocument(page: Page): Promise<void> {
  const response = await page.request.get(server.baseUrl);
  const source = await response.text();
  await page.route("**/platformclaw/app/**", async (route) => {
    const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
    await route.fulfill({
      body: source.replace("</head>", `${descriptor}</head>`),
      headers: response.headers(),
      status: response.status(),
    });
  });
}

async function installWorkspaceRoutes(page: Page) {
  const published: Array<Record<string, unknown>> = [];
  const executionMutations: string[] = [];
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
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
      },
      status: 200,
    }),
  );
  await page.route("**/platformclaw/api/execution", (route) => {
    if (route.request().method() !== "GET") {
      executionMutations.push(route.request().method());
    }
    return route.fulfill({
      json: {
        accountId: "person.one",
        activeTarget: "assigned_vm",
        assignment: { vmHostId: "vm-one", status: "ready" },
        availableVms: [],
        credentialStatus: "ready",
        targetRevision: 1,
      },
      status: 200,
    });
  });
  await page.route("**/platformclaw/api/skill-hub/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/config")) {
      return route.fulfill({
        json: {
          namespaces: ["engineering"],
          maxPackageBytes: 524_288_000,
          activeTarget: "assigned_vm",
          installTargets: [
            { target: "platform_server", available: true, status: "ready" },
            { target: "assigned_vm", available: true, status: "ready" },
          ],
        },
        status: 200,
      });
    }
    if (url.pathname.endsWith("/workspace-skills")) {
      const source = url.searchParams.get("source");
      return route.fulfill({
        json: {
          source,
          items:
            source === "assigned_vm"
              ? [{ skillKey: "vm-release", name: "VM Release", version: "2.3.0" }]
              : [{ skillKey: "basic-checklist", name: "Basic Checklist", version: "1.1.0" }],
        },
        status: 200,
      });
    }
    if (url.pathname.endsWith("/publish")) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      published.push(body);
      return route.fulfill({
        json: { namespace: body.namespace, slug: body.skill, version: body.version },
        status: 200,
      });
    }
    return route.fulfill({ json: { items: [], total: 0, unreadCount: 0 }, status: 200 });
  });
  return { executionMutations, published };
}

async function newPage(locale: "en-US" | "ko-KR") {
  const context = await browser.newContext({
    locale,
    serviceWorkers: "block",
    viewport: { width: 1920, height: 1080 },
  });
  contexts.add(context);
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("platformclaw.product-tour.v1.completed", "true");
  });
  await installPlatformClawDocument(page);
  const routes = await installWorkspaceRoutes(page);
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: "person_one",
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    sessionKey: "agent:person_one:main",
    methodResponses: {
      "skills.status": {
        workspaceDir: "/home/person.one/.platformclaw/workspace",
        managedSkillsDir: "/tmp/platformclaw-e2e/skills",
        executionTarget: "assigned_vm",
        skills: [vmWorkspaceSkill()],
      },
    },
  });
  return { page, gateway, ...routes };
}

describeControlUiE2e("PlatformClaw workspace Skill Hub publishing at FHD", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    await mkdir(proofDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
    contexts.clear();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("publishes an assigned-VM skill from either plugin tab without switching workspaces", async () => {
    const { page, gateway, executionMutations, published } = await newPage("en-US");
    await page.goto(`${server.baseUrl}platformclaw/app/skills`);
    const publishFromSkills = page.getByRole("button", { name: "Publish to Hub" });
    await expect.poll(() => publishFromSkills.isVisible()).toBe(true);
    await page.screenshot({ path: path.join(proofDir, "01-skills-vm-publish-fhd.png") });
    await publishFromSkills.click();
    const skillsDialog = page.locator("openclaw-modal-dialog", { hasText: "vm-release" });
    await expect.poll(() => skillsDialog.isVisible()).toBe(true);
    await page.screenshot({
      animations: "disabled",
      path: path.join(proofDir, "02-skills-vm-dialog-fhd.png"),
    });

    await page.goto(`${server.baseUrl}platformclaw/app/skills/hub`);
    const publishFromHub = page.getByRole("button", { name: "Publish workspace skill" });
    await expect.poll(() => publishFromHub.isVisible()).toBe(true);
    await page.screenshot({ path: path.join(proofDir, "03-skill-hub-fhd.png") });
    await publishFromHub.click();
    const dialog = page.locator(".skill-hub-workspace-publish");
    const sources = dialog.locator("select").first();
    const skills = dialog.locator("select").nth(1);
    await expect.poll(() => sources.inputValue()).toBe("assigned_vm");
    await expect.poll(() => skills.inputValue()).toBe("vm-release");
    await expect.poll(() => dialog.textContent()).toContain("VM Release (vm-release)");

    await sources.selectOption("platform_server");
    await expect.poll(() => dialog.textContent()).toContain("Basic Checklist (basic-checklist)");
    await expect.poll(() => skills.inputValue()).toBe("basic-checklist");
    await page.screenshot({
      animations: "disabled",
      path: path.join(proofDir, "04-workspace-basic-fhd.png"),
    });
    await sources.selectOption("assigned_vm");
    await expect.poll(() => dialog.textContent()).toContain("VM Release (vm-release)");
    await expect.poll(() => skills.inputValue()).toBe("vm-release");

    const layout = await dialog.evaluate((element) => ({
      background: globalThis.getComputedStyle(element).backgroundColor,
      viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
      width: element.getBoundingClientRect().width,
    }));
    expect(layout.viewport).toEqual({ width: 1920, height: 1080 });
    expect(layout.background).not.toMatch(/rgba\(0,\s*0,\s*0,\s*0\)|transparent/);
    expect(layout.width).toBeGreaterThan(400);
    await page.screenshot({
      animations: "disabled",
      path: path.join(proofDir, "05-workspace-vm-fhd.png"),
    });

    await dialog.getByRole("button", { name: "Scan and publish skill" }).click();
    await expect
      .poll(() =>
        page.getByText("Published engineering/vm-release@2.3.0 from My VM workspace.").isVisible(),
      )
      .toBe(true);
    expect(published).toEqual([
      {
        skill: "vm-release",
        source: "assigned_vm",
        namespace: "engineering",
        version: "2.3.0",
        visibility: "NAMESPACE_ONLY",
      },
    ]);
    expect(executionMutations).toEqual([]);
    expect(await gateway.getRequests("platformclaw-execution.changeTarget")).toEqual([]);
    await page.screenshot({ path: path.join(proofDir, "06-published-fhd.png") });
  });

  it("renders the assigned-VM workspace publishing flow in Korean", async () => {
    const { page } = await newPage("ko-KR");
    await page.goto(`${server.baseUrl}platformclaw/app/skills/hub`);
    const publish = page.getByRole("button", { name: "작업 공간 스킬 게시" });
    await expect.poll(() => publish.isVisible()).toBe(true);
    await publish.click();
    const dialog = page.locator(".skill-hub-workspace-publish");
    await expect.poll(() => dialog.textContent()).toContain("내 VM 작업 공간");
    await expect.poll(() => dialog.textContent()).toContain("검사 후 스킬 게시");
    await expect.poll(() => dialog.locator("select").nth(1).inputValue()).toBe("vm-release");
    await page.screenshot({
      animations: "disabled",
      path: path.join(proofDir, "07-workspace-vm-ko-fhd.png"),
    });
  });
});
