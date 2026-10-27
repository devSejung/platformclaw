import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import type { MockGatewayControls, MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";

const rejectedMessage =
  "This widget message could not be added to this conversation. Check that the conversation is writable, then try again.";
const draft = "Keep this unsent draft while I use the widget.";
const prompts = {
  legacy: "Summarize this widget selection using the legacy button",
  structured: "Summarize this widget selection using the structured button",
  invalid: "/approve",
  failure: "Review this widget selection after a delivery failure",
  archived: "Review this widget selection from an archived conversation",
  readonly: "Review this widget selection from a read-only conversation",
  recovery: "Review this widget selection after permissions recover",
} as const;

type PromptName = keyof typeof prompts;
type SendParams = { sessionKey: string; message: string; idempotencyKey: string; deliver: boolean };

export function canvasPromptProbeMarkup(): string {
  return `${Object.keys(prompts)
    .map(
      (name) =>
        `<button data-proof-prompt="${name}">${name} ↗</button><output data-proof-result="${name}">pending</output>`,
    )
    .join("")}
<script>
const prompts = ${JSON.stringify(prompts)};
const proofDocumentId = Date.now() + "-" + Math.random();
for (const button of document.querySelectorAll("[data-proof-prompt]")) {
  button.dataset.proofDocumentId = proofDocumentId;
  button.onclick = async () => {
    button.dataset.proofClicks = String(Number(button.dataset.proofClicks || 0) + 1);
    button.dataset.proofClickAck = proofDocumentId + ":" + button.dataset.proofClicks;
    const name = button.dataset.proofPrompt;
    const output = document.querySelector('[data-proof-result="' + name + '"]');
    output.textContent = "sending";
    try {
      if (name === "legacy") {
        window.sendPrompt(prompts[name]);
        output.textContent = "requested";
      } else {
        output.textContent = JSON.stringify(await window.openclaw.prompt.send(prompts[name]));
      }
    } catch (error) { output.textContent = "rejected:" + error.message; }
  };
}
</script>`;
}

function sendParams(request: MockGatewayRequest | undefined): SendParams {
  expect(request?.params).toEqual(
    expect.objectContaining({ sessionKey: expect.any(String), idempotencyKey: expect.any(String) }),
  );
  return request?.params as SendParams;
}

/** The VM fixture is a local filesystem mapping; real SSH proof runs separately. */
export async function exerciseCanvasPromptDelivery(params: {
  page: Page;
  gateway: MockGatewayControls;
  target: "platform_server" | "assigned_vm";
  sessionKey: string;
  historyMessages: unknown[];
  proofDir: string;
}): Promise<void> {
  const { page, gateway, sessionKey, target } = params;
  const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
  const frame = preview.frameLocator("iframe");
  const notice = preview.locator("[data-widget-prompt-status][role=alert]");
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  const frameWidth = () =>
    preview.locator("iframe").evaluate((element) => element.getBoundingClientRect().width);
  const history = [...params.historyMessages];
  let nextSeq = 4;

  const record = (phase: string, observation: Record<string, unknown>) => {
    console.info(
      "canvas-prompt-proof",
      JSON.stringify({
        target,
        vmTransport: target === "assigned_vm" ? "mapped-host-bridge" : "none",
        phase,
        ...observation,
      }),
    );
  };
  const snapshot = (name: string) =>
    page.screenshot({ path: path.join(params.proofDir, `${target}-${name}.png`), fullPage: true });
  const clickPrompt = async (name: PromptName) => {
    const button = frame.locator(`[data-proof-prompt="${name}"]`);
    const observation = () =>
      button.evaluate((element) => ({
        documentId: element.getAttribute("data-proof-document-id"),
        clicks: Number(element.getAttribute("data-proof-clicks") ?? 0),
        ack: element.getAttribute("data-proof-click-ack"),
      }));
    // Composer access changes can move the outer frame while its inner button
    // remains stable. Wait for both pointing surfaces before the one real click.
    await button.scrollIntoViewIfNeeded();
    const outerFrame = await preview.locator("iframe").elementHandle();
    if (!outerFrame) {
      throw new Error("Canvas iframe disappeared before the widget click");
    }
    try {
      await outerFrame.waitForElementState("stable");
    } finally {
      await outerFrame.dispose();
    }
    const before = await observation();
    await button.click();
    // Each iframe document owns its click counter; native locator actionability
    // may resolve a replacement document before dispatching this click.
    await expect
      .poll(async () => {
        const current = await observation();
        const expectedClicks = current.documentId === before.documentId ? before.clicks + 1 : 1;
        return (
          Boolean(current.documentId && current.ack) &&
          current.ack !== before.ack &&
          current.clicks === expectedClicks &&
          current.ack === `${current.documentId}:${expectedClicks}`
        );
      })
      .toBe(true);
  };
  const complete = async (request: SendParams, result: string) => {
    history.push(
      {
        role: "user",
        content: [{ type: "text", text: request.message }],
        __openclaw: {
          id: `${request.idempotencyKey}-user`,
          idempotencyKey: `${request.idempotencyKey}:user`,
          seq: nextSeq++,
        },
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: result }],
        __openclaw: { id: `${request.idempotencyKey}-assistant`, seq: nextSeq++ },
        timestamp: Date.now(),
      },
    );
    await gateway.setHistoryMessages(history);
    await gateway.emitChatFinal({ runId: request.idempotencyKey, sessionKey, text: result });
    await page.locator(".chat-thread-inner").getByText(result, { exact: true }).waitFor();
  };
  const clickAndAdmit = async (name: PromptName): Promise<SendParams> => {
    // A rendered final reply can precede the sending/run projection settling.
    // This scenario proves a new idle turn, so wait for its real composer action.
    await expect
      .poll(async () => {
        const send = page.getByRole("button", { name: "Send message", exact: true });
        return (
          (await page.locator(".chat-send-btn--stop:visible").count()) === 0 &&
          (await send.count()) === 1 &&
          (await send.isVisible()) &&
          (await send.isEnabled())
        );
      })
      .toBe(true);
    const before = (await gateway.getRequests("chat.send")).length;
    await gateway.deferNext("chat.send");
    await clickPrompt(name);
    await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(before + 1);
    const request = sendParams((await gateway.getRequests("chat.send")).at(-1));
    expect(request).toMatchObject({ sessionKey, message: prompts[name], deliver: false });
    await expect
      .poll(() => frame.locator(`[data-proof-result="${name}"]`).textContent())
      .toBe(name === "legacy" ? "requested" : "true");
    await page.locator(".chat-group.user", { hasText: prompts[name] }).waitFor();
    expect(await composer.inputValue()).toBe(draft);
    await notice.waitFor({ state: "hidden" });
    record(name, { requestCount: 1, sessionKey: request.sessionKey, draftPreserved: true });
    return request;
  };
  const rejectClick = async (name: "invalid" | "archived" | "readonly" | "legacy") => {
    const before = (await gateway.getRequests("chat.send")).length;
    await clickPrompt(name);
    if (name !== "legacy") {
      await expect
        .poll(() => frame.locator(`[data-proof-result="${name}"]`).textContent())
        .toBe("false");
    }
    await notice.waitFor({ state: "visible" });
    expect((await notice.textContent())?.trim()).toBe(rejectedMessage);
    expect(await gateway.getRequests("chat.send")).toHaveLength(before);
    record(name, {
      requestCount: 0,
      accepted: name === "legacy" ? "void API" : false,
      visibleOutcome: rejectedMessage,
    });
  };

  // Finish the existing upload proof before starting widget actions, so a busy
  // prior run cannot silently change this test into queued follow-up coverage.
  await complete(sendParams((await gateway.getRequests("chat.send")).at(-1)), "Upload reviewed.");
  await composer.fill(draft);
  await snapshot("before-click");
  for (const name of ["legacy", "structured"] as const) {
    const request = await clickAndAdmit(name);
    await gateway.resolveDeferred("chat.send");
    await complete(request, `${target}: ${name} selection reviewed.`);
    expect(
      await page.locator(".chat-group.user .chat-bubble", { hasText: prompts[name] }).count(),
    ).toBe(1);
  }
  await snapshot("sent");
  const widthBeforeRejection = await frameWidth();
  await rejectClick("invalid");
  expect(await frameWidth()).toBeCloseTo(widthBeforeRejection, 0);
  await snapshot("invalid-rejected");

  const failedRequest = await clickAndAdmit("failure");
  await gateway.rejectDeferred("chat.send", {
    code: "UNAVAILABLE",
    message: "Canvas proof delivery was rejected",
  });
  const failedRow = page.locator(".chat-queue__item--failed", { hasText: prompts.failure });
  await failedRow.locator(".chat-queue__retry").waitFor({ state: "visible" });
  await expect
    .poll(() => failedRow.locator(".chat-queue__error").textContent())
    .toContain("Canvas proof delivery was rejected");
  await snapshot("retry-ready");
  const beforeRetry = (await gateway.getRequests("chat.send")).length;
  await gateway.deferNext("chat.send");
  await failedRow.locator(".chat-queue__retry").click();
  await expect
    .poll(async () => (await gateway.getRequests("chat.send")).length)
    .toBe(beforeRetry + 1);
  const retriedRequest = sendParams((await gateway.getRequests("chat.send")).at(-1));
  expect(retriedRequest).toMatchObject({ sessionKey, message: failedRequest.message });
  await gateway.resolveDeferred("chat.send");
  await complete(retriedRequest, `${target}: retry delivered once.`);
  await failedRow.waitFor({ state: "detached" });
  expect(
    await page.locator(".chat-group.user .chat-bubble", { hasText: prompts.failure }).count(),
  ).toBe(1);
  expect(await gateway.getRequests("chat.send")).toHaveLength(beforeRetry + 1);
  record("retried", {
    requestCount: 1,
    visibleUserMessages: 1,
    draftPreserved: (await composer.inputValue()) === draft,
  });

  const setSessionAccess = async (archived: boolean, viewer = false) => {
    const row = {
      key: sessionKey,
      kind: "direct",
      updatedAt: Date.now(),
      archived,
      visibility: "private",
      sharingRole: viewer ? "viewer" : "owner",
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
    };
    await gateway.setMethodResponse("sessions.describe", { session: row });
    await gateway.setMethodResponse("chat.history", {
      messages: history,
      sessionId: "control-ui-e2e-session",
      thinkingLevel: null,
      sessionInfo: row,
    });
    await gateway.setMethodResponse("sessions.list", {
      sessions: [row],
      count: 1,
      ts: Date.now(),
      defaults: { model: "gpt-5.5", modelProvider: "openai", contextTokens: null },
    });
    await gateway.emitGatewayEvent("sessions.changed", { ...row, sessionKey, reason: "update" });
    if (archived) {
      await page.locator(".agent-chat__disabled-banner").waitFor({ state: "visible" });
    } else if (viewer) {
      await page.locator(".agent-chat__disabled-reason").waitFor({ state: "visible" });
      await expect.poll(() => composer.isEnabled()).toBe(false);
    } else {
      await composer.waitFor({ state: "visible" });
      await expect.poll(() => composer.isEnabled()).toBe(true);
    }
  };
  await setSessionAccess(true);
  await rejectClick("legacy");
  await rejectClick("archived");
  await snapshot("archived-rejected");
  await setSessionAccess(false, true);
  await rejectClick("readonly");
  await snapshot("readonly-rejected");
  await setSessionAccess(false);
  expect(await composer.inputValue()).toBe(draft);
  const recovery = await clickAndAdmit("recovery");
  await gateway.resolveDeferred("chat.send");
  await complete(recovery, `${target}: writable conversation recovered.`);
  await snapshot("recovered");
}
