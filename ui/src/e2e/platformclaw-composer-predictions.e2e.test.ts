import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { openComposerPredictionFixture } from "../test-helpers/platformclaw-composer-fixture.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());

describe("PlatformClaw composer prediction keyboard behavior", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  it("keeps predictions out of the draft until Tab and supports Escape, typing, and IME", async () => {
    const f = await openComposerPredictionFixture({
      browser,
      server,
      options: {
        locale: "ko",
        mode: "light",
        theme: "platformclaw",
        viewport: { width: 1440, height: 900 },
      },
    });
    try {
      const chatUrl = f.page.url();
      await f.page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`, {
        waitUntil: "domcontentloaded",
      });
      const toggle = f.page.locator("platformclaw-composer-predictions-settings wa-switch");
      await toggle.waitFor();
      await expect.poll(() => toggle.getAttribute("aria-disabled")).not.toBe("true");
      const saved = f.page.waitForResponse(
        (response) =>
          response.url().endsWith("/platformclaw/api/composer-predictions") &&
          response.request().postDataJSON()?.enabled === true,
      );
      await toggle.click();
      await saved;
      await f.page.goto(chatUrl, { waitUntil: "domcontentloaded" });
      const input = f.page.locator(".agent-chat__composer-combobox textarea");
      const ghost = f.page.locator(".platformclaw-composer-prediction");
      await input.waitFor();
      const historyRequests = [
        ...(await f.gateway.getRequests("chat.startup")),
        ...(await f.gateway.getRequests("chat.history")),
      ];
      const selectedSession = (
        historyRequests.at(-1)?.params as { sessionKey?: string } | undefined
      )?.sessionKey;
      await f.gateway.emitChatFinal({
        runId: "background-run",
        sessionKey: selectedSession,
        text: "[MOCK] Background completion",
      });
      await f.page.waitForTimeout(1200);
      expect(f.predictionCalls()).toBe(0);
      const send = async (text: string) => {
        await input.fill(text);
        await input.press("Enter");
        await ghost.waitFor();
      };
      await send("계획을 설명해줘");
      expect(await input.inputValue()).toBe("");
      const sendsBefore = (await f.gateway.getRequests("chat.send")).length;
      await input.press("Enter");
      expect(await input.inputValue()).toBe("");
      expect((await f.gateway.getRequests("chat.send")).length).toBe(sendsBefore);
      await mkdir(".artifacts/composer-predictions", { recursive: true });
      await f.page.screenshot({ path: ".artifacts/composer-predictions/ghost-text.png" });
      await input.press("Tab");
      expect(await input.inputValue()).toBe("구체적인 실행 방법을 예시로 알려줘");
      expect((await f.gateway.getRequests("chat.send")).length).toBe(sendsBefore);
      await f.page.screenshot({ path: ".artifacts/composer-predictions/accepted.png" });
      await send("다른 계획도 알려줘");
      await input.press("Escape");
      expect(await ghost.count()).toBe(0);
      await send("세 번째 계획");
      await input.dispatchEvent("compositionstart", { data: "ㅎ" });
      await input.press("Tab");
      expect(await input.inputValue()).toBe("");
      expect(await ghost.count()).toBe(0);
      await input.dispatchEvent("compositionend", { data: "" });
      await send("네 번째 계획");
      await input.fill("직접 입력한 질문");
      expect(await ghost.count()).toBe(0);
      expect(await input.inputValue()).toBe("직접 입력한 질문");
      const scenario = f.page.getByLabel("Mock prediction scenario");
      await scenario.selectOption("delay");
      let before = f.predictionCalls();
      await input.fill("지연 중 취소");
      await input.press("Enter");
      await expect.poll(() => f.predictionCalls()).toBe(before + 1);
      expect(await ghost.count()).toBe(0);
      await input.fill("취소 후 직접 작성");
      await f.page.waitForTimeout(4200);
      expect(await ghost.count()).toBe(0);
      expect(await input.inputValue()).toBe("취소 후 직접 작성");
      await scenario.selectOption("busy");
      before = f.predictionCalls();
      await input.fill("모델 바쁨 확인");
      await input.press("Enter");
      await expect.poll(() => f.predictionCalls()).toBe(before + 1);
      expect(await ghost.count()).toBe(0);
      await scenario.selectOption("timeout");
      before = f.predictionCalls();
      await input.fill("10초 제한 확인");
      await input.press("Enter");
      await expect.poll(() => f.predictionCalls()).toBe(before + 1);
      await f.page.waitForTimeout(11_100);
      expect(await ghost.count()).toBe(0);
      expect(await input.inputValue()).toBe("");
    } finally {
      await f.context.close();
    }
  });
});
