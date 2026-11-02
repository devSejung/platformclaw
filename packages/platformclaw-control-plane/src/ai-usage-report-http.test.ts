import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntry,
} from "../../../src/config/sessions/session-accessor.js";
import { loadSessionCostSummary } from "../../../src/infra/session-cost-usage.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import { createPlatformClawWebIngressRuntime } from "./web-ingress-runtime.js";
import { upstreamHello } from "./web-ingress-test-harness.js";

const AI_USAGE_REPORT_PATH = "/platformclaw/api/v1/reports/ai-usage";

async function withReportServer(
  run: (fixture: {
    base: string;
    setSourceStatus: (status: "fresh" | "stale" | "failed") => void;
    setDepartment: (department: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "usage-report-http-")));
  try {
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const ui = join(root, "ui");
      mkdirSync(ui);
      mkdirSync(join(ui, "assets"));
      writeFileSync(join(ui, "platformclaw-login.html"), "<!doctype html>Login");
      writeFileSync(
        join(ui, "index.html"),
        '<!doctype html><html><head><title>Control</title><link rel="icon" href="./favicon.svg"><link rel="icon" href="./favicon-32.png"><link rel="apple-touch-icon" href="./apple-touch-icon.png"><link rel="manifest" href="./manifest.webmanifest"></head><body>App</body></html>',
      );
      writeFileSync(join(ui, "manifest.webmanifest"), '{"name":"OpenClaw Control","icons":[]}');
      writeFileSync(join(ui, "assets", "platformclaw-pixel-TEST.svg"), "<svg></svg>");
      writeFileSync(
        join(ui, "sw.js"),
        [
          'if (url.pathname.startsWith("/api/") || false) {}',
          'data = { title: "OpenClaw", body: event.data.text() };',
          'const title = data.title || "OpenClaw";',
          'const options = { icon: "./apple-touch-icon.png", badge: "./favicon-32.png", };',
        ].join("\n"),
      );
      let sourceStatus: "fresh" | "stale" | "failed" = "fresh";
      let agentId = "";
      const sessionId = "report-session";
      const runtime = createPlatformClawWebIngressRuntime({
        databasePath: join(root, "control.sqlite"),
        initialAdminAccountIds: ["person.one"],
        buildAgentMainSessionKey: ({ agentId: id }) => `agent:${id}:main`,
        resolveAgentIdFromSessionKey: (key) => /^agent:([^:]+):/u.exec(key)?.[1] ?? null,
        provisioner: { provisionOrRefresh: async () => {} },
        restartRecoveryProbe: { reconcileAfterRestart: async () => ({ status: "active" }) },
        employeeAuth: {
          employeeAuthConfig: { loginUrl: "http://127.0.0.1:1/not-used" },
          fetchImpl: async () => {
            throw new Error("Reporting must not authenticate an employee");
          },
        },
        gatewayClient: {
          client: { url: "ws://127.0.0.1:1", token: "synthetic-private-token" },
          createClient: (options) => ({
            start: () => options.onHelloOk?.(upstreamHello()),
            stop: () => {},
            request: async (method, params) => {
              if (method === "sessions.subscribe") {
                return { subscribed: true };
              }
              if (sourceStatus === "failed") {
                throw new Error("private transport details must not be exposed");
              }
              if (
                method !== "sessions.usage" ||
                !isRecord(params) ||
                params.agentId !== agentId ||
                typeof params.startDate !== "string" ||
                typeof params.endDate !== "string"
              ) {
                throw new Error("Report requested a foreign agent or unexpected Gateway method");
              }
              expect(params).toMatchObject({
                limit: 0,
                timeZone: "Asia/Seoul",
                includeContextWeight: false,
              });
              const storePath = join(root, "agents", agentId, "sessions", "sessions.json");
              const summary = expectDefined(
                await loadSessionCostSummary({
                  agentId,
                  sessionId,
                  sessionTarget: {
                    agentId,
                    sessionId,
                    sessionKey: `agent:${agentId}:main`,
                    storePath,
                  },
                  startMs: Date.parse(`${params.startDate}T00:00:00+09:00`),
                  endMs: Date.parse(`${params.endDate}T23:59:59.999+09:00`),
                  dayBucket: { mode: "time-zone", timeZone: "Asia/Seoul" },
                }),
                "persisted usage summary",
              );
              return {
                aggregates: { modelDaily: summary.dailyModelUsage ?? [] },
                totals: summary,
                cacheStatus: {
                  status: sourceStatus,
                  cachedFiles: 1,
                  pendingFiles: sourceStatus === "fresh" ? 0 : 1,
                },
              };
            },
          }),
        },
        adminRpc: {
          call: async () => {
            throw new Error("Unexpected admin RPC");
          },
        },
        publicOrigin: "https://usage.example.test",
        controlUiRoot: ui,
      });
      try {
        const principal = {
          provider: "ldap",
          subject: "person.one",
          accountId: "person.one",
          employeeId: "employee-number-not-for-export",
          displayName: "Example Person",
          department: "Example Engineering",
        } as const;
        const { user } = await runtime.auth.store.upsertPrincipal(principal, 1);
        const reservation = await runtime.auth.store.reservePersonalAgent(user.id, 2);
        agentId = reservation.binding.agentId;
        await runtime.auth.store.transitionAgent({
          bindingId: reservation.binding.id,
          state: "active",
          changedAt: 3,
        });
        await runtime.auth.store.upsertPrincipal(
          {
            ...principal,
            subject: "person.empty",
            accountId: "person.empty",
            employeeId: "employee-empty",
            displayName: "Empty Person",
            department: "Other Team",
          },
          4,
        );
        const sessionKey = `agent:${agentId}:main`;
        const storePath = join(root, "agents", agentId, "sessions", "sessions.json");
        await upsertSessionEntry(
          { agentId, sessionKey, storePath },
          {
            sessionId,
            updatedAt: Date.parse("2026-10-01T00:00:00Z"),
          },
        );
        await persistSessionTranscriptTurn(
          { agentId, sessionId, sessionKey, storePath },
          {
            messages: [
              {
                message: {
                  role: "assistant",
                  content: "private prompt text must stay private",
                  provider: "example-provider",
                  model: "example-model-a",
                  timestamp: Date.parse("2026-09-30T14:59:59Z"),
                  usage: { totalTokens: 10 },
                },
              },
              {
                message: {
                  role: "assistant",
                  content: "private response text must stay private",
                  provider: "example-provider",
                  model: "example-model-b",
                  timestamp: Date.parse("2026-09-30T15:00:00Z"),
                  usage: { totalTokens: 20 },
                },
              },
              {
                message: {
                  role: "assistant",
                  content: "unknown attribution stays counted",
                  timestamp: Date.parse("2026-10-01T00:00:00Z"),
                  usage: { totalTokens: 5 },
                },
              },
            ],
            touchSessionEntry: false,
          },
        );
        await runtime.listen({ host: "127.0.0.1", port: 0 });
        const address = runtime.server.address();
        if (!address || typeof address === "string") {
          throw new Error("Expected task-owned TCP listener");
        }
        await run({
          base: `http://127.0.0.1:${address.port}`,
          setSourceStatus(status) {
            sourceStatus = status;
          },
          async setDepartment(department) {
            await runtime.auth.store.upsertPrincipal({ ...principal, department }, 5);
          },
        });
      } finally {
        await runtime.close();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("intranet usage report HTTP runtime", () => {
  it("serves personal and model reports from SQLite without credentials on the existing listener", async () => {
    await withReportServer(async ({ base }) => {
      const response = await fetch(
        `${base}${AI_USAGE_REPORT_PATH}?knox_id=PERSON.ONE&month=2026-10`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        raw_data: [
          {
            knox_id: "person.one",
            month: "2026-10",
            team: "Example Engineering",
            ai_service: "PlatformClaw",
            call_count: 2,
            token_usage: 25,
            provider: null,
            model: null,
          },
        ],
        meta: { team_size: 1, total_tokens: 25, data_status: "complete" },
      });
      for (const privateValue of [
        "private prompt",
        "private response",
        "employee-number",
        "synthetic-private-token",
        "sessionFile",
      ]) {
        expect(body).not.toContain(privateValue);
      }
      const detail = await fetch(
        `${base}${AI_USAGE_REPORT_PATH}?knox_id=person.one&month=2026-10&group_by=model`,
      );
      expect(await detail.json()).toMatchObject({
        raw_data: [
          { model: "example-model-b", call_count: 1, token_usage: 20 },
          { model: null, provider: null, call_count: 1, token_usage: 5 },
        ],
        meta: { total_call_count: 2, total_tokens: 25 },
      });
      // Reporting does not relax browser application or Gateway authentication.
      const application = await fetch(`${base}/platformclaw/app/`, { redirect: "manual" });
      expect(application.status).toBe(302);
      expect(application.headers.get("location")).toContain("/platformclaw/login");
    });
  });

  it("distinguishes account search, typo, no usage, and invalid requests", async () => {
    await withReportServer(async ({ base }) => {
      const lookup = await fetch(`${base}${AI_USAGE_REPORT_PATH}/users?q=Example`);
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toEqual({
        users: [
          {
            knox_id: "person.one",
            display_name: "Example Person",
            team: "Example Engineering",
            status: "active",
          },
        ],
        meta: { total: 1, limit: 20, offset: 0, has_more: false, next_offset: null },
      });
      const unknown = await fetch(`${base}${AI_USAGE_REPORT_PATH}?knox_id=missing.person`);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({
        error: { code: "USER_NOT_FOUND", details: { unknown_knox_ids: ["missing.person"] } },
      });
      const empty = await fetch(`${base}${AI_USAGE_REPORT_PATH}?knox_id=person.empty`);
      expect(await empty.json()).toMatchObject({
        raw_data: [],
        meta: { total_tokens: 0, data_status: "complete" },
      });
      for (const suffix of [
        "?month=2026-10&period=last_month",
        "?knox_id=person.one&knox_id=person.empty",
        "?unexpected=true",
      ]) {
        expect((await fetch(`${base}${AI_USAGE_REPORT_PATH}${suffix}`)).status).toBe(400);
      }
      const method = await fetch(`${base}${AI_USAGE_REPORT_PATH}`, { method: "POST" });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET");
      const withBody = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          `${base}${AI_USAGE_REPORT_PATH}`,
          {
            method: "GET",
            headers: { "Content-Length": "2" },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
      expect(withBody).toBe(400);
    });
  });

  it("downloads Excel-safe CSV and never hides partial source data in an export", async () => {
    await withReportServer(async ({ base, setDepartment, setSourceStatus }) => {
      await setDepartment('=Engineering,"Lab"\nTeam');
      const csv = await fetch(
        `${base}${AI_USAGE_REPORT_PATH}?knox_id=person.one&month=2026-10&format=csv`,
      );
      expect(csv.status).toBe(200);
      expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(csv.headers.get("content-disposition")).toContain(
        "ai-usage-2026-10_2026-10-service.csv",
      );
      expect(csv.headers.get("x-report-total-tokens")).toBe("25");
      const bytes = Buffer.from(await csv.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.toString("utf8")).toContain('"\'=Engineering,""Lab""\nTeam"');
      setSourceStatus("stale");
      const partial = await fetch(
        `${base}${AI_USAGE_REPORT_PATH}?knox_id=person.one&month=2026-10`,
      );
      expect(await partial.json()).toMatchObject({ meta: { data_status: "partial" } });
      const rejected = await fetch(
        `${base}${AI_USAGE_REPORT_PATH}?knox_id=person.one&month=2026-10&format=csv`,
      );
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get("retry-after")).toBe("10");
      expect(await rejected.json()).toMatchObject({ error: { code: "REPORT_UNAVAILABLE" } });
      setSourceStatus("failed");
      const failure = await fetch(
        `${base}${AI_USAGE_REPORT_PATH}?knox_id=person.one&month=2026-10`,
      );
      expect(failure.status).toBe(503);
      expect(await failure.text()).not.toContain("private transport details");
    });
  });
});
