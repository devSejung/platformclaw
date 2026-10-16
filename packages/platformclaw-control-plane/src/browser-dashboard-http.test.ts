import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import readXlsxFile from "read-excel-file/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUsageActivity } from "../../../src/shared/usage-activity.js";
import { BrowserAuthService, hashBrowserSessionToken } from "./browser-auth-service.js";
import { handlePlatformClawDashboardRequest } from "./browser-dashboard-http.js";
import type { DashboardReport } from "./dashboard-contracts.js";
import { DashboardService } from "./dashboard-service.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];
const servers: Server[] = [];
const stores: SqliteControlPlaneStore[] = [];
const NOW = Date.parse("2026-10-16T09:00:00Z");
const RANGE = "startDate=2026-10-15&endDate=2026-10-16&timeZone=Asia%2FSeoul";

function activity(
  agentId: string,
  count: number,
  extra: Partial<SessionUsageActivity> = {},
): SessionUsageActivity {
  return {
    agentId,
    channel: "webchat",
    kind: "direct",
    userMessages: count,
    toolCalls: count * 2,
    totalTokens: count * 100,
    estimatedCost: count * 0.01,
    missingCostEntries: 0,
    sessionCount: 1,
    lastActivity: NOW - 1000,
    daily: [{ date: "2026-10-16", userMessages: count }],
    hours: [{ weekday: 4, hour: 0, userMessages: count }],
    ...extra,
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-dashboard-"));
  directories.push(directory);
  const store = new SqliteControlPlaneStore({
    databasePath: join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin"],
  });
  stores.push(store);
  const users = await Promise.all(
    ["admin", "member", "second", "unused", "failed", "disabled"].map(async (accountId) => {
      const { user } = await store.upsertPrincipal(
        {
          provider: "ldap",
          subject: accountId,
          accountId,
          employeeId: `private-employee-${accountId}`,
          displayName: accountId === "second" ? "=SUM(A1:A2)" : accountId,
          email: `${accountId}@private.invalid`,
          groups: ["secret-group"],
        },
        NOW - 90 * 86_400_000,
      );
      const { binding } = await store.reservePersonalAgent(user.id, NOW - 80 * 86_400_000);
      await store.transitionAgent({
        bindingId: binding.id,
        state: accountId === "failed" ? "failed" : "active",
        changedAt: NOW - 1000,
      });
      return { user, binding };
    }),
  );
  const admin = users[0]!;
  const member = users[1]!;
  const second = users[2]!;
  const disabled = users[5]!;
  await store.setManagedUserStatus({
    actorUserId: admin.user.id,
    targetUserId: disabled.user.id,
    status: "disabled",
    changedAt: NOW - 100,
  });
  await store.createBrowserSession({
    userId: member.user.id,
    tokenHash: hashBrowserSessionToken("member-session"),
    createdAt: NOW,
  });
  let clock = NOW;
  const authService = new BrowserAuthService({
    store,
    authenticator: { authenticatePassword: vi.fn(), authenticateKnox: vi.fn() } as never,
    provisioner: { provisionOrRefresh: vi.fn() },
    now: () => clock,
  });
  const scope = await store.createManagedScope({
    actorUserId: admin.user.id,
    kind: "team",
    name: "Product",
    createdAt: NOW - 1000,
  });
  await store.setManagedScopeMembership({
    actorUserId: admin.user.id,
    scopeId: scope.id,
    userId: second.user.id,
    role: "member",
    reason: "test setup",
    changedAt: NOW - 900,
  });
  await store.setUserPrimaryScope({
    actorUserId: admin.user.id,
    userId: second.user.id,
    scopeId: scope.id,
    changedAt: NOW - 800,
  });
  let cacheStatus = "fresh";
  const current = [
    activity(member.binding.agentId, 3),
    activity(second.binding.agentId, 7),
    activity(users[4]!.binding.agentId, 2),
    activity(disabled.binding.agentId, 1),
    activity("shared-room-agent", 999),
  ];
  const gateway = {
    request: vi.fn(async (_method: string, params: unknown) => ({
      updatedAt: NOW,
      cacheStatus: { status: cacheStatus },
      sessions: [
        {
          key: "private-session-key",
          label: "private conversation",
          origin: { from: "private-sender" },
          usage: { sessionFile: "/private/path" },
        },
      ],
      aggregates: {
        activity: ((params as { startDate: string }).startDate === "2026-10-15"
          ? current
          : [activity(member.binding.agentId, 1), activity(second.binding.agentId, 2)]
        ).filter((entry) => entry.agentId === (params as { agentId: string }).agentId),
      },
    })),
  };
  const service = new DashboardService({ store, gateway, now: () => clock });
  const server = createServer((req, res) => {
    void handlePlatformClawDashboardRequest(req, res, { authService, service }).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/platformclaw/api/dashboard`;
  const get = (query = RANGE, token = "member-session") =>
    fetch(`${baseUrl}?${query}`, {
      headers: token ? { cookie: `platformclaw_session=${token}` } : {},
    });
  return {
    get,
    store,
    users,
    service,
    gateway,
    baseUrl,
    member,
    second,
    scope,
    setClock: (value: number) => {
      clock = value;
    },
    setCacheStatus: (value: string) => {
      cacheStatus = value;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    ),
  );
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("member-accessible PlatformClaw dashboard HTTP boundary", () => {
  it("returns all personal accounts, including unused/failed/disabled accounts, without private session or directory fields", async () => {
    const f = await fixture();
    const response = await f.get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = (await response.json()) as DashboardReport;
    expect(report.accounts).toHaveLength(6);
    expect(report.totals).toMatchObject({
      requests: 13,
      previousRequests: 3,
      activeAccounts: 4,
      registeredAccounts: 6,
    });
    expect(report.accounts.find((account) => account.accountId === "unused")).toMatchObject({
      requests: 0,
      activeDays: 0,
      lastActivity: null,
    });
    expect(report.accounts.find((account) => account.accountId === "disabled")?.requests).toBe(1);
    expect(report.daily).toEqual([
      { date: "2026-10-15", requests: 0, activeAccounts: 0 },
      { date: "2026-10-16", requests: 13, activeAccounts: 4 },
    ]);
    expect(report.heatmap.find((cell) => cell.weekday === 4 && cell.hour === 0)?.requests).toBe(13);
    expect(report.heatmap.reduce((sum, cell) => sum + cell.requests, 0)).toBe(13);
    for (const secret of [
      "private-session",
      "private conversation",
      "private-sender",
      "/private/path",
      "private-employee",
      "private.invalid",
      "secret-group",
      "shared-room-agent",
    ]) {
      expect(JSON.stringify(report)).not.toContain(secret);
    }
    expect(f.gateway.request).toHaveBeenCalledWith(
      "sessions.usage",
      expect.objectContaining({
        agentId: expect.any(String),
        includeActivity: true,
        limit: 0,
        groupBy: "instance",
        timeZone: "Asia/Seoul",
      }),
    );
  });

  it("applies account, organization, channel, and type filters on the server", async () => {
    const f = await fixture();
    const response = await f.get(
      `${RANGE}&organizationId=${f.scope.id}&channel=webchat&kind=direct`,
    );
    const report = (await response.json()) as DashboardReport;
    expect(report.accounts.map((account) => account.accountId)).toEqual(["second"]);
    expect(report.totals.requests).toBe(7);
    const filtered = (await (
      await f.get(`${RANGE}&accountId=member&channel=knox`)
    ).json()) as DashboardReport;
    expect(filtered.totals.requests).toBe(0);
    expect(filtered.accounts).toHaveLength(1);
  });

  it("rejects anonymous, expired, and disabled callers through real browser-session authentication", async () => {
    const f = await fixture();
    expect((await f.get(RANGE, "")).status).toBe(401);
    f.setClock(NOW + 13 * 3_600_000);
    expect((await f.get()).status).toBe(401);
    f.setClock(NOW);
    await f.store.setManagedUserStatus({
      actorUserId: f.users[0]!.user.id,
      targetUserId: f.member.user.id,
      status: "disabled",
      changedAt: NOW + 1,
    });
    expect((await f.get()).status).toBe(401);
    expect(f.gateway.request).not.toHaveBeenCalled();
  });

  it.each([
    `${RANGE}&agentScope=all`,
    `${RANGE}&timeZone=UTC`,
    `${RANGE}&format=json`,
    "startDate=2026-02-30&endDate=2026-03-01",
    "startDate=2026-10-16&endDate=2026-10-15",
    "startDate=2024-01-01&endDate=2026-01-01",
    RANGE.replace("Asia%2FSeoul", "invalid-zone"),
  ])("rejects malformed or unbounded query %s before querying usage", async (query) => {
    const f = await fixture();
    expect((await f.get(query)).status).toBe(400);
    expect(f.gateway.request).not.toHaveBeenCalled();
  });

  it("returns explicit pending status and sanitized gateway failures", async () => {
    const f = await fixture();
    f.setCacheStatus("refreshing");
    expect(await (await f.get()).json()).toMatchObject({
      cacheStatus: "refreshing",
      previousCacheStatus: "refreshing",
    });
    f.setClock(NOW + 3_001);
    f.gateway.request.mockRejectedValueOnce(new Error("private backend endpoint"));
    const response = await f.get();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private backend");
  });

  it("downloads a genuine five-sheet workbook with every matching account and literal formula-like names", async () => {
    const f = await fixture();
    const report = (await (await f.get()).json()) as DashboardReport;
    const response = await f.get(`${RANGE}&format=xlsx`);
    expect(response.headers.get("content-type")).toContain("spreadsheetml");
    const bytes = Buffer.from(await response.arrayBuffer());
    const workbook = await readXlsxFile(bytes);
    expect(workbook.map((sheet) => sheet.sheet)).toEqual([
      "Overview",
      "Accounts",
      "Daily",
      "Hours",
      "Definitions",
    ]);
    const accounts = workbook.find((sheet) => sheet.sheet === "Accounts")!.data;
    expect(accounts).toHaveLength(report.accounts.length + 1);
    expect(accounts[1]![1]).toBe("=SUM(A1:A2)");
    expect(accounts.slice(1).reduce((sum, row) => sum + Number(row[5]), 0)).toBe(
      report.totals.requests,
    );
    expect(workbook[0]!.data[3]![1]).toBe(report.totals.requests);
    const zip = await JSZip.loadAsync(bytes);
    const accountXml = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
    expect(accountXml).toContain('state="frozen"');
    expect(accountXml).not.toMatch(/<f[ >]/u);
    const filtered = await f.get(`${RANGE}&accountId=member&format=xlsx`);
    const selected = await readXlsxFile(Buffer.from(await filtered.arrayBuffer()));
    expect(selected.find((sheet) => sheet.sheet === "Accounts")!.data).toHaveLength(2);
  });
});
