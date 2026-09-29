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

async function openFixture(
  id: string,
  width: number,
  height: number,
  mode: "light" | "dark",
  locale = "en-US",
) {
  const fixture = findControlUiPreviewFixture(id);
  if (!fixture) {
    throw new Error(`Missing preview fixture: ${id}`);
  }
  return fixture.open({
    browser,
    server,
    options: { locale, mode, theme: "platformclaw", viewport: { width, height } },
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
        const geometry = await page.evaluate(async () => {
          await document.fonts.ready;
          // The Memory child activates the header inset through :has(); wait for
          // that padding transition before measuring the settled page alignment.
          const header = document.querySelector(".content-header")!;
          void getComputedStyle(header).paddingLeft;
          await Promise.all(header.getAnimations().map((animation) => animation.finished));
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
          .toBe(2);
        expect(
          await page
            .locator("[data-memory-source]")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-memory-source"))),
        ).toEqual(["memory", "wiki"]);
        await page.locator('.memory-memories__filters wa-radio[value="wiki"]').click();
        await expect
          .poll(() => page.locator(".memory-memories__results .memory-memories__result").count())
          .toBe(1);
        await noOverflow(page);
        await capture(page, name + "-search");

        await tabs.getByRole("tab", { name: "Wiki Hub", exact: true }).click();
        const wiki = page.locator("platformclaw-memory-vaults");
        await wiki
          .locator('[data-vault-card="personal:assigned-personal"] .vaults__card-title')
          .click();
        const documents = wiki.locator("platformclaw-vault-documents");
        await expect.poll(() => documents.locator(".wiki-hub__document-card").count()).toBe(2);
        await documents.getByRole("button", { name: "Release ownership", exact: true }).click();
        const reader = wiki.locator("platformclaw-vault-reader");
        await expect
          .poll(() => reader.locator(".wiki-document__reader").textContent())
          .toContain("Every production rollout");
        expect(
          await reader.getByRole("button", { name: "Edit document", exact: true }).count(),
        ).toBe(1);
        await reader.getByRole("button", { name: "Close document", exact: true }).click();
        await capture(page, name + "-wiki");
        await documents.getByRole("tab", { name: "Document graph", exact: true }).click();
        await expect.poll(() => documents.locator("[data-svg-graph-node]").count()).toBe(2);
        await documents
          .getByRole("searchbox", { name: "Filter graph by title or path" })
          .fill("ownership");
        await expect.poll(() => documents.locator("[data-svg-graph-node]").count()).toBe(1);
        await documents.getByRole("searchbox").fill("");
        await documents
          .getByRole("combobox", { name: "Select a document" })
          .selectOption("syntheses/release-preflight.md");
        await expect
          .poll(() => documents.locator(".vault-graph__inspector").textContent())
          .toContain("Release ownership");
        await noOverflow(page);
        await capture(page, name + "-graph");
        await documents.getByRole("button", { name: "Open document", exact: true }).click();
        await expect
          .poll(() => reader.locator(".wiki-document__reader").textContent())
          .toContain("Record canary health and the responsible owner.");
        await reader.getByRole("button", { name: "Close document", exact: true }).click();

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
    "keeps the dense Wiki inventory and graph consistent at $width",
    async ({ width, height, mode }) => {
      const { page, context } = await openFixture("platformclaw-memory-busy", width, height, mode);
      try {
        await page.locator("#platformclaw-memory-tab-vaults").click();
        const wiki = page.locator("platformclaw-memory-vaults");
        await wiki
          .locator('[data-vault-card="personal:assigned-personal"] .vaults__card-title')
          .click();
        const documents = wiki.locator("platformclaw-vault-documents");
        await expect.poll(() => documents.locator(".wiki-hub__document-card").count()).toBe(32);
        await capture(page, "dense-" + width + "-" + mode + "-wiki");
        await documents.getByRole("tab", { name: "Document graph", exact: true }).click();
        await expect.poll(() => documents.locator("[data-svg-graph-node]").count()).toBe(32);
        const filter = documents.getByRole("searchbox", { name: "Filter graph by title or path" });
        await filter.fill("no-such-title");
        await expect.poll(() => documents.locator("[data-svg-graph-node]").count()).toBe(0);
        await filter.fill("");
        await expect.poll(() => documents.locator("[data-svg-graph-node]").count()).toBe(32);
        await noOverflow(page);
        await documents
          .getByRole("combobox", { name: "Select a document" })
          .selectOption("concepts/preview-01.md");
        await capture(page, "dense-" + width + "-" + mode + "-graph");
        await documents.getByRole("button", { name: "Open document", exact: true }).click();
        await expect
          .poll(() => wiki.locator(".wiki-document__reader").textContent())
          .toContain("Release canary ownership and rollback decision record");
      } finally {
        await context.close();
      }
    },
    60_000,
  );

  it.each([
    { width: 1920, height: 1080, mode: "light" as const, locale: "ko-KR" },
    { width: 390, height: 844, mode: "dark" as const, locale: "ko-KR" },
    { width: 1920, height: 1080, mode: "dark" as const, locale: "en-US" },
    { width: 390, height: 844, mode: "light" as const, locale: "en-US" },
  ])(
    "keeps role-only badges and readable document cards at $width in $locale",
    async ({ width, height, mode, locale }) => {
      const { page, context } = await openFixture(
        "platformclaw-memory-busy",
        width,
        height,
        mode,
        locale,
      );
      try {
        await page.locator("#platformclaw-memory-tab-vaults").click();
        const wiki = page.locator("platformclaw-memory-vaults");
        await expect.poll(() => wiki.locator("[data-vault-card]").count()).toBe(3);
        await page.evaluate(() => document.fonts.ready);
        const badges = await wiki.locator("[data-vault-role]").evaluateAll((elements) =>
          elements.map((badge) => {
            const range = document.createRange();
            range.selectNodeContents(badge);
            const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
            const bounds = badge.getBoundingClientRect();
            return {
              label: badge.textContent!.trim(),
              lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
              readable: rects.every(
                (rect) =>
                  rect.left >= bounds.left &&
                  rect.right <= bounds.right &&
                  rect.top >= bounds.top &&
                  rect.bottom <= bounds.bottom,
              ),
            };
          }),
        );
        expect(badges.map((badge) => badge.label)).toEqual(
          locale === "ko-KR" ? ["소유자", "소유자", "편집자"] : ["Owner", "Owner", "Editor"],
        );
        for (const badge of badges) {
          expect(badge).toMatchObject({ lines: 1, readable: true });
        }
        await wiki
          .locator('[data-vault-card="personal:assigned-personal"] .vaults__card-title')
          .click();
        const cards = wiki.locator("platformclaw-vault-documents .wiki-hub__document-card");
        await expect.poll(() => cards.count()).toBe(32);
        expect(await cards.locator(".vaults__badge, .dreams-diary__insight-badge").count()).toBe(0);
        const titles = await cards.locator(".settings-row__title").evaluateAll((elements) =>
          elements.map((title) => ({
            clipped:
              title.scrollWidth > title.clientWidth || title.scrollHeight > title.clientHeight,
            contained:
              title.getBoundingClientRect().right <=
              title.closest("article")!.getBoundingClientRect().right,
          })),
        );
        for (const title of titles) {
          expect(title).toEqual({ clipped: false, contained: true });
        }
        expect(await cards.first().textContent()).toContain("Synthetic preview page 01");
        expect(await cards.first().textContent()).not.toContain("Synthetic claim");
        await noOverflow(page);
        await capture(page, "cards-" + width + "-" + locale + "-" + mode);
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
          .getByRole("tab", { name: "Wiki Hub" })
          .click();
        if (empty) {
          await page
            .locator('[data-vault-card="personal:assigned-personal"] .vaults__card-title')
            .click();
        }
        await expect
          .poll(() => page.locator("platformclaw-memory-vaults").textContent())
          .toContain(empty ? "No documents yet" : "Synthetic service outage");
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
