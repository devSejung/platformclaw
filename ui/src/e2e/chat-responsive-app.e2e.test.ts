// Real-app responsive behavior runs against the canonical shipped UI bundle.
import type { Page } from "playwright";
import { beforeAll, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const APP_FIRST_RENDER_TIMEOUT_MS = 30_000;
const FULL_APP_TEST_OPTIONS = { concurrent: false, timeout: 60_000 } as const;
const SHARED_APP_CONTEXT_TEXT = "Context hover regression fixture.";
const SHARED_APP_SLASH_TEXT = "Short landscape slash command keyboard regression fixture.";
const SHARED_APP_IMAGE_URL = "https://cdn.example/render%2Epng?download=1";
const SHARED_APP_VIDEO_URL = "https://cdn.example/clip%2Emp4?download=1";

async function waitForLayoutSettled(page: Page): Promise<void> {
  // Raw DOM mutations skip Playwright's actionability wait. Allow style invalidation
  // to land, then observe one stable frame before measuring viewport bounds.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

const suite = createControlUiE2eSuite({
  name: "chat responsive real-app behavior",
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  let page: Page;
  const sharedAppPageErrors: string[] = [];

  beforeAll(async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1366, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", (error) => sharedAppPageErrors.push(error.message));
    await page.route("https://cdn.example/**", (route) => route.abort());
    await installMockGateway(page, {
      agentModel: "openai/gpt-5.5",
      assistantName: "Claw",
      methodResponses: {
        "commands.list": {
          commands: Array.from({ length: 12 }, (_, index) => ({
            name: `fixture-${index + 1}`,
            textAliases: [`/fixture-${index + 1}`],
            description: `Responsive slash option ${index + 1}`,
            source: "plugin",
            scope: "both",
            acceptsArgs: false,
          })),
        },
      },
      historyMessages: [
        {
          content: [{ text: SHARED_APP_CONTEXT_TEXT, type: "text" }],
          model: "openai/gpt-5.5",
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 5, 9, 51),
          usage: { cacheRead: 2_400, input: 19_600, output: 126 },
        },
        {
          content: `MEDIA:${SHARED_APP_IMAGE_URL}`,
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 0),
        },
        {
          content: "Encoded transcript video",
          __openclaw: { media: [{ url: SHARED_APP_VIDEO_URL, contentType: "video/mp4" }] },
          role: "user",
          timestamp: Date.UTC(2026, 6, 9, 10, 1),
        },
        {
          content: [{ text: SHARED_APP_SLASH_TEXT, type: "text" }],
          role: "assistant",
          timestamp: Date.UTC(2026, 6, 9, 10, 2),
        },
      ],
    });
    await page.goto(`${suite.server.baseUrl}chat/main`, {
      waitUntil: "domcontentloaded",
      timeout: APP_FIRST_RENDER_TIMEOUT_MS,
    });
    await page.getByText(SHARED_APP_SLASH_TEXT).waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
  }, 60_000);

  it(
    "does not replay a consumed session rail open generation after round trips or remounts",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const result = await page.evaluate(async () => {
        await customElements.whenDefined("openclaw-chat-session-rail");
        localStorage.setItem("openclaw.chat.observerHud.display", "pill");
        type Rail = HTMLElement & {
          companion: {
            exchanges: [];
            pendingQuestion: null;
            failedQuestion: null;
            hint: null;
            draft: string;
          };
          connected: boolean;
          consumedOpenRequest: number;
          onOpenRequestConsumed: (openRequest: number) => void;
          onVisibilityChange: (visible: boolean) => void;
          openRequest: number;
          sessionKey: string;
          updateComplete: Promise<boolean>;
        };
        const createRail = () => document.createElement("openclaw-chat-session-rail") as Rail;
        let rail = createRail();
        let consumedOpenRequest = 0;
        let visibleReports = 0;
        const configureRail = (nextRail: Rail) => {
          nextRail.companion = {
            exchanges: [],
            pendingQuestion: null,
            failedQuestion: null,
            hint: null,
            draft: "What changed?",
          };
          nextRail.connected = true;
          nextRail.consumedOpenRequest = consumedOpenRequest;
          nextRail.onOpenRequestConsumed = (openRequest) => {
            consumedOpenRequest = openRequest;
          };
          nextRail.onVisibilityChange = (visible) => {
            if (visible) {
              visibleReports += 1;
            }
          };
        };
        configureRail(rail);
        rail.sessionKey = "agent:main:a";
        document.body.append(rail);
        await rail.updateComplete;
        const mode = () =>
          rail.querySelector(".chat-session-rail--expanded") ? "expanded" : "pill";
        const update = async (sessionKey: string, openRequest: number) => {
          rail.sessionKey = sessionKey;
          rail.openRequest = openRequest;
          rail.consumedOpenRequest = consumedOpenRequest;
          await rail.updateComplete;
          return mode();
        };

        const sameElementModes = [
          await update("agent:main:a", 1),
          await update("agent:main:b", 0),
          await update("agent:main:a", 1),
          await update("agent:main:a", 2),
        ];
        rail.remove();
        rail = createRail();
        configureRail(rail);
        rail.sessionKey = "agent:main:a";
        rail.openRequest = 2;
        document.body.append(rail);
        await rail.updateComplete;
        const remountMode = mode();
        const nextGenerationMode = await update("agent:main:a", 3);

        const snapshot = {
          sameElementModes,
          remountMode,
          nextGenerationMode,
          storedPreference: localStorage.getItem("openclaw.chat.observerHud.display"),
          visibleReports,
        };
        rail.remove();
        localStorage.removeItem("openclaw.chat.observerHud.display");
        return snapshot;
      });

      expect(result).toEqual({
        sameElementModes: ["expanded", "pill", "pill", "expanded"],
        remountMode: "pill",
        nextGenerationMode: "expanded",
        storedPreference: "pill",
        visibleReports: 3,
      });
    },
  );

  it(
    "remeasures a populated composer when the viewport width changes",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const errorStart = sharedAppPageErrors.length;
      try {
        await page.setViewportSize({ width: 900, height: 800 });
        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        await textarea.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        await textarea.fill(
          "Resize this populated draft across a narrow pane so its wrapped lines change height without waiting for another input event. ".repeat(
            2,
          ),
        );
        await waitForLayoutSettled(page);
        const wideHeight = (await textarea.boundingBox())?.height ?? 0;

        await page.setViewportSize({ width: 430, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height > previousHeight + 1;
        }, wideHeight);
        const narrowHeight = (await textarea.boundingBox())?.height ?? 0;
        expect(narrowHeight).toBeGreaterThan(wideHeight + 1);

        await page.setViewportSize({ width: 900, height: 800 });
        await page.waitForFunction((previousHeight) => {
          const element = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return element !== null && element.getBoundingClientRect().height < previousHeight - 1;
        }, narrowHeight);
        expect(
          sharedAppPageErrors
            .slice(errorStart)
            .filter((message) => message.includes("ResizeObserver loop")),
        ).toEqual([]);
      } finally {
        await page.locator(".agent-chat__composer-combobox > textarea").fill("");
        await page.setViewportSize({ width: 1366, height: 900 });
      }
    },
  );

  it(
    "reveals, pins, and dismisses message context from the timestamp",
    FULL_APP_TEST_OPTIONS,
    async () => {
      try {
        await page.setViewportSize({ width: 1366, height: 900 });
        const group = page.locator(".chat-group").filter({ hasText: SHARED_APP_CONTEXT_TEXT });
        const details = group.locator("details.msg-meta");
        const context = details.locator(".msg-meta__details");
        const summary = details.locator(".msg-meta__summary");
        const messageText = group.locator(".chat-text").first();
        await messageText.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        const initialLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          return {
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
          };
        });
        expect(await context.isVisible()).toBe(false);

        // Travel like a real pointer: the footer overlay is pointer-gated until
        // the group is hovered, so enter through the message body first.
        await messageText.hover();
        await summary.hover();
        // The reveal is state-driven, so the re-render can lag the hover event
        // under CPU contention; poll instead of a one-shot visibility read.
        await context.waitFor({ state: "visible", timeout: 10_000 });
        const hoverLayout = await group.evaluate((node) => {
          const footer = node.querySelector<HTMLElement>(".chat-group-footer")!;
          const summaryNode = node.querySelector<HTMLElement>(".msg-meta__summary")!;
          const detailsOverlay = node.querySelector<HTMLElement>(".msg-meta__details")!;
          return {
            contextBottom: detailsOverlay.getBoundingClientRect().bottom,
            footerHeight: footer.getBoundingClientRect().height,
            groupHeight: (node as HTMLElement).getBoundingClientRect().height,
            summaryTop: summaryNode.getBoundingClientRect().top,
          };
        });
        expect(hoverLayout.footerHeight).toBeCloseTo(initialLayout.footerHeight, 2);
        expect(hoverLayout.groupHeight).toBeCloseTo(initialLayout.groupHeight, 2);
        expect(hoverLayout.contextBottom).toBeLessThanOrEqual(hoverLayout.summaryTop + 4);

        await page.mouse.move(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });

        await messageText.hover();
        await summary.hover();
        // Escape only owns pinned disclosures; it must not corrupt an active
        // hover preview before the click converts that preview into a pin.
        await page.keyboard.press("Escape");
        await summary.click();
        await page.mouse.move(0, 0);
        // Click-to-open must survive the pointer leaving the message group.
        await context.waitFor({ state: "visible", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBe("");

        await page.mouse.click(0, 0);
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBeNull();

        await messageText.hover();
        await summary.click();
        await context.waitFor({ state: "visible", timeout: 10_000 });
        await page.keyboard.press("Escape");
        await context.waitFor({ state: "hidden", timeout: 10_000 });
        expect(await details.getAttribute("open")).toBeNull();
      } finally {
        await page.keyboard.press("Escape");
        await page.mouse.move(0, 0);
      }
    },
  );

  it(
    "renders encoded media extensions from assistant output and transcript fields",
    FULL_APP_TEST_OPTIONS,
    async () => {
      const image = page.locator(`img.chat-message-image[src="${SHARED_APP_IMAGE_URL}"]`);
      const video = page.locator(`video[src="${SHARED_APP_VIDEO_URL}"]`);
      await image.waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
      await video.waitFor({ state: "attached", timeout: 10_000 });
      expect(await image.getAttribute("src")).toBe(SHARED_APP_IMAGE_URL);
      expect(await video.getAttribute("src")).toBe(SHARED_APP_VIDEO_URL);
    },
  );

  it(
    "scrolls the keyboard-active slash option into view in short landscape",
    FULL_APP_TEST_OPTIONS,
    async () => {
      try {
        await page.setViewportSize({ width: 568, height: 320 });
        await page
          .getByText(SHARED_APP_SLASH_TEXT)
          .waitFor({ timeout: APP_FIRST_RENDER_TIMEOUT_MS });
        const textarea = page.locator(".agent-chat__composer-combobox > textarea");
        await textarea.fill("/");
        await textarea.focus();
        const initiallyHidden = await page.evaluate(() => {
          const menu = document.querySelector<HTMLElement>(".slash-menu");
          const options = Array.from(
            document.querySelectorAll<HTMLElement>(".slash-menu-item[role='option']"),
          );
          const hiddenOption = options.find((option) => {
            const menuRect = menu?.getBoundingClientRect();
            const optionRect = option.getBoundingClientRect();
            return Boolean(menuRect && optionRect.bottom > menuRect.bottom + 1);
          });
          if (!menu || !hiddenOption) {
            throw new Error("Expected an initially hidden slash option");
          }
          menu.scrollTop = 0;
          const menuRect = menu.getBoundingClientRect();
          const itemRect = hiddenOption.getBoundingClientRect();
          return {
            id: hiddenOption.id,
            index: options.indexOf(hiddenOption),
            visible: itemRect.top >= menuRect.top - 1 && itemRect.bottom <= menuRect.bottom + 1,
          };
        });
        expect(initiallyHidden.visible).toBe(false);

        for (let index = 0; index < initiallyHidden.index; index += 1) {
          await page.keyboard.press("ArrowDown");
        }
        await page.waitForFunction((expectedId) => {
          const input = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          return input?.getAttribute("aria-activedescendant") === expectedId;
        }, initiallyHidden.id);
        await page.waitForFunction((expectedId) => {
          const active = document.getElementById(expectedId);
          const menu = active?.closest<HTMLElement>(".slash-menu");
          if (!active || !menu) {
            return false;
          }
          const menuRect = menu.getBoundingClientRect();
          const activeRect = active.getBoundingClientRect();
          return activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1;
        }, initiallyHidden.id);

        const result = await page.evaluate(() => {
          const input = document.querySelector<HTMLTextAreaElement>(
            ".agent-chat__composer-combobox > textarea",
          );
          const menu = document.querySelector<HTMLElement>(".slash-menu");
          const active = document.querySelector<HTMLElement>(".slash-menu-item--active");
          if (!input || !menu || !active) {
            throw new Error("Expected active slash option after keyboard navigation");
          }
          const menuRect = menu.getBoundingClientRect();
          const activeRect = active.getBoundingClientRect();
          return {
            activeDescendant: input.getAttribute("aria-activedescendant"),
            focusedTag: document.activeElement?.tagName,
            scrollTop: menu.scrollTop,
            visible: activeRect.top >= menuRect.top - 1 && activeRect.bottom <= menuRect.bottom + 1,
          };
        });

        expect(result.focusedTag).toBe("TEXTAREA");
        expect(result.activeDescendant).toBe(initiallyHidden.id);
        expect(result.scrollTop).toBeGreaterThan(0);
        expect(result.visible).toBe(true);
      } finally {
        await page.locator(".agent-chat__composer-combobox > textarea").fill("");
        await page.setViewportSize({ width: 1366, height: 900 });
      }
    },
  );
});
