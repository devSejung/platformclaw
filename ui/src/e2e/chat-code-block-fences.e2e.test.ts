import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  copiedViaExec,
  createChatFlowE2eSuite,
  installMockGateway,
  installPlainHttpClipboardCapture,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "streaming-code-fences");

suite.define(() => {
  it("highlights a streamed code fence only after its closing marker arrives", async () => {
    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
    }
    const viewport = { height: 900, width: 1280 };
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureUiProofEnabled ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    await installPlainHttpClipboardCapture(page);

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("chat.send");
      await page.locator(".agent-chat__composer-combobox textarea").fill("show TypeScript");
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(proofDir, "01-prompt.png") });
      }
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId = requireString(
        requireRecord(sendRequest.params).idempotencyKey,
        "chat send idempotency key",
      );
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      const source = "const value = 1 < 2;";
      const openFence = `\`\`\`ts\n${source}`;
      const emitDelta = async (text: string, deltaText: string) => {
        await gateway.emitGatewayEvent("chat", {
          deltaText,
          message: {
            content: [{ text, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
          runId,
          sessionKey: "main",
          state: "delta",
        });
      };

      await emitDelta(openFence, openFence);
      const streamingCode = page.locator(".chat-bubble.streaming code.language-ts");
      await expect.poll(() => streamingCode.textContent()).toContain(source);
      expect(await streamingCode.locator("span").count()).toBe(0);
      expect(await streamingCode.evaluate((code) => code.classList.contains("hljs"))).toBe(false);
      await page.locator(".chat-bubble.streaming .code-block-copy").click();
      expect(await copiedViaExec(page)).toEqual([source]);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(proofDir, "02-open-unhighlighted.png") });
      }

      const completedFence = `${openFence}\n\`\`\``;
      await emitDelta(completedFence, "\n```");
      await expect.poll(() => streamingCode.getAttribute("class")).toContain("hljs");
      expect(await streamingCode.locator("span").count()).toBeGreaterThan(0);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(proofDir, "03-closed-highlighted.png") });
      }

      await gateway.emitChatFinal({ runId, text: completedFence });
      await expect.poll(() => page.locator(".chat-bubble.streaming").count()).toBe(0);
      expect(await page.locator(".chat-thread code.language-ts.hljs").count()).toBe(1);
      if (captureUiProofEnabled) {
        await page.screenshot({ path: path.join(proofDir, "04-final.png") });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
