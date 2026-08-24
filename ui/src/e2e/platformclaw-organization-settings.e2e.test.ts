import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
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

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeE2e =
  canRunPlaywrightChromium(executablePath) ||
  process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "organization-settings");
let browser: Browser;
let server: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();

describeE2e("PlatformClaw Organization settings", () => {
  beforeAll(async () => {
    if (capture) {
      await mkdir(proofDir, { recursive: true });
    }
    browser = await chromium.launch({ executablePath });
    server = await startControlUiE2eServer();
  });
  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close()));
    contexts.clear();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders opt-in tabs without narrow-screen overflow", async () => {
    let memberRole: "member" | "leader" = "member";
    let contextReads = 0;
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
      ...(capture ? { recordVideo: { dir: proofDir, size: { width: 390, height: 844 } } } : {}),
    });
    contexts.add(context);
    const page = await context.newPage();
    const response = await page.request.get(server.baseUrl);
    const source = await response.text();
    await page.route("**/platformclaw/app/**", (route) =>
      route.fulfill({
        body: source.replace(
          "</head>",
          `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'></head>`,
        ),
        headers: response.headers(),
        status: response.status(),
      }),
    );
    await page.route("**/platformclaw/api/auth/session", (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          user: {
            accountId: "person.one",
            displayName: "Person One",
            department: "Platform Lab",
            globalRole: "admin",
          },
          session: { idleExpiresAt: Date.now() + 60_000, absoluteExpiresAt: Date.now() + 120_000 },
        },
        status: 200,
      }),
    );
    await page.route("**/platformclaw/api/organization/context", (route) => {
      contextReads += 1;
      return route.fulfill({
        json: {
          actor: { id: "user-1", displayName: "Person One", isAdministrator: true },
          directMemberships: [{ scopeId: "group-1", role: "member" }],
          directMembershipsHasMore: false,
          directScopeLineages: [
            {
              scopeId: "group-1",
              lineage: [
                { id: "team-1", kind: "team", name: "Platform", status: "active" },
                {
                  id: "group-1",
                  kind: "group",
                  name: "Runtime",
                  parentScopeId: "team-1",
                  status: "active",
                },
              ],
            },
          ],
          effectiveScopes: [
            {
              scope: {
                id: "group-1",
                kind: "group",
                name: "Runtime",
                parentScopeId: "team-1",
                status: "active",
              },
              source: "direct",
              directRole: "member",
            },
          ],
          effectiveScopesHasMore: false,
          primaryScope: {
            id: "group-1",
            kind: "group",
            name: "Runtime",
            parentScopeId: "team-1",
            status: "active",
          },
          primaryScopeLineage: [
            { id: "team-1", kind: "team", name: "Platform", status: "active" },
            {
              id: "group-1",
              kind: "group",
              name: "Runtime",
              parentScopeId: "team-1",
              status: "active",
            },
          ],
        },
        status: 200,
      });
    });
    await page.route("**/platformclaw/api/organization/scopes?**", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: "group-1",
              kind: "group",
              name: "Runtime",
              parentScopeId: "team-1",
              status: "active",
              revision: 10,
              lineage: [
                { id: "team-1", kind: "team", name: "Platform", status: "active" },
                {
                  id: "group-1",
                  kind: "group",
                  name: "Runtime",
                  parentScopeId: "team-1",
                  status: "active",
                },
              ],
              capabilities: {
                canManageMembers: true,
                canManageStructure: true,
                canManageLeaders: true,
              },
              requestEligible: false,
            },
          ],
          hasMore: false,
        },
        status: 200,
      }),
    );
    await page.route("**/platformclaw/api/organization/management/scopes/group-1?**", (route) =>
      route.fulfill({
        json: {
          scope: {
            id: "group-1",
            kind: "group",
            name: "Runtime",
            parentScopeId: "team-1",
            status: "active",
            revision: 10,
          },
          members: [
            {
              user: {
                id: "user-2",
                accountId: "member.one",
                displayName: "Member One",
                status: "active",
              },
              role: memberRole,
            },
          ],
        },
        status: 200,
      }),
    );
    await page.route("**/platformclaw/api/organization/memberships", async (route) => {
      const body = route.request().postDataJSON() as {
        role: "member" | "leader";
        expectedRole: "member" | "leader" | null;
      };
      expect(body.expectedRole).toBe("member");
      memberRole = body.role;
      await route.fulfill({ json: {}, status: 200 });
    });
    await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: "person_one",
      featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
      sessionKey: "agent:person_one:main",
    });

    await page.goto(`${server.baseUrl}platformclaw/app/settings/organization`);
    await expect.poll(() => page.getByText("My organization").isVisible()).toBe(true);
    await page.getByRole("tab", { name: "Management" }).click();
    await expect.poll(() => page.getByText("Organization management").isVisible()).toBe(true);
    await expect.poll(() => page.getByText("Member One").isVisible()).toBe(true);
    await expect.poll(() => page.locator('form[aria-label="Create Team"]').isVisible()).toBe(true);
    const role = page.getByRole("combobox", { name: "Membership role" });
    await role.selectOption("leader");
    await expect.poll(() => page.getByText("Confirm role change").isVisible()).toBe(true);
    await page.getByRole("textbox", { name: "Reason" }).fill("promote team lead");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect.poll(() => page.getByText("Organization updated.").isVisible()).toBe(true);
    await expect.poll(() => role.inputValue()).toBe("leader");
    expect(contextReads).toBeGreaterThan(1);
    expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (capture) {
      await page.screenshot({ fullPage: true, path: path.join(proofDir, "management-narrow.png") });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.locator("body").evaluate((body) => body.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (capture) {
      await page.screenshot({
        fullPage: true,
        path: path.join(proofDir, "management-desktop.png"),
      });
    }
  });
});
