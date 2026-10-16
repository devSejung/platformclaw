import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BrowserAuthService,
  hashBrowserSessionToken,
} from "../../../packages/platformclaw-control-plane/src/browser-auth-service.ts";
import { handlePlatformClawDashboardRequest } from "../../../packages/platformclaw-control-plane/src/browser-dashboard-http.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { DashboardService } from "../../../packages/platformclaw-control-plane/src/dashboard-service.ts";
import { SqliteControlPlaneStore } from "../../../packages/platformclaw-control-plane/src/sqlite-store.ts";
import { createEmptyCostUsageTotals } from "../../../src/infra/session-cost-usage-totals.ts";
import type { SessionUsageActivity } from "../../../src/shared/usage-activity.ts";
import { UsageActivityAccumulator } from "../../../src/shared/usage-activity.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "platformclaw-dashboard");
let browser: Browser;
let server: ControlUiE2eServer;
let api: Server;
let apiOrigin: string;
let store: SqliteControlPlaneStore;
let directory: string;
const contexts = new Set<BrowserContext>();
const members: Array<{ accountId: string; agentId: string }> = [];

function sampleActivity(
  startDate: string,
  endDate: string,
  timeZone: string,
): SessionUsageActivity[] {
  return members.slice(0, 7).map((member, index) => {
    const daily: SessionUsageActivity["daily"] = [];
    const quarters: Array<{ date: string; quarterIndex: number; userMessages: number }> = [];
    for (
      let ms = Date.parse(`${startDate}T00:00:00Z`);
      ms <= Date.parse(`${endDate}T00:00:00Z`);
      ms += 86_400_000
    ) {
      const weekday = new Date(ms).getUTCDay();
      const count =
        weekday === 0 || weekday === 6 ? index % 3 : 12 + ((ms / 86_400_000 + index * 13) % 43);
      const date = new Date(ms).toISOString().slice(0, 10);
      daily.push({ date, userMessages: count });
      const early = Math.floor(count / 3);
      // 01:00 and 06:00 UTC are 10:00 and 15:00 in the default Seoul display.
      quarters.push(
        { date, quarterIndex: 4 + (index % 3), userMessages: early },
        { date, quarterIndex: 24 + (index % 3), userMessages: count - early },
      );
    }
    const requests = daily.reduce((sum, day) => sum + day.userMessages, 0);
    const messages = (count: number) => ({
      user: count,
      assistant: count,
      total: count * 2,
      toolCalls: count * 3,
      toolResults: count * 3,
      errors: 0,
    });
    const accumulator = new UsageActivityAccumulator({ mode: "time-zone", timeZone });
    accumulator.add(member.agentId, index % 2 ? "knox" : "webchat", "direct", {
      ...createEmptyCostUsageTotals(),
      messageCounts: messages(requests),
      toolUsage: {
        totalCalls: requests * 3,
        uniqueTools: 1,
        tools: [{ name: "test-tool", count: requests * 3 }],
      },
      totalTokens: requests * 3200,
      totalCost: requests * 0.007,
      missingCostEntries: 0,
      dailyMessageCounts: daily.map((day) =>
        Object.assign({ date: day.date }, messages(day.userMessages)),
      ),
      utcQuarterHourMessageCounts: quarters.map((quarter) =>
        Object.assign(
          { date: quarter.date, quarterIndex: quarter.quarterIndex },
          messages(quarter.userMessages),
        ),
      ),
      lastActivity: Date.parse(`${endDate}T06:00:00Z`),
    });
    return accumulator.entries()[0]!;
  });
}

async function preparePage(locale = "ko", width = 1440) {
  const context = await browser.newContext({
    locale: locale === "ko" ? "ko-KR" : "en-US",
    viewport: { width, height: 1080 },
    serviceWorkers: "block",
  });
  contexts.add(context);
  await context.addCookies([
    { name: "platformclaw_session", value: "dashboard-member", url: server.baseUrl },
  ]);
  const page = await context.newPage();
  await page.addInitScript(
    ({ selectedLocale }) => {
      const gatewayUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/platformclaw/gateway`;
      if (!localStorage.getItem("openclaw.control.settings.v1")) {
        localStorage.setItem(
          "openclaw.control.settings.v1",
          JSON.stringify({
            locale: selectedLocale,
            theme: "platformclaw",
            themeMode: "light",
            gatewayUrl,
          }),
        );
        localStorage.setItem(
          `openclaw.control.settings.v1:${gatewayUrl}`,
          JSON.stringify({
            locale: selectedLocale,
            theme: "platformclaw",
            themeMode: "light",
            gatewayUrl,
          }),
        );
      }
    },
    { selectedLocale: locale },
  );
  const response = await page.request.get(server.baseUrl);
  const source = await response.text();
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      body: source.replace(
        "</head>",
        `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'></head>`,
      ),
      headers: response.headers(),
      status: 200,
    }),
  );
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: members[1]!.accountId,
          displayName: "샘플 사용자 02",
          department: "플랫폼팀",
          globalRole: "member",
        },
        agent: { agentId: members[1]!.agentId, state: "active" },
        session: {
          idleExpiresAt: Date.now() + 3_600_000,
          absoluteExpiresAt: Date.now() + 7_200_000,
        },
      },
    }),
  );
  await page.route("**/platformclaw/api/organization/context", (route) =>
    route.fulfill({
      json: {
        actor: { id: "demo", isAdministrator: false },
        directMemberships: [],
        effectiveScopes: [],
        directScopeLineages: [],
        primaryScope: null,
        primaryScopeLineage: [],
        recentJoinRequestDetails: [],
        isUnaffiliated: false,
        hasPendingJoinRequest: false,
        canReviewJoinRequests: false,
        canManageOrganization: false,
        canViewOrganizationAudit: false,
        joinPromptEligible: false,
      },
    }),
  );
  // The dashboard uses the actual authenticated HTTP service and SQLite roster;
  // only the upstream numeric source and unrelated Gateway UI traffic are fixtures.
  await page.route("**/platformclaw/api/dashboard?**", async (route) => {
    const url = new URL(route.request().url());
    const result = await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}` });
    await route.fulfill({ response: result });
  });
  await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: members[0]!.agentId,
    sessionKey: `agent:${members[0]!.agentId}:main`,
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    operatorScopes: ["operator.read", "operator.write"],
    methodResponses: {
      "sessions.usage": {
        updatedAt: Date.now(),
        sessions: [],
        totals: createEmptyCostUsageTotals(),
        aggregates: {
          messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
          tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
          byModel: [],
          byProvider: [],
          byAgent: [],
          byChannel: [],
          daily: [],
        },
      },
      "usage.cost": {
        updatedAt: Date.now(),
        days: 1,
        daily: [],
        totals: createEmptyCostUsageTotals(),
      },
      "usage.status": { updatedAt: Date.now(), providers: [] },
    },
  });
  return { page, context };
}

describe("PlatformClaw member dashboard, production bundle and authenticated API", () => {
  beforeAll(async () => {
    await mkdir(proofDir, { recursive: true });
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    server = await startControlUiE2eServer();
    directory = mkdtempSync(path.join(tmpdir(), "platformclaw-dashboard-e2e-"));
    store = new SqliteControlPlaneStore({
      databasePath: path.join(directory, "control.sqlite"),
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["demo.user.01"],
    });
    const users = [];
    for (let index = 1; index <= 8; index++) {
      const accountId = `demo.user.${String(index).padStart(2, "0")}`;
      const { user } = await store.upsertPrincipal(
        {
          provider: "ldap",
          subject: accountId,
          accountId,
          employeeId: accountId,
          displayName: `샘플 사용자 ${String(index).padStart(2, "0")}`,
        },
        Date.now() - 400 * 86_400_000,
      );
      const { binding } = await store.reservePersonalAgent(user.id, Date.now() - 399 * 86_400_000);
      await store.transitionAgent({
        bindingId: binding.id,
        state: "active",
        changedAt: Date.now(),
      });
      members.push({ accountId, agentId: binding.agentId });
      users.push(user);
    }
    const admin = users[0]!;
    for (const [teamIndex, name] of ["제품팀", "플랫폼팀"].entries()) {
      const scope = await store.createManagedScope({
        actorUserId: admin.id,
        kind: "team",
        name,
        createdAt: Date.now() - 1000,
      });
      for (const [index, user] of users.entries()) {
        if (index % 2 !== teamIndex) {
          continue;
        }
        await store.setManagedScopeMembership({
          actorUserId: admin.id,
          scopeId: scope.id,
          userId: user.id,
          role: "member",
          reason: "Synthetic UI fixture",
          changedAt: Date.now(),
        });
        await store.setUserPrimaryScope({
          actorUserId: admin.id,
          userId: user.id,
          scopeId: scope.id,
          changedAt: Date.now(),
        });
      }
    }
    // The HTTP caller is a regular member even though a separate account seeded organizations.
    await store.createBrowserSession({
      userId: users[1]!.id,
      tokenHash: hashBrowserSessionToken("dashboard-member"),
      createdAt: Date.now(),
    });
    const authService = new BrowserAuthService({
      store,
      authenticator: {
        authenticatePassword: async () => ({ status: "rejected", message: "Fixture" }),
      },
      provisioner: { provisionOrRefresh: async () => {} },
    });
    const service = new DashboardService({
      store,
      gateway: {
        request: async (_method, params) => {
          const { startDate, endDate, agentId, timeZone } = params as {
            startDate: string;
            endDate: string;
            agentId: string;
            timeZone: string;
          };
          return {
            updatedAt: Date.now(),
            cacheStatus: { status: "fresh" },
            aggregates: {
              activity: sampleActivity(startDate, endDate, timeZone).filter(
                (entry) => entry.agentId === agentId,
              ),
            },
          };
        },
      },
    });
    api = createServer((req, res) => {
      void handlePlatformClawDashboardRequest(req, res, { authService, service });
    });
    await new Promise<void>((resolve) => {
      api.listen(0, "127.0.0.1", resolve);
    });
    const address = api.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener");
    }
    apiOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close()));
    contexts.clear();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (api) {
      await new Promise<void>((resolve) => {
        api.close(() => resolve());
      });
    }
    store?.close();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lets a member inspect accounts, filters and hours and download all matching Excel rows", async () => {
    const { page } = await preparePage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.baseUrl}platformclaw/app/settings/usage`);
    await page.locator(".pc-dashboard-table tbody tr").first().waitFor();
    expect(await page.locator(".pc-dashboard-table tbody tr").count()).toBe(8);
    expect(
      await page.locator(".settings-sidebar__item-label", { hasText: "대시보드" }).count(),
    ).toBe(1);
    await page.screenshot({ path: path.join(proofDir, "dashboard-light-ko.png"), fullPage: true });
    await page.locator(".pc-dashboard-heatmap").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(proofDir, "dashboard-details-ko.png"),
      fullPage: true,
    });
    await page.locator(".pc-dashboard-heatcell").nth(10).click();
    expect(await page.locator(".pc-dashboard-heatcell[aria-pressed=true]").count()).toBe(1);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "엑셀 다운로드", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^platformclaw-dashboard-.*\.xlsx$/u);
    await download.saveAs(path.join(proofDir, "dashboard-report.xlsx"));
    await page.locator(".pc-dashboard-account").first().click();
    await expect.poll(() => page.locator(".pc-dashboard-table tbody tr").count()).toBe(1);
    await page.screenshot({
      path: path.join(proofDir, "dashboard-account-ko.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "전체 계정 보기" }).click();
    await expect.poll(() => page.locator(".pc-dashboard-table tbody tr").count()).toBe(8);
    await page.getByLabel("조직", { exact: true }).selectOption({ label: "제품팀" });
    await page.getByRole("button", { name: "필터 적용" }).click();
    await expect.poll(() => page.locator(".pc-dashboard-table tbody tr").count()).toBe(4);
    await page.getByRole("button", { name: "오늘", exact: true }).click();
    await expect.poll(() => page.locator(".pc-dashboard").getAttribute("aria-busy")).toBe("false");
    expect(errors).toEqual([]);
    await page.getByRole("link", { name: "내 토큰·비용", exact: true }).click();
    await page.locator("openclaw-usage-page .content-header").waitFor();
    expect(errors).toEqual([]);
    expect(new URL(page.url()).searchParams.get("view")).toBe("personal");
    await page.getByRole("link", { name: "플랫폼 활용 현황", exact: true }).click();
    await page.locator(".pc-dashboard-table tbody tr").first().waitFor();
  });

  it("renders the dashboard in every built-in theme, including dark mode", async () => {
    const { page } = await preparePage("en");
    for (const [name, expected] of [
      ["PlatformClaw", "platformclaw"],
      ["Claw", "claw"],
      ["OpenKnot", "knot"],
      ["Dash", "dash"],
    ]) {
      await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
      const themeButton = page.locator(
        `#settings-appearance-theme .settings-theme-card--${expected}`,
      );
      await themeButton.waitFor();
      await themeButton.click();
      const modeGroup = page
        .locator(".settings-row")
        .filter({ has: page.locator(".settings-row__title", { hasText: "Color mode" }) })
        .first()
        .locator("wa-radio-group");
      await modeGroup.locator('wa-radio[value="light"]').click();
      await page.goto(`${server.baseUrl}platformclaw/app/settings/usage`);
      await page.locator(".pc-dashboard-table tbody tr").first().waitFor();
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
      await expect
        .poll(() => page.locator("html").getAttribute("data-theme"))
        .toBe(
          expected === "platformclaw"
            ? "platformclaw-light"
            : expected === "claw"
              ? "light"
              : expected === "knot"
                ? "openknot-light"
                : "dash-light",
        );
      expect(await page.locator(".pc-dashboard-chart").isVisible()).toBe(true);
      await page.screenshot({
        path: path.join(proofDir, `dashboard-${expected}-light.png`),
        fullPage: true,
      });
      if (name === "PlatformClaw") {
        // The appearance page owns theme preferences; change through its real control.
        await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
        const group = page
          .locator(".settings-row")
          .filter({ has: page.locator(".settings-row__title", { hasText: "Color mode" }) })
          .first()
          .locator("wa-radio-group");
        await group.locator('wa-radio[value="dark"]').click();
        await page.goto(`${server.baseUrl}platformclaw/app/settings/usage`);
        await page.locator(".pc-dashboard-table tbody tr").first().waitFor();
        await expect
          .poll(() => page.locator("html").getAttribute("data-theme"))
          .toBe("platformclaw");
        await page.screenshot({
          path: path.join(proofDir, "dashboard-dark-en.png"),
          fullPage: true,
        });
      }
    }
  });

  it("keeps filters and charts inside the mobile viewport and exposes failures with retry", async () => {
    const { page } = await preparePage("ko", 390);
    await page.goto(`${server.baseUrl}platformclaw/app/settings/usage`);
    await page.locator(".pc-dashboard-table tbody tr").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: path.join(proofDir, "dashboard-mobile-ko.png"), fullPage: true });
    await page.route("**/platformclaw/api/dashboard?**", (route) =>
      route.fulfill({ status: 503, json: { error: "Unavailable" } }),
    );
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect.poll(() => page.getByRole("alert").isVisible()).toBe(true);
  });
});
