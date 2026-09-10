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

  it("shows a ZIP rejection in the upload dialog without losing the selected archive", async () => {
    const { page } = await newPage("en-US");
    let finish!: () => void;
    let attempts = 0;
    await page.route("**/platformclaw/api/skill-hub/publish/upload?**", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      await route.fulfill({
        status: 503,
        json: { error: "Archive scanner is unavailable. Try again." },
      });
    });
    await page.goto(`${server.baseUrl}platformclaw/app/skills/hub`);
    await page.getByRole("button", { name: "Upload ZIP", exact: true }).click();
    const dialog = page.locator(".skill-hub-upload");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "demo.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("fixture archive"),
    });
    await dialog.locator(".skill-hub-upload__fields input").first().fill("demo");
    await dialog.getByRole("button", { name: "Scan and publish ZIP" }).click();
    await expect
      .poll(() => dialog.locator("input:enabled, select:enabled, button:enabled").count())
      .toBe(0);
    try {
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 5);
      expect(await dialog.isVisible()).toBe(true);
    } finally {
      finish();
    }
    await expect.poll(() => dialog.getByRole("alert").isVisible()).toBe(true);
    expect(await dialog.getByRole("alert").textContent()).toContain(
      "Archive scanner is unavailable",
    );
    expect(await dialog.textContent()).toContain("demo.zip");
    expect(await dialog.locator(".skill-hub-upload__fields input").first().inputValue()).toBe(
      "demo",
    );
    expect(await dialog.getByRole("button", { name: "Scan and publish ZIP" }).isEnabled()).toBe(
      true,
    );
    expect(await dialog.locator('input[type="file"]').isEnabled()).toBe(true);
    await dialog.getByRole("button", { name: "Scan and publish ZIP" }).click();
    await expect.poll(() => attempts).toBe(2);
    await page.screenshot({ path: path.join(proofDir, "08-upload-error-visible.png") });
  });

  it("keeps inbox load and mark-read failures visible and recovers on retry", async () => {
    const { page } = await newPage("en-US");
    let loadFails = true;
    let readFails = true;
    await page.route("**/platformclaw/api/skill-hub/notifications**", (route) => {
      const marking = new URL(route.request().url()).pathname.endsWith("/read");
      return route.fulfill(
        (marking ? readFails : loadFails)
          ? {
              status: 503,
              json: { error: marking ? "Mark read unavailable" : "Inbox unavailable" },
            }
          : { json: { items: [], unreadCount: 0, ok: true, updated: 0 } },
      );
    });
    await page.goto(`${server.baseUrl}platformclaw/app/skills/hub`);
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    const dialog = page.locator("openclaw-modal-dialog");
    await expect.poll(() => dialog.getByRole("alert").textContent()).toContain("Inbox unavailable");
    await page.screenshot({ path: path.join(proofDir, "11-inbox-load-error.png") });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    loadFails = false;
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
    await expect
      .poll(() => dialog.getByRole("alert").textContent())
      .toContain("Mark read unavailable");
    readFails = false;
    await dialog.getByRole("button", { name: "Mark all read", exact: true }).click();
    await expect.poll(() => dialog.getByRole("alert").count()).toBe(0);
    await page.keyboard.press("Escape");
    await expect.poll(() => dialog.count()).toBe(0);
  });

  it("shows admin load and save errors inside its dialog and protects a pending draft", async () => {
    const { page } = await newPage("en-US");
    await page.route("**/platformclaw/api/skill-hub/config", (route) =>
      route.fulfill({ json: { namespaces: ["engineering"], maxPackageBytes: 1024, admin: true } }),
    );
    let loadFails = true;
    let finish!: () => void;
    await page.route("**/platformclaw/api/skill-hub/admin/namespaces**", async (route) => {
      if (route.request().method() !== "GET") {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await route.fulfill({ status: 503, json: { error: "Binding save unavailable" } });
      } else {
        await route.fulfill(
          loadFails
            ? { status: 503, json: { error: "Namespace list unavailable" } }
            : { json: { bindings: [], scopes: [] } },
        );
      }
    });
    await page.goto(`${server.baseUrl}platformclaw/app/skills/hub`);
    await page.getByRole("button", { name: "Skill Hub admin", exact: true }).click();
    const dialog = page.locator(".skill-hub-admin");
    await expect
      .poll(() => dialog.getByRole("alert").textContent())
      .toContain("Namespace list unavailable");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    loadFails = false;
    await page.getByRole("button", { name: "Skill Hub admin", exact: true }).click();
    await dialog.locator(".skill-hub-admin__form input").nth(0).fill("engineering");
    await dialog.locator(".skill-hub-admin__form input").nth(1).fill("Fixture UI review");
    await dialog.locator(".skill-hub-admin__form button").click();
    await expect
      .poll(() => dialog.getByRole("button", { name: "Close", exact: true }).isDisabled())
      .toBe(true);
    try {
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 5);
      expect(await dialog.isVisible()).toBe(true);
      expect(await dialog.locator("input").nth(0).isDisabled()).toBe(true);
    } finally {
      finish?.();
    }
    await expect
      .poll(() => dialog.getByRole("alert").textContent())
      .toContain("Binding save unavailable");
    expect(await dialog.locator("input").nth(0).inputValue()).toBe("engineering");
    await page.screenshot({ path: path.join(proofDir, "12-admin-save-error.png") });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => dialog.count()).toBe(0);
  });

  it("keeps a pending workspace publish visible through Escape and backdrop clicks", async () => {
    const { page } = await newPage("en-US");
    let publishAttempts = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await page.route("**/platformclaw/api/skill-hub/publish", async (route) => {
      publishAttempts += 1;
      await pending;
      await route.fulfill({
        status: 503,
        json: { error: "Publish service is unavailable. Try again." },
      });
    });
    await page.goto(`${server.baseUrl}platformclaw/app/skills/hub`);
    await page.getByRole("button", { name: "Publish workspace skill", exact: true }).click();
    const dialog = page.locator(".skill-hub-workspace-publish");
    await dialog.getByRole("button", { name: "Scan and publish skill" }).click();
    await expect
      .poll(() => dialog.getByRole("button", { name: "Close", exact: true }).isDisabled())
      .toBe(true);
    try {
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 5);
      expect(await dialog.isVisible()).toBe(true);
    } finally {
      finish();
    }
    await expect.poll(() => dialog.getByRole("alert").isVisible()).toBe(true);
    expect(await dialog.getByRole("alert").textContent()).toContain(
      "Publish service is unavailable",
    );
    await page.screenshot({
      path: path.join(proofDir, "09-publish-error-after-dismiss-attempt.png"),
    });
    await dialog.getByRole("button", { name: "Scan and publish skill" }).click();
    await expect.poll(() => publishAttempts).toBe(2);
    await expect.poll(() => dialog.getByRole("alert").isVisible()).toBe(true);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => dialog.count()).toBe(0);
  });

  it("keeps a pending version replacement visible through Escape and backdrop clicks", async () => {
    const { page } = await newPage("en-US");
    await page.route("**/platformclaw/api/skill-hub/search?**", (route) =>
      route.fulfill({
        json: {
          total: 1,
          items: [
            {
              namespace: "engineering",
              slug: "demo",
              latestVersion: "2.0.0",
              summary: "Demo skill",
            },
          ],
        },
      }),
    );
    await page.route("**/platformclaw/api/skill-hub/skills/engineering/demo", (route) =>
      route.fulfill({
        json: {
          skill: {
            namespace: "engineering",
            slug: "demo",
            displayName: "Demo",
            summary: "Demo skill",
            visibility: "PUBLIC",
            status: "PUBLISHED",
          },
          versions: [{ version: "2.0.0", status: "PUBLISHED", downloadAvailable: true }],
        },
      }),
    );
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let installs = 0;
    await page.route("**/platformclaw/api/skill-hub/install", async (route) => {
      installs += 1;
      if (installs === 1) {
        await route.fulfill({
          status: 409,
          json: {
            error: "Confirm replacement",
            details: {
              code: "existing-skill-replacement-required",
              currentVersion: "1.0.0",
              currentRevision: "fixture-revision",
              requestedVersion: "2.0.0",
              direction: "upgrade",
            },
          },
        });
      } else {
        await pending;
        await route.fulfill({
          json: { ok: true, slug: "demo", version: "2.0.0", target: "platform_server" },
        });
      }
    });
    await page.goto(`${server.baseUrl}platformclaw/app/skills/hub`);
    await page.locator(".skill-hub-card").click();
    await page.getByRole("button", { name: "Install to Basic Workspace", exact: true }).click();
    const dialog = page.locator(".skill-hub-version-change");
    await dialog.getByRole("button", { name: "Replace installed version" }).click();
    await expect.poll(() => installs).toBe(2);
    try {
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 5);
      expect(await dialog.isVisible()).toBe(true);
      await page.screenshot({
        path: path.join(proofDir, "10-version-pending-after-dismiss-attempt.png"),
      });
    } finally {
      finish();
    }
    await expect.poll(() => dialog.count()).toBe(0);
    expect(await page.locator(".skill-hub-detail").textContent()).toContain("Installed demo@2.0.0");
  });
});
