import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { findControlUiPreviewFixture } from "../test-helpers/control-ui-preview-fixtures.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
let browser: Browser;
let server: ControlUiE2eServer;

async function capture(page: Page, name: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const directory = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "memory-usability");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name + ".png"), animations: "disabled" });
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
}

async function openFixture(id: string, width: number, height: number, mode: "light" | "dark") {
  const fixture = findControlUiPreviewFixture(id);
  if (!fixture) {
    throw new Error(`Missing preview fixture: ${id}`);
  }
  return fixture.open({
    browser,
    server,
    options: { locale: "en-US", mode, theme: "platformclaw", viewport: { width, height } },
  });
}

suite("PlatformClaw Memory usability", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each([
    { width: 1920, height: 1080, mode: "light" as const },
    { width: 1280, height: 800, mode: "dark" as const },
    { width: 390, height: 844, mode: "light" as const },
    { width: 390, height: 844, mode: "dark" as const },
  ])(
    "keeps wide layout, navigation and reading usable at $width in $mode",
    async ({ width, height, mode }) => {
      const { page, context } = await openFixture("platformclaw-memory", width, height, mode);
      const tabs = page.locator(".platformclaw-memory-page__tabs");
      const name = `${width}-${mode}`;
      try {
        await expect.poll(() => page.locator("#memory-search-input").count()).toBe(1);
        const geometry = await page.evaluate(() => {
          const main = document.querySelector(".platformclaw-memory-page")!.getBoundingClientRect();
          const nav = document
            .querySelector(".platformclaw-memory-page__tabs")!
            .getBoundingClientRect();
          const title = document.querySelector(".page-title")!.getBoundingClientRect();
          return { width: main.width, alignment: Math.abs(nav.left - title.left) };
        });
        if (width === 1920) {
          expect(geometry.width).toBeGreaterThan(1000);
          expect(geometry.width).toBeLessThanOrEqual(1120);
        }
        expect(geometry.alignment).toBeLessThanOrEqual(2);
        await noOverflow(page);
        await capture(page, name + "-memory");
        await page.locator("#memory-search-input").fill("release");
        await page.locator("#memory-search-input").press("Enter");
        await expect
          .poll(() => page.locator(".memory-memories__results .memory-memories__result").count())
          .toBe(3);
        await page.locator('.memory-memories__filters wa-radio[value="wiki"]').click();
        await expect
          .poll(() => page.locator(".memory-memories__results .memory-memories__result").count())
          .toBe(1);
        await noOverflow(page);
        await capture(page, name + "-search");

        await tabs.getByRole("tab", { name: "Personal Wiki", exact: true }).click();
        const wiki = page.locator(".memory-wiki-page");
        await expect.poll(() => wiki.locator("[data-wiki-page]").count()).toBe(2);
        await wiki.getByRole("searchbox", { name: "Filter title or path" }).fill("ownership");
        await expect.poll(() => wiki.locator("[data-wiki-page]").count()).toBe(1);
        await wiki.locator(".memory-wiki-card__title").click();
        await expect
          .poll(() => page.locator(".wiki-document__reader").textContent())
          .toContain("Every production rollout");
        expect(await page.locator("[data-wiki-edit]").count()).toBe(0);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await wiki.getByRole("searchbox").fill("");
        await capture(page, name + "-wiki");
        await wiki.getByRole("button", { name: "Graph", exact: true }).click();
        await expect.poll(() => wiki.locator("[data-wiki-node]").count()).toBe(2);
        await wiki
          .getByRole("combobox", { name: "Select a document" })
          .selectOption("syntheses/release-preflight.md");
        await expect
          .poll(() => wiki.locator(".memory-wiki-graph__inspector").textContent())
          .toContain("Release ownership");
        await noOverflow(page);
        await capture(page, name + "-graph");
        await wiki.locator(".memory-wiki-graph__open").click();
        await expect
          .poll(() => page.locator(".wiki-document__reader").textContent())
          .toContain("Record canary health and the responsible owner.");
        await page.getByRole("button", { name: "Close", exact: true }).click();

        await tabs.getByRole("tab", { name: "Dreaming", exact: true }).click();
        await expect
          .poll(() => page.locator(".dreams-summary").textContent())
          .toContain("Record canary health and the responsible owner.");
        expect(await page.locator(".dreams-summary").textContent()).toContain(
          "Automatic consolidation on",
        );
        expect(await page.locator(".dreams__bubble").count()).toBe(0);
        await noOverflow(page);
        await capture(page, name + "-dreaming");
        await page.getByRole("button", { name: "View activity and waiting memories" }).click();
        expect(await page.locator(".dreams-advanced__maintenance").count()).toBe(0);
        await capture(page, name + "-activity");
        await page.getByRole("tab", { name: "Dream Diary", exact: true }).click();
        await expect
          .poll(() => page.locator(".dreams-diary__day-chip").first().textContent())
          .toMatch(/\d/);
        await capture(page, name + "-diary");
      } finally {
        await context.close();
      }
    },
    120_000,
  );

  it.each([
    { width: 1920, height: 1080, mode: "dark" as const },
    { width: 390, height: 844, mode: "light" as const },
  ])(
    "exposes the loaded versus global inventory at $width in the dense preview",
    async ({ width, height, mode }) => {
      const { page, context } = await openFixture("platformclaw-memory-busy", width, height, mode);
      try {
        await page
          .locator(".platformclaw-memory-page__tabs")
          .getByRole("tab", { name: "Personal Wiki" })
          .click();
        await expect.poll(() => page.locator("[data-wiki-page]").count()).toBe(28);
        expect(await page.locator(".memory-wiki-filterbar__count").textContent()).toContain(
          "32 pages in Wiki",
        );
        await page.getByRole("searchbox", { name: "Filter title or path" }).fill("no-such-title");
        await expect.poll(() => page.locator("[data-wiki-page]").count()).toBe(0);
        await page.getByRole("button", { name: "Clear filters" }).click();
        await expect.poll(() => page.locator("[data-wiki-page]").count()).toBe(28);
        await capture(page, `dense-${width}-${mode}-wiki`);
        await page.getByRole("button", { name: "Graph", exact: true }).click();
        await expect.poll(() => page.locator("[data-wiki-node]").count()).toBe(32);
        await noOverflow(page);
        await page
          .getByRole("combobox", { name: "Select a document" })
          .selectOption("concepts/preview-01.md");
        await capture(page, `dense-${width}-${mode}-graph`);
        await page.locator(".memory-wiki-graph__open").click();
        await expect
          .poll(() => page.locator(".wiki-document__reader").textContent())
          .toContain("Release canary ownership and rollback decision record");
      } finally {
        await context.close();
      }
    },
    60_000,
  );

  it("keeps genuine empty and service-error preview states distinct", async () => {
    for (const id of ["platformclaw-memory-empty", "platformclaw-memory-error"]) {
      const { page, context } = await openFixture(id, 390, 844, "dark");
      const empty = id.endsWith("empty");
      try {
        await expect
          .poll(() => page.locator("openclaw-memory-memories").textContent())
          .toContain(empty ? "MEMORY.md is empty" : "Synthetic service outage");
        await page
          .locator(".platformclaw-memory-page__tabs")
          .getByRole("tab", { name: "Personal Wiki" })
          .click();
        await expect
          .poll(() => page.locator(".memory-wiki-page").textContent())
          .toContain(empty ? "Memory wiki is not populated yet" : "Synthetic service outage");
        await page
          .locator(".platformclaw-memory-page__tabs")
          .getByRole("tab", { name: "Dreaming" })
          .click();
        await expect
          .poll(() => page.locator(".dreams-summary").textContent())
          .toContain(empty ? "No recently promoted memories" : "Synthetic service outage");
        await noOverflow(page);
        await capture(page, id);
      } finally {
        await context.close();
      }
    }
  }, 60_000);
});
