import { expect, it } from "vitest";
import {
  capture,
  finish,
  server,
  setup,
  setupSpaceBrowserTests,
  suite,
} from "./platformclaw-spaces.e2e-helpers.ts";

suite("Space contextual help", () => {
  setupSpaceBrowserTests();

  it.each(["en-US", "ko-KR"])("opens Space help from overview and detail in %s", async (locale) => {
    const { context, page, fixture, name } = await setup(
      `space-help-${locale}`,
      1440,
      "owner",
      locale,
    );
    const body =
      locale === "ko-KR"
        ? "공유 페이지에서 내 에이전트와 대화합니다. Space 에이전트는 공용 질문과 최종 답변을 참고할 수 있습니다."
        : "Shared pages and your own agent conversations. Space agents can recall shared questions and final answers.";
    const label = locale === "ko-KR" ? "Spaces 도움말" : "Help for Spaces";
    try {
      for (const detail of [false, true]) {
        await page.goto(
          `${server.baseUrl}platformclaw/app/spaces${detail ? `?space=${fixture.space.id}&page=${fixture.issue.id}` : ""}`,
        );
        const ui = page.locator("platformclaw-spaces-page");
        const heading = ui.locator(".pc-space-heading h1");
        await expect
          .poll(() => heading.textContent())
          .toBe(detail ? fixture.issue.title : "Spaces");
        const trigger = ui.locator("h1 + platformclaw-page-help-trigger");
        await expect.poll(() => trigger.count()).toBe(1);
        const button = trigger.getByRole("button", { name: label, exact: true });
        await expect.poll(() => button.isVisible()).toBe(true);
        expect(await button.getAttribute("title")).toBe(label);
        const bounds = await button.boundingBox();
        expect(bounds?.width).toBeGreaterThan(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
        await capture(page, `${name}-${detail ? "detail" : "overview"}-button`);
        await button.click();
        const modal = page.locator("platformclaw-page-help .help-panel");
        await expect.poll(() => modal.isVisible()).toBe(true);
        expect(await modal.locator("h2").textContent()).toBe("Spaces");
        expect(await modal.locator("p").textContent()).toBe(body);
        await capture(page, `${name}-${detail ? "detail" : "overview"}-open`);
        await modal.locator(".help-close").click();
        await expect.poll(() => modal.count()).toBe(0);
        await button.click();
        await expect.poll(() => modal.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => modal.count()).toBe(0);
        await button.click();
        await expect.poll(() => modal.isVisible()).toBe(true);
        await modal.locator(".help-close").click();
        expect(await heading.textContent()).toBe(detail ? fixture.issue.title : "Spaces");
      }
    } finally {
      await finish(context, page, name);
    }
  });

  it("follows Korean-English-Korean changes made in Appearance settings", async () => {
    const { context, page, fixture, name } = await setup(
      "space-help-language-switch",
      1440,
      "owner",
      "ko-KR",
    );
    try {
      for (const [index, locale] of (["ko", "en", "ko"] as const).entries()) {
        if (index > 0) {
          await page.goto(`${server.baseUrl}platformclaw/app/settings/appearance`);
          const select = page.locator("#settings-language wa-select");
          await select.click();
          await select.locator(`wa-option[value="${locale}"]`).click();
          await expect
            .poll(() =>
              select.evaluate((element) => (element as HTMLElement & { value: string }).value),
            )
            .toBe(locale);
          await capture(page, `${name}-${locale}-settings`);
        }
        const label = locale === "ko" ? "Spaces 도움말" : "Help for Spaces";
        const body =
          locale === "ko"
            ? "공유 페이지에서 내 에이전트와 대화합니다. Space 에이전트는 공용 질문과 최종 답변을 참고할 수 있습니다."
            : "Shared pages and your own agent conversations. Space agents can recall shared questions and final answers.";
        for (const detail of [false, true]) {
          await page.goto(
            `${server.baseUrl}platformclaw/app/spaces${detail ? `?space=${fixture.space.id}&page=${fixture.issue.id}` : ""}`,
          );
          const button = page
            .locator("platformclaw-spaces-page h1 + platformclaw-page-help-trigger")
            .getByRole("button", { name: label, exact: true });
          await button.waitFor({ state: "visible" });
          expect(await button.getAttribute("title")).toBe(label);
          await button.click();
          const modal = page.locator("platformclaw-page-help .help-panel");
          await expect.poll(() => modal.locator("p").textContent()).toBe(body);
          await capture(page, `${name}-${locale}-${detail ? "detail" : "overview"}-open`);
          await page.keyboard.press("Escape");
          await expect.poll(() => modal.count()).toBe(0);
        }
      }
    } finally {
      await finish(context, page, name);
    }
  });
});
