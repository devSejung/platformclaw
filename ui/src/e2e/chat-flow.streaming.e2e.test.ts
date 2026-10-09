import { expect, it } from "vitest";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  pauseVirtualClock,
  requireRecord,
  requireString,
  scrollChatThreadToTop,
  waitForChatScrollIdle,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("renders stable markdown during a streaming chat turn and finalizes the tail", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const prompt = "stream markdown through the GUI";
      await gateway.deferNext("chat.send");
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const streamingText = "## Streaming heading\n\nworking **tail";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-bubble.streaming strong").getByText("tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await page.locator(".chat-thread h2").getByText("Streaming heading").waitFor({
        timeout: 10_000,
      });

      await gateway.emitChatFinal({
        runId,
        text: "## Streaming heading\n\nworking **tail**",
      });

      await page.locator(".chat-thread strong").getByText("tail").waitFor({ timeout: 10_000 });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("normalizes Unicode line separators in streaming and final chat DOM", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      await gateway.deferNext("chat.send");
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("render Unicode separators");
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      const streamingText = "## Unicode stream\u2028\u2028working **tail";
      await gateway.emitGatewayEvent("chat", {
        deltaText: streamingText,
        message: {
          content: [{ text: streamingText, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.locator(".chat-thread h2").getByText("Unicode stream").waitFor({
        timeout: 10_000,
      });
      await page.locator(".chat-bubble.streaming strong").getByText("tail").waitFor({
        timeout: 10_000,
      });
      expect(await page.locator(".markdown-plain-text-fallback").count()).toBe(0);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await gateway.emitChatFinal({
        runId,
        text: "## Unicode final\u2028\u2028- first\u2029- second",
      });

      await page.locator(".chat-thread h2").getByText("Unicode final").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(() => page.locator(".chat-thread li").allTextContents(), { timeout: 10_000 })
        .toEqual(["first", "second"]);
      const finalChatText = await page.locator(".chat-thread .chat-text").last().textContent();
      expect(finalChatText).not.toContain("\u2028");
      expect(finalChatText).not.toContain("\u2029");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    { label: "desktop", initialFocus: "composer", viewport: { height: 900, width: 1280 } },
    { label: "mobile", initialFocus: "composer", viewport: { height: 844, width: 390 } },
    {
      label: "mobile from transcript",
      initialFocus: "transcript",
      viewport: { height: 844, width: 390 },
    },
  ])(
    "keeps streamed text visible when a chat error terminates the turn on $label",
    async ({ viewport, initialFocus }) => {
      const context = await suite.newBrowserContext({
        hasTouch: viewport.width < 480,
        isMobile: viewport.width < 480,
        locale: "en-US",
        permissions: ["clipboard-read", "clipboard-write"],
        serviceWorkers: "block",
        viewport,
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page);

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        if (initialFocus === "transcript") {
          await page.addStyleTag({ content: ":root { --safe-area-bottom: 34px !important; }" });
        }

        const prompt = "stream before terminal error";
        await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();

        const sendRequest = await gateway.waitForRequest("chat.send");
        const params = requireRecord(sendRequest.params);
        const runId = requireString(params.idempotencyKey, "chat send idempotency key");
        const partialText = "Partial answer before gateway error.";
        await gateway.emitGatewayEvent("chat", {
          deltaText: partialText,
          message: {
            content: [{ text: partialText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "delta",
        });
        await page
          .locator(".chat-thread-inner")
          .getByText(partialText)
          .waitFor({ timeout: 10_000 });

        const gatewayErrorText =
          "⚠️ Model login expired on the gateway for openai. Send `/login codex` from a private chat or Web UI session to pair a new Codex login, or re-auth with `openclaw models auth login --provider openai` in a terminal, then try again.";
        const errorText = gatewayErrorText.replace(/^⚠️\s*/u, "");
        await gateway.emitGatewayEvent("chat", {
          errorMessage: gatewayErrorText,
          message: {
            content: [{ text: gatewayErrorText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "error",
        });

        await page
          .locator(".chat-thread-inner")
          .getByText(partialText)
          .waitFor({ timeout: 10_000 });
        const alert = page.locator(".chat-run-error");
        await alert.waitFor({ timeout: 10_000 });
        const details = alert.locator("details");
        const summary = alert.locator("summary");
        const diagnostic = alert.getByLabel("Error details", { exact: true });
        expect(await summary.locator("strong").textContent()).toBe(`${errorText.slice(0, 119)}…`);
        expect(await details.getAttribute("open")).toBeNull();
        expect(await diagnostic.isVisible()).toBe(false);
        const copy = alert.getByRole("button", { name: "Copy error", exact: true });
        expect(await copy.count()).toBe(1);
        if (initialFocus === "transcript") {
          await page.locator(".chat-thread-inner").getByText(partialText, { exact: true }).tap();
          expect(
            await page.locator("textarea").evaluate((input) => document.activeElement === input),
          ).toBe(false);
        }
        const copyBounds = await copy.boundingBox();
        if (viewport.width < 480) {
          await copy.tap();
        } else {
          await copy.click();
        }
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(errorText);
        const copiedBounds = await summary.getByRole("button").boundingBox();
        expect(copyBounds).not.toBeNull();
        expect(copiedBounds).not.toBeNull();
        expect(Math.abs((copyBounds?.y ?? 0) - (copiedBounds?.y ?? 0))).toBeLessThanOrEqual(1.5);
        expect(await details.getAttribute("open")).toBeNull();
        await summary.focus();
        await summary.press("Enter");
        await diagnostic.waitFor({ timeout: 10_000 });
        expect(await diagnostic.textContent()).toBe(errorText);
        await page.evaluate(() => navigator.clipboard.writeText("Before expanded copy."));
        await summary.getByRole("button").press("Enter");
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(errorText);
        expect(await details.getAttribute("open")).not.toBeNull();
        await summary.press("Space");
        await diagnostic.waitFor({ state: "hidden" });
        expect(await alert.locator("button").count()).toBe(2);
        expect(await alert.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(1);
        expect(await alert.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
        expect(await alert.getByRole("button", { name: "Dismiss error" }).count()).toBe(0);
        await expectRequestCountStable(gateway, "chat.send", 1);
        expect(
          await page.locator(".chat-thread-inner").getByText(partialText, { exact: true }).count(),
        ).toBe(1);
        expect(await page.locator(".chat-thread-inner").getByText(errorText).count()).toBe(0);
        expect(
          await alert.evaluate((element) =>
            element.nextElementSibling?.classList.contains("agent-chat__composer-shell"),
          ),
        ).toBe(true);
        const [alertBox, composerBox] = await Promise.all([
          alert.boundingBox(),
          page.locator(".agent-chat__composer-shell").boundingBox(),
        ]);
        expect(alertBox).not.toBeNull();
        expect(composerBox).not.toBeNull();
        expect(Math.abs((alertBox?.x ?? 0) - (composerBox?.x ?? 0))).toBeLessThan(1);
        expect(Math.abs((alertBox?.width ?? 0) - (composerBox?.width ?? 0))).toBeLessThan(1);

        if (initialFocus === "transcript") {
          // Headless Chromium cannot toggle installed-app display mode. Apply
          // the exact shipped standalone rules, as the login-gate suite does.
          await page.evaluate(() => {
            const rules = Array.from(document.styleSheets)
              .flatMap((sheet) => Array.from(sheet.cssRules))
              .filter(
                (rule): rule is CSSMediaRule =>
                  rule instanceof CSSMediaRule &&
                  rule.conditionText.includes("display-mode: standalone"),
              )
              .flatMap((rule) => Array.from(rule.cssRules))
              .filter(
                (rule): rule is CSSStyleRule =>
                  rule instanceof CSSStyleRule &&
                  rule.selectorText.includes(".agent-chat__composer-shell"),
              );
            if (rules.length === 0) {
              throw new Error("Missing standalone composer spacing rules");
            }
            const standalone = document.createElement("style");
            standalone.textContent = rules.map((rule) => rule.cssText).join("\n");
            document.head.append(standalone);
          });
        }

        await page.locator(".agent-chat__composer-combobox textarea").fill("retry after error");
        await page.getByRole("button", { name: "Send message" }).click();
        const requests = await waitForRequests(gateway, "chat.send", 2);
        await alert.waitFor({ state: "detached", timeout: 10_000 });

        // A separately rejected retry must retain its input; refreshing must not
        // submit that input again or replace a newer composer draft.
        const retryParams = requireRecord(requests[1]?.params);
        const retryRunId = requireString(retryParams.idempotencyKey, "retry send idempotency key");
        const recovery =
          "Your message didn't run because the conversation changed. Refresh the conversation, then send it again.";
        const refreshError = `${recovery}\n\nDispatchSessionRefreshRequiredError: Session "main" changed while starting work. Retry.`;
        const refreshedText = "Current conversation loaded after refresh.";
        // This partial stream has no persisted row. Authoritative history has
        // canonical identities; refresh must retain the local partial once.
        await gateway.setHistoryMessages([
          {
            role: "user",
            content: prompt,
            __openclaw: { id: "first-user", seq: 1, idempotencyKey: `${runId}:user` },
          },
          {
            role: "user",
            content: "retry after error",
            __openclaw: { id: "retry-user", seq: 2, idempotencyKey: `${retryRunId}:user` },
          },
          {
            role: "assistant",
            content: refreshedText,
            __openclaw: { id: "refreshed-reply", seq: 3 },
          },
        ]);
        await gateway.emitGatewayEvent("chat", {
          errorMessage: refreshError,
          runId: retryRunId,
          sessionKey: "main",
          state: "error",
        });
        await alert.waitFor({ timeout: 10_000 });
        expect(await summary.locator("strong").textContent()).toBe(`Error: ${recovery}`);
        if (initialFocus === "transcript") {
          const input = page.locator(".agent-chat__composer-combobox textarea");
          await input.focus();
          expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(
            await page
              .locator(".agent-chat__composer-shell")
              .evaluate((element) => getComputedStyle(element).marginBottom),
          ).toBe("48px");
          await alert.getByRole("button", { name: "Copy error", exact: true }).tap();
          await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(`Error: ${refreshError}`);
        }
        await summary.press("Enter");
        await diagnostic.waitFor({ timeout: 10_000 });
        expect(await diagnostic.textContent()).toBe(`Error: ${refreshError}`);
        await alert.getByRole("button", { name: "Copy error", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(`Error: ${refreshError}`);
        expect(await details.getAttribute("open")).not.toBeNull();
        await summary.press("Space");
        await diagnostic.waitFor({ state: "hidden" });
        const input = page.locator(".agent-chat__composer-combobox textarea");
        await input.fill("A newer draft stays here");
        if (initialFocus === "transcript") {
          await page.locator(".chat-thread-inner").getByText(partialText, { exact: true }).tap();
          expect(await input.evaluate((element) => document.activeElement === element)).toBe(false);
        }
        const historyCount = (await gateway.getRequests("chat.history")).length;
        const refresh = alert.getByRole("button", { name: "Refresh", exact: true });
        if (viewport.width < 480) {
          await refresh.tap();
        } else {
          await refresh.click();
        }
        await waitForRequests(gateway, "chat.history", historyCount + 1);
        await page.getByText(refreshedText, { exact: true }).waitFor({ timeout: 10_000 });
        expect(await summary.locator("strong").textContent()).toBe(`Error: ${recovery}`);
        expect(await input.inputValue()).toBe("A newer draft stays here");
        expect(
          await page.locator(".chat-thread-inner").getByText(prompt, { exact: true }).count(),
        ).toBe(1);
        expect(
          await page.locator(".chat-thread-inner").getByText(partialText, { exact: true }).count(),
        ).toBe(1);
        expect(
          await page
            .locator(".chat-thread-inner")
            .getByText("retry after error", { exact: true })
            .count(),
        ).toBe(1);
        await expectRequestCountStable(gateway, "chat.send", 2);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps the pending telemetry row stable through acknowledgement and streaming", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("chat.send");

      const prompt = "hold this until the ack arrives";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      await expect
        .poll(() => page.locator(".agent-chat__composer-combobox textarea").inputValue(), {
          timeout: 10_000,
        })
        .toBe("");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      const indicator = page.locator(".chat-reading-indicator");
      await indicator.waitFor({ timeout: 10_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
      await page.locator(".chat-working-indicator").evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const pendingRow = await indicator
        .locator(
          "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' chat-virtual-row ')][1]",
        )
        .elementHandle();
      if (!pendingRow) {
        throw new Error("expected pending working indicator virtual row");
      }
      const pendingLayout = await pendingRow.evaluate((row) => {
        const rect = row.getBoundingClientRect();
        Reflect.set(window, "__openclawPendingWorkingRow", row);
        return {
          height: rect.height,
          key: row.getAttribute("data-virtual-row-key"),
          top: rect.top,
        };
      });
      expect(pendingLayout.key).not.toBeNull();
      await page.evaluate(() => {
        const samples: Array<{
          height: number | null;
          key: string | null;
          sameRow: boolean;
          top: number | null;
        }> = [];
        Reflect.set(window, "__openclawWorkingRowSamples", samples);
        let remaining = 20;
        const sample = () => {
          const originalRow = Reflect.get(window, "__openclawPendingWorkingRow");
          const currentRow = document
            .querySelector(".chat-reading-indicator")
            ?.closest<HTMLElement>(".chat-virtual-row");
          const rect = currentRow?.getBoundingClientRect();
          samples.push({
            height: rect?.height ?? null,
            key: currentRow?.getAttribute("data-virtual-row-key") ?? null,
            sameRow: currentRow === originalRow,
            top: rect?.top ?? null,
          });
          remaining -= 1;
          if (remaining > 0) {
            requestAnimationFrame(sample);
          }
        };
        sample();
      });

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });

      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });
      await indicator.waitFor({ timeout: 10_000 });
      const samples = await page.evaluate(
        () =>
          new Promise<
            Array<{
              height: number | null;
              key: string | null;
              sameRow: boolean;
              top: number | null;
            }>
          >((resolve) => {
            const read = () => {
              const current = Reflect.get(window, "__openclawWorkingRowSamples");
              if (Array.isArray(current) && current.length >= 20) {
                resolve(current);
                return;
              }
              requestAnimationFrame(read);
            };
            read();
          }),
      );
      const layouts = samples.filter(
        (sample): sample is { height: number; key: string; sameRow: true; top: number } =>
          sample.sameRow &&
          typeof sample.height === "number" &&
          typeof sample.key === "string" &&
          typeof sample.top === "number",
      );
      expect(layouts).toHaveLength(20);
      expect(new Set(layouts.map((sample) => sample.key))).toEqual(new Set([pendingLayout.key]));
      const tops = layouts.map((sample) => sample.top);
      const heights = layouts.map((sample) => sample.height);
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);

      await gateway.emitGatewayEvent("agent", {
        data: { outputTokens: 2_400 },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "usage",
        ts: Date.now(),
      });
      await expect
        .poll(async () =>
          (await page.locator(".chat-working-indicator__tokens").textContent())?.trim(),
        )
        .toBe("2.4k output tokens");

      const response = "The streamed response is now visible.";
      await gateway.emitGatewayEvent("chat", {
        deltaText: response,
        message: {
          content: [{ text: response, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });

      await page.getByText(response).waitFor({ timeout: 10_000 });
      await indicator.waitFor({ timeout: 10_000 });
      const streamingLayout = await pendingRow.evaluate(
        (row, visibleResponse) => ({
          connected: row.isConnected,
          hasResponse: row.textContent?.includes(visibleResponse) ?? false,
          hasTokens: row.textContent?.includes("2.4k output tokens") ?? false,
          key: row.getAttribute("data-virtual-row-key"),
        }),
        response,
      );
      expect(streamingLayout).toEqual({
        connected: true,
        hasResponse: true,
        hasTokens: true,
        key: pendingLayout.key,
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("scrolls a delayed pending send into view before the ACK resolves", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `History message ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    const gateway = await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("History message 49").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await waitForChatScrollIdle(page);
      await expect
        .poll(
          async () => {
            await scrollChatThreadToTop(page);
            return chatThreadDistanceFromBottom(page);
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(200);

      await gateway.deferNext("chat.send");

      const prompt = `pending send should scroll before ack\n${"visible now\n".repeat(6)}`;
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await page.locator(".chat-thread").getByText("pending send should scroll").waitFor({
        timeout: 10_000,
      });
      await expect
        .poll(() => chatThreadDistanceFromBottom(page), { timeout: 10_000 })
        .toBeLessThanOrEqual(4);

      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("overlays the scroll-to-bottom affordance without shrinking the transcript", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const baseTs = Date.now() - 100_000;
    const historyMessages = Array.from({ length: 50 }, (_, index) => ({
      content: [
        {
          text: `Scrollable history ${index}\n${"extra transcript line\n".repeat(4)}`,
          type: "text",
        },
      ],
      role: index % 2 === 0 ? "assistant" : "user",
      timestamp: baseTs + index,
    }));
    await installMockGateway(page, { historyMessages });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Scrollable history 49").waitFor({ timeout: 10_000 });
      await waitForChatScrollIdle(page);

      const readLayout = () =>
        page.locator(".chat-main").evaluate((container) => {
          const thread = container.querySelector<HTMLElement>(".chat-thread");
          const composer = container.querySelector<HTMLElement>(".agent-chat__composer-shell");
          const button = container.querySelector<HTMLElement>(".chat-scroll-to-bottom");
          if (!thread || !composer) {
            throw new Error("expected chat thread and composer");
          }
          const threadRect = thread.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          const buttonRect = button?.getBoundingClientRect();
          return {
            buttonBottom: buttonRect ? Math.round(buttonRect.bottom) : null,
            composerTop: Math.round(composerRect.top),
            threadBottom: Math.round(threadRect.bottom),
          };
        });

      const before = await readLayout();
      expect(before.buttonBottom).toBeNull();

      await scrollChatThreadToTop(page);
      await page.getByRole("button", { name: "Scroll to latest" }).waitFor({ timeout: 10_000 });
      const after = await readLayout();

      expect(after.threadBottom).toBe(before.threadBottom);
      expect(after.composerTop).toBe(before.composerTop);
      expect(after.buttonBottom).not.toBeNull();
      expect(after.buttonBottom!).toBeLessThan(after.composerTop);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("refreshes history after a tool-call window disconnects and reconnects", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const prompt = "use a tool then reconnect";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await page.locator(".chat-thread").getByText(prompt).waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          args: { query: "status" },
          name: "status",
          phase: "start",
          toolCallId: "tool-1",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });
      await gateway.setHistoryMessages([
        {
          __openclaw: { idempotencyKey: `${runId}:user` },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        {
          content: [{ text: "Recovered from refreshed history.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ]);

      await gateway.closeLatest(1006, "lost during tool call");

      await page
        .locator(".chat-thread-inner")
        .getByText("Recovered from refreshed history.")
        .waitFor({ timeout: 15_000 });
      expect(await page.locator(".chat-queue").count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps live assistant stream text before the matching tool card", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      const prompt = "stream before tool";
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");

      await gateway.emitGatewayEvent("chat", {
        deltaText: "I will inspect the file.",
        message: {
          content: [{ text: "I will inspect the file.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "main",
        state: "delta",
      });
      await page.getByText("I will inspect the file.").waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          name: "read",
          phase: "result",
          result: "file contents",
          toolCallId: "call-read",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now() - 10_000,
      });
      const toolBubble = page.locator('[data-message-id^="tool:assistant:call-read"]');
      await toolBubble.waitFor({ timeout: 10_000 });

      const visibleOrder = await page.locator(".chat-thread").evaluate((thread: Element) => {
        return Array.from(thread.querySelectorAll(".chat-group")).flatMap((group: Element) => {
          const text = group.textContent ?? "";
          if (text.includes("I will inspect the file.")) {
            return ["assistant stream"];
          }
          if (group.querySelector('[data-message-id^="tool:assistant:call-read"]')) {
            return ["tool card"];
          }
          return [];
        });
      });

      expect(visibleOrder).toEqual(["assistant stream", "tool card"]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("renders a running tool at the deferred projection boundary without a reload", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox textarea").fill("show live tool work");
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      const params = requireRecord(sendRequest.params);
      const runId = requireString(params.idempotencyKey, "chat send idempotency key");
      await pauseVirtualClock(page);
      await gateway.emitGatewayEvent("agent", {
        data: {
          args: { path: "notes.txt" },
          name: "read",
          phase: "start",
          toolCallId: "call-live",
        },
        runId,
        seq: 1,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });

      await page.clock.runFor(80);
      const toolBubble = page.locator('[data-message-id^="tool:assistant:call-live"]');
      await toolBubble.locator(".chat-tool-row--running").waitFor({ timeout: 10_000 });

      await gateway.emitGatewayEvent("agent", {
        data: {
          name: "read",
          phase: "result",
          result: "file contents",
          toolCallId: "call-live",
        },
        runId,
        seq: 2,
        sessionKey: "main",
        stream: "tool",
        ts: Date.now(),
      });
      await page.clock.runFor(80);
      await expect.poll(() => toolBubble.locator(".chat-tool-row--running").count()).toBe(0);
      expect(await toolBubble.count()).toBe(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
