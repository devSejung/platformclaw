import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import {
  controlUiSessionPath,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { installPlatformClawDocument } from "./platformclaw-document.test-support.ts";

let browser: Browser;
let server: ControlUiE2eServer;
const currentKey = "agent:person_one:release-planning";
const dashboardKey = "agent:person_one:login-incident";
const titleKey = "agent:person_one:deployment-checklist";
const oldText = "배포실패 원인은 환경 변수 누락이었습니다. 운영 설정을 확인해주세요.";
const incidentText = "로그인오류 이후 배포 대시보드에 접근할 수 없습니다.";
const message = (id: string, role: "user" | "assistant", text: string, seq: number) => ({
  role,
  content: [{ type: "text", text }],
  timestamp: 1_790_000_000_000 + seq * 60_000,
  __openclaw: { id, seq },
});
const oldMessage = message("old-deployment", "assistant", oldText, 20);
const neighborhood = [
  message("before", "user", "이전 작업의 실패 원인을 알려주세요.", 19),
  oldMessage,
  message("after", "user", "설정을 보완한 뒤 검증하겠습니다.", 21),
];
const incidentMessage = message("old-login", "user", incidentText, 9);
const hits = [
  {
    sessionKey: currentKey,
    sessionId: "control-ui-e2e-session",
    messageId: "old-deployment",
    role: "assistant",
    timestamp: oldMessage.timestamp,
    snippet: oldText,
    title: "서비스 배포 준비",
    score: 0,
  },
  {
    sessionKey: dashboardKey,
    sessionId: "incident-session",
    messageId: "old-login",
    role: "user",
    timestamp: incidentMessage.timestamp,
    snippet: incidentText,
    title: "로그인 오류 원인 분석",
    score: 0,
  },
];
const rows = [
  { key: currentKey, kind: "direct", label: "서비스 배포 준비", updatedAt: 3, boardFace: "chat" },
  {
    key: dashboardKey,
    kind: "direct",
    label: "로그인 오류 원인 분석",
    updatedAt: 2,
    boardFace: "dashboard",
    archived: true,
  },
  {
    key: titleKey,
    kind: "direct",
    label: "배포 체크리스트 정리",
    updatedAt: 1,
    boardFace: "dashboard",
  },
];
const roster = (sessions: typeof rows) => ({
  ts: 1,
  path: "",
  count: sessions.length,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  sessions,
  hasMore: false,
});

describe("PlatformClaw conversation search", () => {
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
    server = await startControlUiE2eServer();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([1440, 390])(
    "keeps search on demand and opens exact old messages at width %i",
    async (width) => {
      const context: BrowserContext = await browser.newContext({
        viewport: { width, height: 900 },
        locale: "en-US",
        serviceWorkers: "block",
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await installPlatformClawDocument(page, server.baseUrl);
        await page.route("**/platformclaw/api/auth/session", (route) =>
          route.fulfill({
            json: {
              authenticated: true,
              user: {
                accountId: "person.one",
                displayName: "김지원",
                department: "플랫폼개발팀",
                globalRole: "member",
              },
              agent: { agentId: "person_one", state: "active" },
              session: {
                idleExpiresAt: Date.now() + 60000,
                absoluteExpiresAt: Date.now() + 120000,
              },
            },
          }),
        );
        const gateway = await installMockGateway(page, {
          basePath: "/platformclaw/app",
          sessionKey: currentKey,
          defaultAgentId: "person_one",
          assistantAgentId: "person_one",
          featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
          historyMessages: Array.from({ length: 100 }, (_, i) =>
            message(
              `recent-${i}`,
              i % 2 ? "assistant" : "user",
              `최근 작업 기록 ${i + 1}`,
              i + 101,
            ),
          ),
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: { search: "배포" }, response: roster([rows[2]!]) },
                { response: roster(rows) },
              ],
            },
            "sessions.search": { results: hits, totalCount: 2, hasMore: false },
            "chat.history": {
              cases: [
                {
                  match: { messageId: "old-deployment" },
                  response: {
                    messages: neighborhood,
                    sessionId: "control-ui-e2e-session",
                    hasMore: true,
                    totalCount: 200,
                    offset: 19,
                  },
                },
                {
                  match: { messageId: "old-login" },
                  response: {
                    messages: [incidentMessage],
                    sessionId: "incident-session",
                    hasMore: false,
                  },
                },
              ],
            },
          },
        });
        await page.goto(
          new URL(controlUiSessionPath(currentKey, "/platformclaw/app"), server.baseUrl).toString(),
        );
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        const sidebarBefore = await page.locator("openclaw-app-sidebar").textContent();
        expect(await page.locator(".cmd-palette,.agent-chat__search-bar").count()).toBe(0);
        await page
          .locator(width === 1440 ? ".shell-chrome-controls__search" : ".chat-pane__palette-open")
          .click();
        const input = page.locator(".cmd-palette__input");
        await input.waitFor({ state: "visible" });
        expect(await page.locator(".cmd-palette__item").count()).toBe(0);
        await page.keyboard.press("Escape");
        await input.waitFor({ state: "hidden" });
        expect(await page.locator("openclaw-app-sidebar").textContent()).toBe(sidebarBefore);
        await page.keyboard.press("Control+k");
        await input.waitFor({ state: "visible" });
        await input.fill("배포");
        await page.locator(".cmd-palette__snippet").first().waitFor();
        expect(
          await page.locator(".cmd-palette").getByText("Plugins", { exact: true }).count(),
        ).toBe(0);
        expect(
          await page.locator(".cmd-palette").getByText("/verbose", { exact: true }).count(),
        ).toBe(0);
        expect(await page.locator(".cmd-palette mark").first().textContent()).toBe("배포");
        expect((await gateway.getRequests("sessions.search"))[0]?.params).toMatchObject({
          mode: "substring",
          scope: "agent",
          agentId: "person_one",
          query: "배포",
        });
        await page.locator(".cmd-palette__item").filter({ hasText: oldText }).click();
        await page.getByRole("paragraph").filter({ hasText: oldText }).waitFor();
        await page
          .getByRole("paragraph")
          .filter({ hasText: "이전 작업의 실패 원인을 알려주세요." })
          .waitFor();
        await page
          .getByRole("paragraph")
          .filter({ hasText: "설정을 보완한 뒤 검증하겠습니다." })
          .waitFor();
        expect(
          (await gateway.getRequests("chat.history")).some(
            (request) => (request.params as { messageId?: string })?.messageId === "old-deployment",
          ),
        ).toBe(true);
        expect(await page.locator(".cmd-palette").count()).toBe(0);
        await page.keyboard.press("Control+k");
        await input.waitFor({ state: "visible" });
        await input.fill("배포");
        await page.locator(".cmd-palette__item").filter({ hasText: incidentText }).click();
        await page.getByRole("paragraph").filter({ hasText: incidentText }).waitFor();
        expect(new URL(page.url()).pathname).toBe(
          controlUiSessionPath(dashboardKey, "/platformclaw/app"),
        );
        expect(new URL(page.url()).hash).toContain("message=old-login");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});
