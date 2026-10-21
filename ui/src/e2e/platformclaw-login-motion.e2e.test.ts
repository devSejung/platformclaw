import { afterAll, beforeAll, expect, it } from "vitest";
import { LOCALE_STORAGE_KEY } from "../i18n/lib/locale-preferences.ts";
import { createPlatformClawLoginE2eFixture } from "./platformclaw-login.test-support.ts";

const fixture = createPlatformClawLoginE2eFixture();
const { openLogin, screenshot } = fixture;

fixture.describe("PlatformClaw login language and idle motion", () => {
  beforeAll(() => fixture.start());
  afterAll(() => fixture.close());

  it.each([
    { locale: "en", browserLocale: "ko-KR", heading: "Work, accomplished.", signIn: "Sign in" },
    { locale: "ko", browserLocale: "en-US", heading: "완성된 업무로.", signIn: "로그인" },
  ] as const)(
    "applies saved $locale copy before first paint when the browser disagrees",
    async (variant) => {
      const { context, page } = await openLogin("dark", { width: 1280, height: 900 }, undefined, {
        storedLocale: variant.locale,
        browserLocale: variant.browserLocale,
        reducedMotion: "reduce",
      });
      try {
        await expect
          .poll(() => page.locator("html").getAttribute("data-first-paint-locale"))
          .toBe(variant.locale);
        const timing = await page.locator("html").evaluate((root) => ({
          applied: Number((root as HTMLElement).dataset.localeAppliedAt),
          painted: Number((root as HTMLElement).dataset.firstPaintAt),
        }));
        expect(timing.applied).toBeGreaterThan(0);
        expect(timing.applied).toBeLessThanOrEqual(timing.painted);
        expect(await page.locator("[data-login-hero] h1").textContent()).toContain(variant.heading);
        expect(
          await page.getByRole("button", { name: variant.signIn, exact: true }).isEnabled(),
        ).toBe(true);
        if (variant.locale === "en") {
          expect(await page.locator("main").textContent()).not.toMatch(/[가-힣]/u);
          expect(
            await page
              .locator("[data-login-hero]")
              .evaluate((root) => root.shadowRoot!.textContent),
          ).not.toMatch(/[가-힣]/u);
        }
        const labelsFit = await page.locator("[data-login-hero] svg.workspace").evaluate((svg) =>
          Array.from(svg.querySelectorAll("text")).every((text) => {
            const card = text.closest(
              ".source-one,.source-two,.source-three,.work-card,.result,.complete",
            )!;
            const paper = card.querySelector<SVGRectElement>("rect.paper, rect.accent-soft")!;
            const label = text.getBBox();
            const bounds = paper.getBBox();
            return label.x >= bounds.x + 8 && label.x + label.width <= bounds.x + bounds.width - 8;
          }),
        );
        expect(labelsFit).toBe(true);
        await screenshot(page, `desktop-dark-${variant.locale}.png`);
      } finally {
        await context.close();
      }
    },
  );

  it("continues subtle motion without a visible reset and preserves it through input and locale changes", async () => {
    const { context, page } = await openLogin("light", { width: 1280, height: 900 }, undefined, {
      storedLocale: "en",
    });
    try {
      const root = page.locator("[data-login-hero]");
      const hero = page.locator("[data-login-hero] .hero");
      // The UI E2E config's 15s polling budget covers the real 4.15s entrance.
      // Readiness is recorded by animationend, not an elapsed-time approximation.
      await expect.poll(() => root.getAttribute("data-motion-ready")).toBe("");
      await expect.poll(() => hero.locator(".flow-packet").count()).toBe(4);
      const seams = await hero.evaluate((element) => {
        const packets = Array.from(element.querySelectorAll(".flow-packet"));
        const results = packets.map((packet) => {
          const animation = packet.getAnimations()[0]!;
          const { duration, delay } = animation.effect!.getComputedTiming();
          animation.pause();
          const opacity = (time: number) => {
            animation.currentTime = time;
            return Number(getComputedStyle(packet).opacity);
          };
          const before = opacity(Number(delay) + Number(duration) - 1);
          const after = opacity(Number(delay) + Number(duration) + 1);
          animation.play();
          return { before, after, iterations: animation.effect!.getTiming().iterations };
        });
        element.querySelector(".flow-packet")!.setAttribute("data-existing-packet", "true");
        return results;
      });
      expect(
        seams.every(
          ({ before, after, iterations }) =>
            before < 0.01 && after < 0.01 && iterations === Infinity,
        ),
      ).toBe(true);

      const account = page.locator('input[name="identifier"]');
      const password = page.locator('input[name="password"]');
      await account.fill("person.one");
      await password.fill("fixture-only");
      await expect
        .poll(() =>
          hero.evaluate((element) =>
            element
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState === "paused"),
          ),
        )
        .toBe(true);
      const pausedTime = await hero
        .locator("[data-existing-packet]")
        .evaluate((packet) => packet.getAnimations()[0]!.currentTime);
      const writer = await context.newPage();
      await writer.route("**/locale-fixture.html", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Locale fixture</title>",
        }),
      );
      await writer.goto(`${fixture.baseUrl}locale-fixture.html`);
      await writer.evaluate((key) => localStorage.setItem(key, "ko"), LOCALE_STORAGE_KEY);
      await expect
        .poll(() => page.getByRole("button", { name: "로그인", exact: true }).count())
        .toBe(1);
      expect(await account.inputValue()).toBe("person.one");
      expect(await password.inputValue()).toBe("fixture-only");
      expect(await hero.locator("[data-existing-packet]").count()).toBe(1);
      expect(
        await hero
          .locator("[data-existing-packet]")
          .evaluate((packet) => packet.getAnimations()[0]!.currentTime),
      ).toBe(pausedTime);
      expect(await root.getAttribute("data-motion-ready")).toBe("");
      await writer.close();
      await page.bringToFront();
      await page.getByRole("link", { name: "ADSSO 로그인" }).focus();
      await expect
        .poll(() =>
          hero.evaluate((element) =>
            element
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState === "running"),
          ),
        )
        .toBe(true);
      const toggle = hero.getByRole("button", { name: "애니메이션 일시정지" });
      await toggle.click();
      await expect.poll(() => root.getAttribute("data-motion-paused")).toBe("");
      await hero.getByRole("button", { name: "애니메이션 재생" }).click();
      await expect.poll(() => root.getAttribute("data-motion-paused")).toBeNull();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect
        .poll(() => hero.evaluate((element) => element.getAnimations({ subtree: true }).length))
        .toBe(0);
      expect(await hero.locator(".flow-packet").count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
