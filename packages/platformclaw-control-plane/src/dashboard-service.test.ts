import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../src/test-utils/deferred.js";
import type { DashboardAccount } from "./dashboard-contracts.js";
import { DashboardBusyError, DashboardService, parseDashboardQuery } from "./dashboard-service.js";

function admissionFixture(count = 1) {
  let now = Date.parse("2026-10-16T00:00:00Z");
  const roster: DashboardAccount[] = Array.from({ length: count }, (_, index) => ({
    accountId: `account-${index}`,
    agentId: `agent-${index}`,
    displayName: `Sample ${index}`,
    status: "active",
    createdAt: now - 800 * 86_400_000,
    organizationId: null,
    organizationName: null,
  }));
  const request = vi.fn(async () => ({
    updatedAt: now,
    cacheStatus: { status: "fresh" },
    aggregates: { activity: [] },
  }));
  const service = new DashboardService({
    store: { listDashboardAccounts: async () => roster },
    gateway: { request },
    now: () => now,
  });
  const query = parseDashboardQuery(
    new URL("http://localhost/?startDate=2026-10-15&endDate=2026-10-16"),
  );
  return {
    service,
    request,
    query,
    roster,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("dashboard reporting scale and concurrency", () => {
  it("reuses finished reports across members, expires them and rereads changed identities", async () => {
    const f = admissionFixture();
    const first = await f.service.report(f.query, "member");
    expect(await f.service.report(f.query, "peer")).toBe(first);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.roster[0]!.displayName = "Renamed";
    expect((await f.service.report(f.query, "member")).accounts[0]!.displayName).toBe("Renamed");
    expect(f.request).toHaveBeenCalledTimes(4);
    f.advance(15_000);
    await f.service.report(f.query, "member");
    expect(f.request).toHaveBeenCalledTimes(6);
  });

  it("charges selected and comparison jobs across query variations, without blocking another member", async () => {
    const f = admissionFixture(100);
    for (let index = 0; index < 10; index++) {
      await f.service.report({ ...f.query, channel: `channel-${index}` }, "member");
    }
    expect(f.request).toHaveBeenCalledTimes(2_000);
    await expect(f.service.report(f.query, "member")).rejects.toBeInstanceOf(DashboardBusyError);
    expect(f.request).toHaveBeenCalledTimes(2_000);
    await f.service.report(f.query, "peer");
    expect(f.request).toHaveBeenCalledTimes(2_200);
    f.advance(60_000);
    await f.service.report(f.query, "member");
    expect(f.request).toHaveBeenCalledTimes(2_400);
  });

  it("rejects oversized report work before any upstream call", async () => {
    const f = admissionFixture(1_001);
    await expect(f.service.report(f.query, "member")).rejects.toBeInstanceOf(DashboardBusyError);
    expect(f.request).not.toHaveBeenCalled();
    await f.service.report({ ...f.query, accountId: "account-0" }, "member");
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("limits simultaneous reports per member and releases admission after failure", async () => {
    const f = admissionFixture();
    const gate = createDeferred<never>();
    f.request.mockImplementation(() => gate.promise);
    const first = f.service.report({ ...f.query, channel: "first" }, "member");
    const second = f.service.report({ ...f.query, channel: "second" }, "member");
    await expect(f.service.report(f.query, "member")).rejects.toBeInstanceOf(DashboardBusyError);
    const failed = Promise.allSettled([first, second]);
    gate.reject(new Error("Source unavailable"));
    expect((await failed).every((entry) => entry.status === "rejected")).toBe(true);
    f.request.mockResolvedValue({
      updatedAt: 0,
      cacheStatus: { status: "fresh" },
      aggregates: { activity: [] },
    });
    await expect(f.service.report(f.query, "member")).resolves.toBeDefined();
  });

  it.each([30, 366])(
    "projects %i days for 100 accounts with four bounded source workers",
    async (days) => {
      const endDate = "2026-10-16";
      const endMs = Date.parse(`${endDate}T00:00:00Z`);
      const startDate = new Date(endMs - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const roster: DashboardAccount[] = Array.from({ length: 100 }, (_, index) => ({
        accountId: `account-${index}`,
        agentId: `agent-${index}`,
        displayName: `Sample ${index}`,
        status: "active",
        createdAt: endMs - 800 * 86_400_000,
        organizationId: null,
        organizationName: null,
      }));
      let concurrent = 0;
      let peak = 0;
      let calls = 0;
      let maxSourceBytes = 0;
      const service = new DashboardService({
        store: { listDashboardAccounts: async () => roster },
        gateway: {
          request: async (_method, params) => {
            const request = params as {
              agentId: string;
              agentScope?: string;
              startDate: string;
              endDate: string;
              includeActivity: boolean;
            };
            expect(request.agentScope).toBeUndefined();
            expect(request.includeActivity).toBe(true);
            calls++;
            concurrent++;
            peak = Math.max(peak, concurrent);
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            concurrent--;
            const dates = Array.from({ length: days }, (_, day) => ({
              date: new Date(Date.parse(`${request.startDate}T00:00:00Z`) + day * 86_400_000)
                .toISOString()
                .slice(0, 10),
              userMessages: 2,
            }));
            const result = {
              updatedAt: endMs,
              cacheStatus: { status: "fresh" },
              aggregates: {
                activity: [
                  {
                    agentId: request.agentId,
                    channel: "webchat",
                    kind: "direct",
                    userMessages: days * 2,
                    toolCalls: days,
                    totalTokens: days * 100,
                    estimatedCost: days * 0.001,
                    missingCostEntries: 0,
                    sessionCount: 1,
                    daily: dates,
                    hours: [{ weekday: 0, hour: 10, userMessages: days * 2 }],
                  },
                ],
              },
            };
            maxSourceBytes = Math.max(maxSourceBytes, Buffer.byteLength(JSON.stringify(result)));
            return result;
          },
        },
      });
      const query = parseDashboardQuery(
        new URL(
          `http://localhost/?startDate=${startDate}&endDate=${endDate}&timeZone=Asia%2FSeoul`,
        ),
      );
      const began = performance.now();
      const [report, coalesced] = await Promise.all([
        service.report(query, "member"),
        service.report(query, "peer"),
      ]);
      const elapsedMs = performance.now() - began;
      expect(report).toBe(coalesced);
      expect(calls).toBe(200);
      expect(peak).toBe(4);
      expect(report.accounts).toHaveLength(100);
      expect(report.totals.requests).toBe(100 * days * 2);
      expect(report.daily.reduce((sum, day) => sum + day.requests, 0)).toBe(report.totals.requests);
      expect(report.heatmap.reduce((sum, hour) => sum + hour.requests, 0)).toBe(
        report.totals.requests,
      );
      expect(maxSourceBytes).toBeLessThan(50_000);
      console.info(
        JSON.stringify({
          benchmark: "dashboard-projection-with-synthetic-preaggregated-source",
          accounts: 100,
          days,
          elapsedMs: Math.round(elapsedMs),
          maxSourceBytes,
          reportBytes: Buffer.byteLength(JSON.stringify(report)),
          sourceCalls: calls,
          peakConcurrency: peak,
        }),
      );
    },
  );
});
