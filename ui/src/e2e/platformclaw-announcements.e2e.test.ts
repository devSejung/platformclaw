import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANNOUNCEMENTS_CHANGED } from "../../../packages/platformclaw-control-plane/src/announcement-contracts.js";
import { BrowserAnnouncementService } from "../../../packages/platformclaw-control-plane/src/browser-announcements-http.js";
import type { BrowserAuthService } from "../../../packages/platformclaw-control-plane/src/browser-auth-service.js";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.js";
import type { PlatformUser } from "../../../packages/platformclaw-control-plane/src/contracts.js";
import { SqliteControlPlaneStore } from "../../../packages/platformclaw-control-plane/src/sqlite-store.js";
import {
  PlatformClawWebIngressServer,
  type PlatformClawBrowserGatewayPolicy,
} from "../../../packages/platformclaw-control-plane/src/web-ingress-server.js";
import { FakeGateway } from "../../../packages/platformclaw-control-plane/src/web-ingress-test-harness.js";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import {
  installPlatformClawDocument,
  settlePlatformClawRendering as settleRendering,
} from "./platformclaw-document.test-support.ts";

const ORIGIN = "https://announcements.example.test";
const proof = path.join(process.cwd(), ".artifacts/control-ui-e2e/web-announcements");
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let browser: Browser;
let ui: ControlUiE2eServer;
let bff: PlatformClawWebIngressServer;
let base: string;
let directory: string;
let store: SqliteControlPlaneStore;
let now: number;
const users = new Map<string, PlatformUser>();
const contexts: BrowserContext[] = [];

function localTime(value: number) {
  return new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

async function shot(page: Page, name: string) {
  if (capture) {
    await page.screenshot({ path: path.join(proof, name), animations: "disabled" });
  }
}

async function newPage(
  user: string,
  scenario: ControlUiMockGatewayScenario = {},
  locale = "en-US",
) {
  const context = await browser.newContext({
    locale,
    viewport: { width: 1440, height: 960 },
    serviceWorkers: "block",
    ...(capture ? { recordVideo: { dir: proof, size: { width: 1440, height: 960 } } } : {}),
  });
  contexts.push(context);
  const page = await context.newPage();
  await installPlatformClawDocument(page, ui.baseUrl);
  await page.route("**/platformclaw/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes("/announcements")) {
      const response = await fetch(`${base}${pathname}`, {
        method: route.request().method(),
        headers: {
          Origin: ORIGIN,
          Cookie: `platformclaw_session=${user}`,
          "Content-Type": "application/json",
        },
        ...(route.request().method() === "POST" ? { body: route.request().postData() } : {}),
      });
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: await response.text(),
      });
    } else if (pathname.endsWith("/auth/session")) {
      const identity = users.get(user)!;
      await route.fulfill({
        json: {
          authenticated: true,
          user: identity,
          agent: { agentId: user.replaceAll(".", "_"), state: "active" },
        },
      });
    } else if (pathname.includes("organization")) {
      await route.fulfill({ json: { actor: users.get(user), joinPromptEligible: true } });
    } else {
      await route.fulfill({
        json: { activeTarget: "platform_server", availableVms: [], savedVms: [] },
      });
    }
  });
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: user.replaceAll(".", "_"),
    sessionKey: `agent:${user.replaceAll(".", "_")}:main`,
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    ...scenario,
  });
  await page.goto(`${ui.baseUrl}platformclaw/app/chat`);
  await gateway.waitForRequest("connect");
  await page.locator("platformclaw-announcements").waitFor({ state: "attached" });
  return { page, gateway };
}

async function openAdmin(page: Page) {
  await page.goto(`${ui.baseUrl}platformclaw/app/settings/announcements`);
  const admin = page.locator("platformclaw-announcement-administration");
  await admin.locator('[name="title"]').waitFor();
  return admin;
}

async function leaveAdmin(page: Page) {
  await page.locator(".settings-sidebar__back").click();
  await page.locator("platformclaw-announcement-administration").waitFor({ state: "detached" });
}

beforeAll(async () => {
  await mkdir(proof, { recursive: true });
  ui = await startControlUiE2eServer(undefined, { source: true });
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
});
beforeEach(async () => {
  now = Date.now();
  users.clear();
  directory = realpathSync(mkdtempSync(path.join(tmpdir(), "announcement-browser-")));
  store = new SqliteControlPlaneStore({
    databasePath: path.join(directory, "control.sqlite"),
    initialAdminAccountIds: ["admin.test"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  for (const accountId of ["admin.test", "member.one", "member.two"]) {
    const { user } = await store.upsertPrincipal(
      {
        provider: "ldap",
        subject: accountId,
        accountId,
        employeeId: accountId,
        displayName:
          accountId === "admin.test"
            ? "테스트 관리자"
            : `테스트 사용자 ${accountId === "member.one" ? "1" : "2"}`,
        department: "테스트 조직",
        groups: [],
      },
      now,
    );
    users.set(accountId, user);
  }
  // Only employee identity and the unrelated private Gateway are simulated;
  // notice HTTP routing, Origin validation, transactions and popup claims are real.
  const auth = {
    authenticateToken: async (token: string) =>
      users.has(token) ? { status: "active", user: users.get(token) } : { status: "not-found" },
  } as BrowserAuthService;
  bff = new PlatformClawWebIngressServer({
    publicOrigin: ORIGIN,
    authService: auth,
    announcementService: new BrowserAnnouncementService(auth, store.announcements, () => now),
    gateway: new FakeGateway(),
    gatewayProxy: {} as PlatformClawBrowserGatewayPolicy,
    loginRateLimiter: {
      check: () => ({ allowed: true, retryAfterMs: 0 }),
      recordFailure: () => {},
    },
  });
  await bff.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(bff.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close();
  }
  await bff?.close();
  store?.close();
  rmSync(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await browser?.close();
  await ui?.close();
});

describe("global web announcements", () => {
  it("records Korean preview, general notice, maintenance popup and scheduled state", async () => {
    const adminUser = await newPage("admin.test", {}, "ko-KR");
    const admin = await openAdmin(adminUser.page);
    await admin.locator('[name="title"]').fill("서비스 이용 안내");
    await admin
      .locator('[name="body"]')
      .fill(
        "새로운 공지 기능을 안내드립니다.\n중요한 안내는 모든 화면의 상단에서 확인하실 수 있습니다.",
      );
    await admin.locator('[name="expiresAt"]').fill(localTime(now + 3_600_000));
    await admin.getByRole("button", { name: "미리보기", exact: true }).click();
    await shot(adminUser.page, "ko-01-admin-preview.png");
    await admin.getByRole("button", { name: "게시", exact: true }).click();
    await expect.poll(() => admin.getByRole("status").textContent()).toContain("저장했습니다");
    await leaveAdmin(adminUser.page);
    const member = await newPage(
      "member.one",
      {
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "안녕하세요. 상단 공지에서 중요한 서비스 안내를 확인해 주세요.",
              },
            ],
          },
        ],
      },
      "ko-KR",
    );
    const notice = member.page.locator("platformclaw-announcements");
    await expect.poll(() => notice.locator("aside").textContent()).toContain("서비스 이용 안내");
    await shot(member.page, "ko-02-general-banner.png");
    await openAdmin(adminUser.page);
    expect(await admin.locator('[name="title"]').inputValue()).toBe("서비스 이용 안내");
    await admin.locator('[name="title"]').fill("서버 점검 안내");
    await admin
      .locator('[name="body"]')
      .fill("10분 뒤 서버 점검으로 잠시 연결이 끊깁니다.\n진행 중인 작업을 저장해 주세요.");
    await admin.locator('[name="kind"]').selectOption("maintenance");
    await admin.locator('[name="maintenanceAt"]').fill(localTime(now + 600_000));
    await expect.poll(() => admin.locator('[name="title"]').inputValue()).toBe("서버 점검 안내");
    await expect
      .poll(() => admin.locator('[name="body"]').inputValue())
      .toBe("10분 뒤 서버 점검으로 잠시 연결이 끊깁니다.\n진행 중인 작업을 저장해 주세요.");
    await admin.getByRole("button", { name: "미리보기", exact: true }).click();
    await admin.getByRole("button", { name: "공지 수정", exact: true }).click();
    await expect.poll(() => admin.getByRole("status").textContent()).toContain("저장했습니다");
    expect(store.announcements.snapshot(now).announcement?.title).toBe("서버 점검 안내");
    expect(store.announcements.snapshot(now).announcement?.body).toBe(
      "10분 뒤 서버 점검으로 잠시 연결이 끊깁니다.\n진행 중인 작업을 저장해 주세요.",
    );
    const ownPopup = adminUser.page.locator("platformclaw-announcements openclaw-modal-dialog");
    await adminUser.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
    await settleRendering(adminUser.page);
    expect(await ownPopup.count()).toBe(0);
    await leaveAdmin(adminUser.page);
    await ownPopup.waitFor();
    await adminUser.page.keyboard.press("Escape");
    await member.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
    await notice.locator("openclaw-modal-dialog").waitFor();
    await shot(member.page, "ko-03-maintenance-dialog.png");
    await member.page.keyboard.press("Escape");
    now += 660_000;
    await member.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
    await expect
      .poll(() => notice.locator(".countdown").textContent())
      .toContain("예정 시각이 되었습니다");
    await shot(member.page, "ko-04-scheduled-banner.png");
  }, 90_000);

  it("stacks existing banners without hiding the chat on narrow screens", async () => {
    store.announcements.mutate(
      users.get("admin.test")!.id,
      {
        action: "publish",
        expectedRevision: 0,
        title: "서버 점검 안내",
        body: "10분 뒤 서버 점검으로 잠시 연결이 끊깁니다.\n진행 중인 작업을 저장해 주세요.",
        kind: "maintenance",
        maintenanceAt: now + 600_000,
        expiresAt: now + 7_200_000,
      },
      now,
    );
    const { page, gateway } = await newPage(
      "member.one",
      {
        deviceAuthMigrationPending: true,
        historyMessages: Array.from({ length: 120 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: [
            {
              type: "text",
              text: `대화 스크롤 확인 ${index + 1}\n여러 배너가 있어도 대화 내용은 독립적으로 스크롤됩니다.`,
            },
          ],
          timestamp: now - (120 - index) * 60_000,
        })),
      },
      "ko-KR",
    );
    const notice = page.locator("platformclaw-announcements aside");
    const organization = page.locator(".platformclaw-organization-prompt");
    const migration = page
      .locator(
        "#control-ui-main > openclaw-device-auth-migration-banner .callout, #control-ui-main > openclaw-update-banner .callout.warn",
      )
      .first();
    await page.locator("platformclaw-announcements openclaw-modal-dialog").waitFor();
    await page.keyboard.press("Escape");
    await organization.waitFor();
    await migration.waitFor();
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    const composerBox = page.locator(".agent-chat__input");
    await composer.waitFor();
    const measurements = [];
    for (const viewport of [
      { width: 1440, height: 960 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await settleRendering(page);
      await page.locator("#control-ui-main").evaluate((main) => {
        main.scrollTop = 0;
      });
      await shot(page, `ko-stack-${viewport.width}x${viewport.height}.png`);
      const layout = await page.evaluate(() => {
        const main = document.querySelector("#control-ui-main")!;
        const announcementBanner = document
          .querySelector("platformclaw-announcements")!
          .shadowRoot!.querySelector("aside")!;
        const elements = [
          main.querySelector(
            "openclaw-device-auth-migration-banner .callout, openclaw-update-banner .callout.warn",
          )!,
          announcementBanner,
          main.querySelector(".platformclaw-organization-prompt")!,
          main.querySelector("openclaw-router-outlet")!,
          main.querySelector(".agent-chat__composer-combobox textarea")!,
        ];
        return {
          main: {
            top: main.getBoundingClientRect().top,
            bottom: main.getBoundingClientRect().bottom,
            scrollHeight: main.scrollHeight,
            clientHeight: main.clientHeight,
            overflowY: getComputedStyle(main).overflowY,
          },
          elements: elements.map((element) => {
            const r = element.getBoundingClientRect();
            return {
              name: element.tagName,
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              height: r.height,
            };
          }),
        };
      });
      measurements.push({ viewport, ...layout });
      if (layout.main.scrollHeight > layout.main.clientHeight) {
        await page.locator("#control-ui-main").focus();
        await page.keyboard.press("End");
        await expect
          .poll(() => page.locator("#control-ui-main").evaluate((main) => main.scrollTop))
          .toBeGreaterThan(0);
      }
      await composerBox.scrollIntoViewIfNeeded();
      const input = await composerBox.boundingBox();
      expect(input).not.toBeNull();
      expect(input!.y).toBeGreaterThanOrEqual(layout.main.top);
      expect(input!.y + input!.height).toBeLessThanOrEqual(layout.main.bottom + 1);
      await composer.fill("배너와 함께 표시되는 입력창 확인");
      const thread = await page.locator(".chat-thread").evaluate((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(thread.scrollHeight).toBeGreaterThan(thread.height);
      await shot(page, `ko-stack-scroll-${viewport.width}x${viewport.height}.png`);
      const viewer = page.locator("platformclaw-announcements");
      await viewer.getByRole("button", { name: "숨기기", exact: true }).click();
      await expect.poll(() => viewer.getAttribute("data-active")).toBeNull();
      expect(await notice.locator("strong").isVisible()).toBe(false);
      expect(await notice.locator("#announcement-content").isVisible()).toBe(false);
      expect(await notice.getByRole("button").count()).toBe(1);
      expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(32);
      expect(
        await page.locator("#control-ui-main").evaluate((main) => getComputedStyle(main).overflowY),
      ).toBe("hidden");
      await shot(page, `ko-hidden-${viewport.width}x${viewport.height}.png`);
      const reopen = viewer.getByRole("button", { name: "공지 보기", exact: true });
      await reopen.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => notice.locator("#announcement-content").isVisible()).toBe(true);
    }
    await writeFile(
      path.join(proof, "banner-stacking.json"),
      JSON.stringify(measurements, null, 2),
    );
    for (const layout of measurements) {
      for (let i = 1; i < 4; i++) {
        expect(layout.elements[i]!.top).toBeGreaterThanOrEqual(layout.elements[i - 1]!.bottom - 1);
      }
      expect(layout.main.overflowY).toBe("auto");
      expect(layout.elements[4]!.height).toBeGreaterThan(0);
    }
    await gateway.setOnline(false);
    await page.locator(".agent-chat__offline-hint").waitFor();
    await composerBox.scrollIntoViewIfNeeded();
    await shot(page, "ko-stack-offline.png");
    const offlineInput = await composerBox.boundingBox();
    expect(offlineInput!.y + offlineInput!.height).toBeLessThanOrEqual(390);
    await gateway.setOnline(true);
    store.announcements.mutate(
      users.get("admin.test")!.id,
      { action: "cancel", expectedRevision: 1 },
      now,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => notice.count()).toBe(0);
    await page.setViewportSize({ width: 1440, height: 960 });
    await settleRendering(page);
    const restored = await page.locator("#control-ui-main").evaluate((main) => {
      main.scrollTop = 0;
      const thread = main.querySelector(".chat-thread")!;
      return {
        overflowY: getComputedStyle(main).overflowY,
        height: main.clientHeight,
        scrollHeight: main.scrollHeight,
        threadHeight: thread.clientHeight,
        threadScrollHeight: thread.scrollHeight,
      };
    });
    expect(restored.overflowY).toBe("hidden");
    expect(restored.scrollHeight).toBeLessThanOrEqual(restored.height + 1);
    expect(restored.threadScrollHeight).toBeGreaterThan(restored.threadHeight);
    const restoredInput = await composer.boundingBox();
    expect(restoredInput!.y + restoredInput!.height).toBeLessThanOrEqual(960);
    store.announcements.mutate(
      users.get("admin.test")!.id,
      {
        action: "publish",
        expectedRevision: 2,
        kind: "general",
        title: "서비스 이용 안내",
        body: "중요한 안내는 모든 화면에서 확인하실 수 있습니다.\n조직 가입 안내도 함께 표시됩니다.",
        expiresAt: now + 3_600_000,
      },
      now,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${ui.baseUrl}platformclaw/app/settings/appearance`);
    await page.locator(".settings-page .settings-section__heading").first().waitFor();
    await notice.waitFor();
    await organization.waitFor();
    const bounds = [await notice.boundingBox(), await organization.boundingBox()];
    expect(bounds[1]!.y).toBeGreaterThanOrEqual(bounds[0]!.y + bounds[0]!.height);
    expect(
      await page
        .locator("#control-ui-main")
        .evaluate((main) => main.scrollWidth <= main.clientWidth),
    ).toBe(true);
    await shot(page, "ko-stack-settings-390x844.png");
  }, 90_000);

  it.each([1, 2])(
    "repeats preview, two users, routes, maintenance, reconnect, update and cancellation (%s)",
    async (iteration) => {
      const adminUser = await newPage("admin.test");
      const one = await newPage("member.one");
      const two = await newPage("member.two");
      const admin = await openAdmin(adminUser.page);
      await admin.locator('[name="title"]').fill("Synthetic global notice");
      const payload =
        '<img src=x onerror="window.noticeXss=1">\n<script>window.noticeXss=2</script>';
      await admin.locator('[name="body"]').fill(payload);
      await admin.locator('[name="expiresAt"]').fill(localTime(now + 3_600_000));
      await admin.getByRole("button", { name: "Preview", exact: true }).click();
      expect(await one.page.locator("platformclaw-announcements aside").count()).toBe(0);
      await shot(adminUser.page, `${iteration}-01-admin-preview.png`);
      await admin.getByRole("button", { name: "Publish", exact: true }).click();
      await expect.poll(() => admin.getByRole("status").textContent()).toContain("Saved");
      await leaveAdmin(adminUser.page);
      for (const client of [one, two]) {
        await client.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
        await client.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
        await expect
          .poll(() => client.page.locator("platformclaw-announcements aside").textContent())
          .toContain("Synthetic global notice");
        expect(await client.page.locator("platformclaw-announcements .body").textContent()).toBe(
          payload,
        );
        expect(
          await client.page
            .locator("platformclaw-announcements img, platformclaw-announcements script")
            .count(),
        ).toBe(0);
        expect(await client.page.locator("platformclaw-announcement-administration").count()).toBe(
          0,
        );
      }
      await shot(one.page, `${iteration}-02-general-banner.png`);
      await one.page.locator('a[href="/platformclaw/app/skills"]').first().click();
      await expect.poll(() => new URL(one.page.url()).pathname).toBe("/platformclaw/app/skills");
      await expect
        .poll(() => one.page.locator("platformclaw-announcements aside").isVisible())
        .toBe(true);
      await two.page.goto(`${ui.baseUrl}platformclaw/app/settings/appearance`);
      await expect
        .poll(() => two.page.locator("platformclaw-announcements aside").isVisible())
        .toBe(true);
      expect(await two.page.locator("platformclaw-organization-join-prompt").count()).toBe(1);
      await openAdmin(adminUser.page);
      expect(await admin.locator('[name="title"]').inputValue()).toBe("Synthetic global notice");
      await admin.locator('[name="title"]').fill("Planned synthetic maintenance");
      await admin.locator('[name="kind"]').selectOption("maintenance");
      await admin.locator('[name="maintenanceAt"]').fill(localTime(now + 120_000));
      await admin.getByRole("button", { name: "Preview", exact: true }).click();
      await admin.getByRole("button", { name: "Update announcement", exact: true }).click();
      await expect.poll(() => admin.getByRole("status").textContent()).toContain("Saved");
      await leaveAdmin(adminUser.page);
      for (const client of [one, two]) {
        await client.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
        await expect
          .poll(() =>
            client.page.locator("platformclaw-announcements openclaw-modal-dialog").count(),
          )
          .toBe(1);
        await client.page.keyboard.press("Escape");
        await expect
          .poll(() =>
            client.page.locator("platformclaw-announcements openclaw-modal-dialog").count(),
          )
          .toBe(0);
        await client.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
        await client.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
        expect(await client.page.locator("platformclaw-announcements aside").isVisible()).toBe(
          true,
        );
      }
      const details = one.page
        .locator("platformclaw-announcements")
        .getByRole("button", { name: "View announcement" });
      await details.focus();
      await one.page.keyboard.press("Enter");
      await expect
        .poll(() => one.page.locator("platformclaw-announcements openclaw-modal-dialog").count())
        .toBe(1);
      await shot(one.page, `${iteration}-03-maintenance-dialog.png`);
      await one.page.keyboard.press("Escape");
      await expect
        .poll(() =>
          details.evaluate(
            (element) => (element.getRootNode() as ShadowRoot).activeElement === element,
          ),
        )
        .toBe(true);
      await one.page.reload();
      await expect
        .poll(() => one.page.locator("platformclaw-announcements aside").isVisible())
        .toBe(true);
      expect(
        await one.page.locator("platformclaw-announcements openclaw-modal-dialog").count(),
      ).toBe(0);
      const before = (await one.gateway.getRequests("connect")).length;
      await one.gateway.closeLatest(1012, "synthetic reconnect");
      await expect
        .poll(async () => (await one.gateway.getRequests("connect")).length)
        .toBeGreaterThan(before);
      now += 180_000;
      await one.page.evaluate(() => {
        Date.now = () => 99_999_999_999_999;
      });
      await one.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
      await expect
        .poll(() => one.page.locator("platformclaw-announcements .countdown").textContent())
        .toContain("scheduled time reached");
      await shot(one.page, `${iteration}-04-scheduled-banner.png`);
      // The admin's own automatic popup resumes after leaving its settings page.
      const ownPopup = adminUser.page.locator("platformclaw-announcements openclaw-modal-dialog");
      if (await ownPopup.count()) {
        await adminUser.page.keyboard.press("Escape");
      }
      await openAdmin(adminUser.page);
      await admin.getByRole("button", { name: "Cancel announcement", exact: true }).click();
      await admin
        .locator(".preview")
        .getByRole("button", { name: "Cancel announcement", exact: true })
        .click();
      await expect.poll(() => admin.getByRole("status").textContent()).toContain("Saved");
      for (const client of [one, two]) {
        await client.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
        await expect
          .poll(() => client.page.locator("platformclaw-announcements aside").count())
          .toBe(0);
      }
      const revision = store.announcements.snapshot(now).revision;
      store.announcements.mutate(
        users.get("admin.test")!.id,
        {
          action: "publish",
          expectedRevision: revision,
          title: "Brief exposure",
          body: "Synthetic expiry",
          kind: "general",
          expiresAt: now + 2_000,
        },
        now,
      );
      await one.gateway.emitGatewayEvent(ANNOUNCEMENTS_CHANGED, {});
      await expect
        .poll(() => one.page.locator("platformclaw-announcements aside").textContent())
        .toContain("Brief exposure");
      await expect
        .poll(() => one.page.locator("platformclaw-announcements aside").count(), {
          timeout: 5_000,
        })
        .toBe(0);
    },
    120_000,
  );

  it("refreshes cancellation while a popup claim is delayed and ignores its stale completion", async () => {
    store.announcements.mutate(
      users.get("admin.test")!.id,
      {
        action: "publish",
        expectedRevision: 0,
        title: "Delayed claim",
        body: "Synthetic",
        kind: "maintenance",
        maintenanceAt: now + 60_000,
        expiresAt: now + 120_000,
      },
      now,
    );
    const context = await browser.newContext({ locale: "en-US" });
    contexts.push(context);
    const page = await context.newPage();
    let release!: () => void;
    let blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed = false;
    await page.route("**/platformclaw/api/announcements**", async (route) => {
      if (route.request().method() === "POST") {
        claimed = true;
        await blocked;
        await route.fulfill({ json: { show: true } });
      } else {
        await route.fulfill({ json: store.announcements.snapshot(now) });
      }
    });
    await page.goto(new URL("sw.js", ui.baseUrl).href);
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({
      type: "module",
      url: `${ui.baseUrl}src/platformclaw/announcements.ts`,
    });
    await page.evaluate(async () => {
      await customElements.whenDefined("platformclaw-announcements");
      document.body.append(document.createElement("platformclaw-announcements"));
    });
    await expect.poll(() => claimed).toBe(true);
    // Manually viewing the same revision also consumes its automatic popup.
    const notice = page.locator("platformclaw-announcements");
    // This standalone source fixture does not initialize the app's locale bundle.
    await notice
      .getByRole("button", { name: "platformClaw.announcements.details", exact: true })
      .click();
    await expect.poll(() => notice.locator("openclaw-modal-dialog").count()).toBe(1);
    await page.keyboard.press("Escape");
    const firstClaim = page.waitForResponse((response) => response.url().endsWith("/seen"));
    release();
    await firstClaim;
    await settleRendering(page);
    expect(await notice.locator("openclaw-modal-dialog").count()).toBe(0);
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    claimed = false;
    store.announcements.mutate(
      users.get("admin.test")!.id,
      {
        action: "update",
        expectedRevision: 1,
        title: "Delayed revision",
        body: "Synthetic",
        kind: "maintenance",
        maintenanceAt: now + 60_000,
        expiresAt: now + 120_000,
      },
      now,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => claimed).toBe(true);
    store.announcements.mutate(
      users.get("admin.test")!.id,
      { action: "cancel", expectedRevision: 2 },
      now,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => page.locator("platformclaw-announcements aside").count()).toBe(0);
    const lastClaim = page.waitForResponse((response) => response.url().endsWith("/seen"));
    release();
    await lastClaim;
    await settleRendering(page);
    await expect
      .poll(() => page.locator("platformclaw-announcements openclaw-modal-dialog").count())
      .toBe(0);
    store.announcements.mutate(
      users.get("admin.test")!.id,
      {
        action: "publish",
        expectedRevision: 3,
        title: "Poll recovery",
        body: "No event was sent",
        kind: "general",
        expiresAt: now + 120_000,
      },
      now,
    );
    // Recover a change on the periodic HTTP path when another BFF emits no local signal.
    await expect
      .poll(() => notice.locator("aside").textContent(), { timeout: 20_000 })
      .toContain("Poll recovery");
  });
});
