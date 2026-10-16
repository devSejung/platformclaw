import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DashboardQuery,
  DashboardReport,
} from "../../../packages/platformclaw-control-plane/src/dashboard-contracts.js";
import { i18n } from "../i18n/index.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import "./dashboard-page.ts";

const mounted: HTMLElement[] = [];
function report(query: DashboardQuery, pending = false): DashboardReport {
  return {
    query,
    updatedAt: Date.now(),
    previousStartDate: query.startDate,
    previousEndDate: query.endDate,
    cacheStatus: pending ? "refreshing" : "fresh",
    previousCacheStatus: "fresh",
    totals: {
      registeredAccounts: 0,
      activeAccounts: 0,
      requests: 0,
      previousRequests: 0,
      toolCalls: 0,
      tokens: 0,
      estimatedCost: 0,
      missingCostEntries: 0,
    },
    daily: [{ date: query.endDate, requests: 0, activeAccounts: 0 }],
    heatmap: Array.from({ length: 168 }, (_, index) => ({
      weekday: Math.floor(index / 24),
      hour: index % 24,
      requests: 0,
    })),
    accounts: [],
    options: { accounts: [], organizations: [], channels: [], kinds: [] },
  };
}

async function mount(pending = false) {
  let responsePending = pending;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const params = new URL(url, "http://localhost").searchParams;
    const query = Object.fromEntries(params) as DashboardQuery;
    return new Response(JSON.stringify(report(query, responsePending)), {
      headers: { "content-type": "application/json" },
    });
  });
  const element = document.createElement("platformclaw-dashboard-page");
  element.fetchImpl = fetchImpl;
  document.body.append(element);
  mounted.push(element);
  await vi.waitFor(() => expect(element.querySelector(".pc-dashboard-stats")).not.toBeNull());
  return {
    element,
    fetchImpl,
    setPending: (value: boolean) => {
      responsePending = value;
    },
  };
}

beforeAll(async () => {
  await loadAllPlatformClawLocales();
  await i18n.setLocale("en");
});
afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("dashboard interactive lifecycle", () => {
  it("reports invalid editable time zones before presets and recovers after correction", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const { element, fetchImpl } = await mount();
    const input = element.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = "Seoul";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    element.querySelector<HTMLButtonElement>(".pc-dashboard-presets button")!.click();
    await element.updateComplete;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("valid IANA time zone");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    input.value = "UTC";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    element.querySelector<HTMLButtonElement>(".pc-dashboard-presets button")!.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await element.updateComplete;
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it("resumes pending aggregation on foreground return and stops refreshing after disconnect", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.useFakeTimers();
    const { element, fetchImpl, setPending } = await mount(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    setPending(false);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(element.textContent).not.toContain("Some activity is still being aggregated"),
    );
    element.remove();
    await vi.advanceTimersByTimeAsync(10_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
