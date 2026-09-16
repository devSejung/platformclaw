import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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

const totals = {
  input: 1_200_000,
  output: 300_000,
  cacheRead: 2_400_000,
  cacheWrite: 100_000,
  totalTokens: 4_000_000,
  totalCost: 32,
  inputCost: 12,
  outputCost: 12,
  cacheReadCost: 6,
  cacheWriteCost: 2,
  missingCostEntries: 0,
};

function dayOffset(offset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dailyEntry(offset: number, totalCost: number, totalTokens: number) {
  return {
    ...totals,
    date: dayOffset(offset),
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost,
    inputCost: totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };
}

const daily = [
  dailyEntry(-89, 5, 500_000),
  dailyEntry(-29, 7, 700_000),
  dailyEntry(-6, 9, 900_000),
  dailyEntry(0, 11, 1_100_000),
];

const usageLifecycleTraceKey = "__openclawUsageLifecycleTrace";

async function installUsageLifecycleTrace(page: Page) {
  await page.evaluate((traceKey) => {
    type GatewayChange = {
      becameConnected: boolean;
      clientChanged: boolean;
      connectionChanged: boolean;
      initial: boolean;
      snapshot: { phase: string };
      sourceChanged: boolean;
    };
    type UsageGateway = {
      currentClient?: object | null;
      currentSnapshot?: { phase?: string } | null;
      options?: {
        invalidateRequests?: (change: GatewayChange) => void;
        onSnapshot?: (change: GatewayChange) => void;
      };
    };
    type UsagePage = HTMLElement & {
      disconnectedCallback?: (...args: unknown[]) => unknown;
      gateway?: UsageGateway;
      routeData?: { result?: { totals?: unknown } | null } | undefined;
      routeDataEnabled?: boolean;
      routeDataInitialized?: boolean;
      usageLoading?: boolean;
      usageResult?: { totals?: unknown } | null;
      usageTaskActiveClient?: object | null;
      willUpdate?: (...args: unknown[]) => unknown;
    };

    const usagePage = document.querySelector("openclaw-usage-page") as UsagePage | null;
    const gateway = usagePage?.gateway;
    const options = gateway?.options;
    const parent = usagePage?.parentElement;
    if (!usagePage || !gateway || !options || !parent) {
      throw new Error("Usage lifecycle trace could not access the Usage page controller");
    }
    if (
      !options.onSnapshot ||
      !options.invalidateRequests ||
      !usagePage.willUpdate ||
      !usagePage.disconnectedCallback
    ) {
      throw new Error("Usage lifecycle trace could not access lifecycle callbacks");
    }

    const ids = new WeakMap<object, number>();
    let nextId = 1;
    const identify = (value: object | null | undefined) => {
      if (!value) return null;
      const existing = ids.get(value);
      if (existing !== undefined) return existing;
      const id = nextId++;
      ids.set(value, id);
      return id;
    };
    const snapshot = () => ({
      activeClient: identify(usagePage.usageTaskActiveClient),
      gatewayClient: identify(gateway.currentClient),
      gatewayPhase: gateway.currentSnapshot?.phase ?? null,
      hasResult: Boolean(usagePage.usageResult),
      hasTotals: Boolean(usagePage.usageResult?.totals),
      hostConnected: usagePage.isConnected,
      hostId: identify(usagePage),
      inputConnected: Boolean(usagePage.querySelector(".usage-query-input")?.isConnected),
      loading: Boolean(usagePage.usageLoading),
      routeDataEnabled: Boolean(usagePage.routeDataEnabled),
      routeDataInitialized: Boolean(usagePage.routeDataInitialized),
      routeResult: Boolean(usagePage.routeData?.result),
      routeTotals: Boolean(usagePage.routeData?.result?.totals),
    });
    const entries: Array<Record<string, unknown>> = [];
    const record = (event: string, extra: Record<string, unknown> = {}) => {
      entries.push({ atMs: Math.round(performance.now()), event, ...snapshot(), ...extra });
      if (entries.length > 20) entries.splice(0, entries.length - 20);
    };

    const originalSnapshot = options.onSnapshot!;
    const originalInvalidate = options.invalidateRequests!;
    const originalWillUpdate = usagePage.willUpdate!;
    const originalDisconnected = usagePage.disconnectedCallback!;
    const ownWillUpdate = Object.getOwnPropertyDescriptor(usagePage, "willUpdate");
    const ownDisconnected = Object.getOwnPropertyDescriptor(usagePage, "disconnectedCallback");
    const onSnapshot = function (this: unknown, change: GatewayChange) {
      record("gateway-snapshot", {
        becameConnected: change.becameConnected,
        clientChanged: change.clientChanged,
        connectionChanged: change.connectionChanged,
        initial: change.initial,
        phase: change.snapshot.phase,
        sourceChanged: change.sourceChanged,
      });
      return originalSnapshot.call(this, change);
    };
    const invalidateRequests = function (this: unknown, change: GatewayChange) {
      record("gateway-invalidate", {
        connectionChanged: change.connectionChanged,
        phase: change.snapshot.phase,
      });
      return originalInvalidate.call(this, change);
    };
    const willUpdate = function (this: unknown, ...args: unknown[]) {
      const changed = args[0] instanceof Map ? Array.from(args[0].keys()).map(String) : [];
      record("will-update-before", { changed });
      const result = originalWillUpdate.apply(this, args);
      record("will-update-after", { changed });
      return result;
    };
    const disconnected = function (this: unknown, ...args: unknown[]) {
      record("usage-disconnected");
      return originalDisconnected.apply(this, args);
    };
    const observer = new MutationObserver(() => {
      const state = snapshot();
      if (!state.hostConnected || !state.inputConnected) record("parent-mutation");
    });
    options.onSnapshot = onSnapshot;
    options.invalidateRequests = invalidateRequests;
    Object.defineProperty(usagePage, "willUpdate", { configurable: true, value: willUpdate });
    Object.defineProperty(usagePage, "disconnectedCallback", {
      configurable: true,
      value: disconnected,
    });
    observer.observe(parent, { childList: true, subtree: true });
    (globalThis as typeof globalThis & Record<string, unknown>)[traceKey] = {
      dispose: () => {
        observer.disconnect();
        if (options.onSnapshot === onSnapshot) options.onSnapshot = originalSnapshot;
        if (options.invalidateRequests === invalidateRequests)
          options.invalidateRequests = originalInvalidate;
        if (ownWillUpdate) Object.defineProperty(usagePage, "willUpdate", ownWillUpdate);
        else delete usagePage.willUpdate;
        if (ownDisconnected)
          Object.defineProperty(usagePage, "disconnectedCallback", ownDisconnected);
        else delete usagePage.disconnectedCallback;
        delete (globalThis as typeof globalThis & Record<string, unknown>)[traceKey];
      },
      entries,
      snapshot,
    };
  }, usageLifecycleTraceKey);
}

async function disposeUsageLifecycleTrace(page: Page, includeTrace = false) {
  return await page.evaluate(
    ({ traceKey, include }) => {
      const probe = (
        globalThis as typeof globalThis & {
          [key: string]:
            | { dispose?: () => void; entries?: unknown[]; snapshot?: () => unknown }
            | undefined;
        }
      )[traceKey];
      const trace = include
        ? { entries: probe?.entries ?? [], failure: probe?.snapshot?.() ?? null }
        : null;
      probe?.dispose?.();
      return trace;
    },
    { include: includeTrace, traceKey: usageLifecycleTraceKey },
  );
}
describeControlUiE2e("Control UI usage cost analysis mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps pending sessions visible when their UTC activity day is selected", async () => {
    const selectedDay = "2026-05-14";
    const updatedAt = Date.parse("2026-05-14T00:30:00.000Z");
    const pendingSessionKey = "agent:main:pending-cache";
    const cachedSessionKey = "agent:main:cached-usage";
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      timezoneId: "America/Los_Angeles",
      viewport: { height: 1_000, width: 1_440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.usage": {
          updatedAt,
          startDate: selectedDay,
          endDate: selectedDay,
          sessions: [
            {
              key: cachedSessionKey,
              label: "Cached session",
              agentId: "main",
              updatedAt,
              usage: {
                ...totals,
                activityDates: [selectedDay],
                dailyBreakdown: [
                  { date: selectedDay, cost: totals.totalCost, tokens: totals.totalTokens },
                ],
              },
            },
            {
              key: pendingSessionKey,
              label: "Pending session",
              agentId: "main",
              updatedAt,
              usage: null,
            },
          ],
          totals,
          aggregates: {
            messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
            tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
            byModel: [],
            byProvider: [],
            byAgent: [{ agentId: "main", totals }],
            byChannel: [],
            daily: [
              {
                date: selectedDay,
                tokens: totals.totalTokens,
                cost: totals.totalCost,
                messages: 0,
                toolCalls: 0,
                errors: 0,
              },
            ],
          },
          cacheStatus: { status: "refreshing", cachedFiles: 1, pendingFiles: 1, staleFiles: 0 },
        },
        "usage.cost": {
          updatedAt,
          days: 1,
          daily: [{ ...totals, date: selectedDay }],
          totals,
        },
        "usage.status": { updatedAt, providers: [] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}usage`);
      const pendingRow = page.locator(".session-bar-row").filter({ hasText: "Pending session" });
      const cachedRow = page.locator(".session-bar-row").filter({ hasText: "Cached session" });
      await expect.poll(() => pendingRow.count(), { timeout: 10_000 }).toBe(1);

      await page.locator(".usage-select").selectOption("utc");
      await expect
        .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
        .toMatchObject({ mode: "utc" });
      await expect.poll(() => cachedRow.count(), { timeout: 10_000 }).toBe(1);
      await page.locator(".daily-bar-wrapper").click();

      await expect.poll(() => cachedRow.count()).toBe(1);
      await expect.poll(() => pendingRow.count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("renders cost analysis from Gateway usage data", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1_000, width: 1_440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.usage": {
          updatedAt: Date.now(),
          startDate: dayOffset(-89),
          endDate: dayOffset(0),
          sessions: [
            {
              key: "agent:main:cost-analysis",
              label: "Cost analysis",
              agentId: "main",
              modelProvider: "openai",
              model: "gpt-5.5",
              updatedAt: Date.now(),
              usage: {
                ...totals,
                activityDates: daily.map((entry) => entry.date),
                dailyBreakdown: daily.map((entry) => ({
                  date: entry.date,
                  cost: entry.totalCost,
                  tokens: entry.totalTokens,
                })),
                messageCounts: {
                  total: 40,
                  user: 20,
                  assistant: 20,
                  toolCalls: 12,
                  toolResults: 12,
                  errors: 0,
                },
                modelUsage: [
                  {
                    provider: "openai",
                    model: "gpt-5.5",
                    count: 30,
                    totals: { ...totals, totalCost: 22 },
                  },
                  {
                    provider: "anthropic",
                    model: "claude-opus-4-6",
                    count: 10,
                    totals: { ...totals, totalCost: 10 },
                  },
                ],
              },
            },
          ],
          totals,
          aggregates: {
            messages: {
              total: 40,
              user: 20,
              assistant: 20,
              toolCalls: 12,
              toolResults: 12,
              errors: 0,
            },
            tools: { totalCalls: 12, uniqueTools: 2, tools: [{ name: "exec", count: 8 }] },
            byModel: [
              {
                provider: "openai",
                model: "gpt-5.5",
                count: 30,
                totals: { ...totals, totalCost: 22 },
              },
              {
                provider: "anthropic",
                model: "claude-opus-4-6",
                count: 10,
                totals: { ...totals, totalCost: 10 },
              },
            ],
            byProvider: [
              { provider: "openai", count: 30, totals: { ...totals, totalCost: 22 } },
              { provider: "anthropic", count: 10, totals: { ...totals, totalCost: 10 } },
            ],
            byAgent: [{ agentId: "main", totals }],
            byChannel: [],
            daily: daily.map((entry) => ({
              date: entry.date,
              tokens: entry.totalTokens,
              cost: entry.totalCost,
              messages: 10,
              toolCalls: 3,
              errors: 0,
            })),
          },
        },
        "usage.cost": {
          updatedAt: Date.now(),
          days: 90,
          daily,
          totals,
        },
        "usage.status": {
          updatedAt: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              plan: "Admin API",
              windows: [],
              billing: [{ type: "spend", label: "30-day API spend", amount: 98.75, unit: "USD" }],
              costHistory: {
                unit: "USD",
                periodDays: 30,
                daily: [
                  {
                    date: dayOffset(-6),
                    amount: 38.5,
                    requests: 12_300,
                    inputTokens: 4_200_000,
                    cacheReadTokens: 2_100_000,
                    cacheWriteTokens: 0,
                    outputTokens: 850_000,
                    totalTokens: 5_050_000,
                  },
                  {
                    date: dayOffset(0),
                    amount: 60.25,
                    requests: 18_450,
                    inputTokens: 6_100_000,
                    cacheReadTokens: 3_400_000,
                    cacheWriteTokens: 0,
                    outputTokens: 1_200_000,
                    totalTokens: 7_300_000,
                  },
                ],
                models: [
                  {
                    name: "gpt-5.5",
                    requests: 30_750,
                    inputTokens: 10_300_000,
                    cacheReadTokens: 5_500_000,
                    cacheWriteTokens: 0,
                    outputTokens: 2_050_000,
                    totalTokens: 12_350_000,
                  },
                ],
                categories: [{ name: "Responses", amount: 98.75 }],
              },
            },
            {
              provider: "anthropic",
              displayName: "Anthropic",
              plan: "Admin API",
              windows: [],
              billing: [{ type: "spend", label: "30-day API spend", amount: 42.4, unit: "USD" }],
              costHistory: {
                unit: "USD",
                periodDays: 30,
                daily: [
                  {
                    date: dayOffset(-6),
                    amount: 17.15,
                    inputTokens: 1_800_000,
                    cacheReadTokens: 900_000,
                    cacheWriteTokens: 200_000,
                    outputTokens: 350_000,
                    totalTokens: 3_250_000,
                  },
                  {
                    date: dayOffset(0),
                    amount: 25.25,
                    inputTokens: 2_600_000,
                    cacheReadTokens: 1_400_000,
                    cacheWriteTokens: 300_000,
                    outputTokens: 500_000,
                    totalTokens: 4_800_000,
                  },
                ],
                models: [
                  {
                    name: "claude-opus-4-8",
                    inputTokens: 4_400_000,
                    cacheReadTokens: 2_300_000,
                    cacheWriteTokens: 500_000,
                    outputTokens: 850_000,
                    totalTokens: 8_050_000,
                  },
                ],
                categories: [{ name: "Claude API", amount: 42.4 }],
              },
            },
            {
              provider: "openrouter",
              displayName: "OpenRouter",
              plan: "Production",
              windows: [{ label: "API key budget", usedPercent: 25 }],
              billing: [
                {
                  type: "balance",
                  label: "Account balance",
                  amount: 64.5,
                  unit: "USD",
                },
                {
                  type: "budget",
                  label: "API key budget",
                  used: 5,
                  limit: 20,
                  unit: "USD",
                },
              ],
              summary: "$1.25 today · $5.00 this month",
            },
          ],
        },
      },
    });

    let usageLifecycleTraceInstalled = false;
    try {
      await page.goto(`${server.baseUrl}usage`);
      await page.locator(".daily-chart-compact").waitFor({ state: "visible", timeout: 10_000 });
      await installUsageLifecycleTrace(page);
      usageLifecycleTraceInstalled = true;
      const agentScope = page.locator(".agent-scope-control openclaw-agent-select");
      await agentScope.locator(".agent-select__trigger").click();
      await agentScope
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "All agents" })
        .click();
      await expect
        .poll(async () => (await gateway.getRequests("usage.cost")).at(-1)?.params)
        .toMatchObject({ agentScope: "all" });
      const costRequestsBeforeRangeChange = (await gateway.getRequests("usage.cost")).length;
      await page.getByRole("button", { name: "90d", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("usage.cost")).length)
        .toBeGreaterThan(costRequestsBeforeRangeChange);
      await page.getByRole("button", { name: "Cost", exact: true }).click();

      const windowCards = page.locator(".cost-window-card");
      await expect.poll(() => windowCards.count()).toBe(4);
      await expect
        .poll(async () => ({
          labels: await windowCards.locator(".cost-window-card__label").allTextContents(),
          values: (await windowCards.locator(".cost-window-card__value").allTextContents()).map(
            (value) => value.trim(),
          ),
        }))
        .toEqual({
          labels: ["Selected Range", "Today", "Last 7 days", "Last 30 days"],
          values: ["$32.00", "$11.00", "$20.00", "$27.00"],
        });
      await expect
        .poll(() => page.locator(".daily-chart-scale span").allTextContents())
        .toEqual(["$11.00", "$5.50", "$0.00"]);
      await expect
        .poll(() => page.locator(".usage-insight-card", { hasText: "Top Providers" }).textContent())
        .toContain("openai");
      const messagesHint = page.locator("#usage-summary-hint-messages");
      const messagesTooltipHost = messagesHint.locator("xpath=..");
      const messagesTooltip = messagesTooltipHost.locator("wa-tooltip");
      await messagesHint.hover();
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
      await page.mouse.move(1, 1);
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();

      await messagesHint.focus();
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
      await page.getByRole("button", { name: "Cost", exact: true }).focus();
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();

      await messagesHint.click();
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
      await expect
        .poll(() => messagesTooltipHost.locator('[slot="content"]').textContent())
        .toContain("Total user and assistant messages in range.");
      await page.getByRole("button", { name: "Cost", exact: true }).click();
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();
      await messagesHint.focus();
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
      await messagesHint.press("Escape");
      await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();
      const providerCards = page.locator(".provider-usage-card");
      await expect.poll(() => providerCards.count()).toBe(3);
      await expect
        .poll(async () => (await gateway.getRequests("usage.status")).length)
        .toBeGreaterThan(0);
      await expect
        .poll(() => providerCards.filter({ hasText: "OpenRouter" }).textContent())
        .toContain("$64.50");
      await expect
        .poll(() => providerCards.filter({ hasText: "OpenAI" }).textContent())
        .toContain("$98.75");
      await expect
        .poll(() => providerCards.filter({ hasText: "Anthropic" }).textContent())
        .toContain("claude-opus-4-8");

      try {
        await page.locator(".usage-query-input").fill("missing-session");
        await page.locator(".usage-query-input").press("Enter");
      } catch (error) {
        const trace = await disposeUsageLifecycleTrace(page, true);
        usageLifecycleTraceInstalled = false;
        throw new Error(`Usage query input failed with lifecycle trace: ${JSON.stringify(trace)}`, {
          cause: error,
        });
      }
      const topProviders = page.locator(".usage-insight-card", { hasText: "Top Providers" });
      await expect.poll(() => topProviders.textContent()).toContain("No provider data");
      await expect.poll(() => topProviders.textContent()).not.toContain("openai");

      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifactDir = path.join(
          process.cwd(),
          ".artifacts",
          "control-ui-e2e",
          "provider-plans",
        );
        await mkdir(artifactDir, { recursive: true });
        await page.locator(".usage-page").screenshot({
          path: path.join(artifactDir, "after.png"),
        });
      }
    } finally {
      if (usageLifecycleTraceInstalled) {
        await disposeUsageLifecycleTrace(page);
      }
      await context.close();
    }
  });
});
