import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import { createSandboxFsBridge } from "../../../src/agents/sandbox/fs-bridge.js";
import { createSandboxFsBridgeFromResolver } from "../../../src/agents/test-helpers/host-sandbox-fs-bridge.js";
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

/** VM filesystem mapping exercises the bridge contract; real SSH proof runs separately. */
export function createCanvasExecutionBridge(params: {
  target: "platform_server" | "assigned_vm";
  workspaceDir: string;
  agentWorkspaceDir: string;
}) {
  if (params.target === "platform_server") {
    return createSandboxFsBridge({
      sandbox: {
        workspaceDir: params.workspaceDir,
        agentWorkspaceDir: params.agentWorkspaceDir,
        workspaceAccess: "rw",
        containerName: "canvas-e2e-unused",
        containerWorkdir: "/workspace",
        docker: {},
      },
    });
  }
  return createSandboxFsBridgeFromResolver((filePath, cwd) => {
    const remoteCwd = cwd?.startsWith("/workspace") ? cwd : "/workspace";
    const containerPath = path.posix.resolve(remoteCwd, filePath);
    if (containerPath !== "/workspace" && !containerPath.startsWith("/workspace/")) {
      throw new Error("escapes assigned VM workspace");
    }
    const relativePath = path.posix.relative("/workspace", containerPath);
    return {
      hostPath: path.join(params.workspaceDir, ...relativePath.split("/").filter(Boolean)),
      relativePath,
      containerPath,
    };
  });
}

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

/** Render the real managed snapshot response, including its production response CSP. */
export async function exerciseHtmlAttachmentPreview(params: {
  page: Page;
  gateway: MockGatewayControls;
  target: "platform_server" | "assigned_vm";
  label: string;
  phase: "initial" | "reloaded";
  proofDir: string;
  navigationUrl: string;
  navigationRequestBaseline: number;
  getNavigationRequestCount: () => number;
}): Promise<void> {
  const { page, gateway, target, label, phase, proofDir } = params;
  const sendsBeforePreview = (await gateway.getRequests("chat.send")).length;
  const attachment = page.locator("openclaw-chat-html-attachment");
  if (phase === "initial") {
    await attachment.getByRole("button", { name: "Preview HTML", exact: true }).waitFor();
    await attachment.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(proofDir, `${target}-html-preview-before.png`),
      fullPage: true,
    });
  }
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.pathname.startsWith("/api/chat/media/outgoing/") &&
        url.searchParams.get("preview") === "1"
      );
    }),
    attachment.getByRole("button", { name: "Preview HTML", exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toBe("inline");
  expect(response.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
  expect(response.headers()["content-security-policy"]).toContain("connect-src 'none'");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(response.headers()["content-security-policy"]).toContain("frame-src about:");
  const iframe = attachment.locator(".chat-html-attachment__frame");
  await iframe.waitFor({ state: "visible" });
  expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");
  const source = new URL((await iframe.getAttribute("src")) ?? "", page.url());
  expect(source.origin).toBe(new URL(page.url()).origin);
  expect(source.searchParams.get("previewNonce")).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
  expect(source.searchParams.get("previewMode")).toBe("scripts");
  const outer = attachment.frameLocator("iframe");
  expect(await outer.locator("iframe").getAttribute("sandbox")).toBe("allow-scripts");
  const document = outer.frameLocator("iframe");
  expect(
    await document.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"),
  ).toContain("frame-src 'none'");
  await expect
    .poll(() => document.locator(`[data-proof-target="${target}"]`).textContent())
    .toContain(label);
  await document.locator("[data-proof-svg]").waitFor({ state: "visible" });
  await expect
    .poll(() =>
      document.locator("[data-proof-chart]").evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement)) {
          return false;
        }
        const initializedWidth = Number(element.getAttribute("data-proof-init-width"));
        return (
          initializedWidth > 0 &&
          initializedWidth === element.width &&
          initializedWidth === window.document.documentElement.clientWidth
        );
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      document
        .locator("[data-proof-svg-use]")
        .evaluate((element) =>
          element instanceof SVGGraphicsElement ? element.getBBox().width : 0,
        ),
    )
    .toBe(20);
  await document.locator("[data-proof-fragment]").click();
  await expect
    .poll(() => document.locator("body").evaluate(() => window.location.href))
    .toBe("about:srcdoc#preview-details");
  expect(await document.locator("[data-proof-details]").textContent()).toBe("Saved report details");
  for (const selector of [
    "[data-proof-image]",
    "[data-proof-blob-image]",
    "[data-proof-entity-image]",
  ]) {
    await expect
      .poll(() =>
        document
          .locator(selector)
          .evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
      )
      .toBe(1);
  }
  expect(await document.locator("[data-proof-entity-data]").getAttribute("data-chart")).toBe(
    "&copy;",
  );
  expect(await document.locator("[data-proof-relative-image]").count()).toBe(0);
  expect(
    await document
      .getByText("[Image unavailable in this isolated preview]", { exact: true })
      .count(),
  ).toBe(1);
  await expect
    .poll(() => document.locator("[data-openclaw-html-preview-notice]").textContent())
    .toContain("Some local or external assets cannot be shown");
  const isolation = await document.locator("body").evaluate(() => {
    let parentDenied = false;
    try {
      void window.parent.document;
    } catch {
      parentDenied = true;
    }
    return {
      parentDenied,
      promptApi: typeof Reflect.get(window, "sendPrompt"),
      widgetApi: typeof Reflect.get(window, "openclaw"),
      authoredScriptRan: Reflect.get(window, "htmlPreviewAuthoredScriptRan") === true,
      brokenImages: [...window.document.images].filter(
        (image) => !image.complete || image.naturalWidth === 0,
      ).length,
    };
  });
  expect(isolation).toEqual({
    parentDenied: true,
    promptApi: "undefined",
    widgetApi: "undefined",
    authoredScriptRan: true,
    brokenImages: 0,
  });
  await iframe.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(proofDir, `${target}-html-preview-${phase}.png`),
    fullPage: true,
  });

  // Chromium may replace a CSP-blocked child with an error document. The trusted
  // outer shell must turn that non-outcome into a visible error, never a blank frame.
  expect(new URL(params.navigationUrl).pathname).toBe("/blocked-navigation");
  await document.locator("[data-proof-navigation]").click();
  await expect
    .poll(() => attachment.locator('[role="status"]').textContent())
    .toContain("Navigation is unavailable in this isolated preview");
  await iframe.waitFor({ state: "detached" });
  expect(params.getNavigationRequestCount()).toBe(params.navigationRequestBaseline);
  expect(await attachment.locator("a").first().getAttribute("href")).not.toContain("preview=1");
  expect(await attachment.locator("a").first().getAttribute("href")).toContain(source.pathname);
  await page.screenshot({
    path: path.join(proofDir, `${target}-html-preview-${phase}-navigation-blocked.png`),
    fullPage: true,
  });
  await attachment.getByRole("button", { name: "Close preview", exact: true }).click();
  const [recoveredResponse] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return url.pathname === source.pathname && url.searchParams.get("preview") === "1";
    }),
    attachment.getByRole("button", { name: "Preview HTML", exact: true }).click(),
  ]);
  expect(recoveredResponse.status()).toBe(200);
  await iframe.waitFor({ state: "visible" });
  const recoveredSource = new URL((await iframe.getAttribute("src")) ?? "", page.url());
  expect(recoveredSource.searchParams.get("previewNonce")).not.toBe(
    source.searchParams.get("previewNonce"),
  );
  await document.getByRole("heading", { name: label, exact: true }).waitFor();
  await expect
    .poll(() =>
      document
        .locator("[data-proof-entity-image]")
        .evaluate((element) =>
          element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
        ),
    )
    .toBe(1);
  expect(params.getNavigationRequestCount()).toBe(params.navigationRequestBaseline);
  await page.screenshot({
    path: path.join(proofDir, `${target}-html-preview-${phase}-recovered.png`),
    fullPage: true,
  });
  const [strictResponse] = await Promise.all([
    page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.pathname.startsWith("/api/chat/media/outgoing/") &&
        url.searchParams.get("preview") === "1" &&
        url.searchParams.get("previewMode") === "strict"
      );
    }),
    attachment.evaluate((element) => {
      Reflect.set(element, "embedSandboxMode", "strict");
    }),
  ]);
  expect(strictResponse.status()).toBe(200);
  await iframe.waitFor({ state: "visible" });
  const strictSource = new URL((await iframe.getAttribute("src")) ?? "", page.url());
  expect(strictSource.searchParams.get("previewMode")).toBe("strict");
  expect(strictSource.searchParams.get("previewNonce")).not.toBe(
    source.searchParams.get("previewNonce"),
  );
  const strictDocument = attachment.frameLocator("iframe").frameLocator("iframe");
  expect(
    await strictDocument
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content"),
  ).toContain("script-src 'nonce-");
  await strictDocument.getByRole("heading", { name: label, exact: true }).waitFor();
  expect(
    await strictDocument.locator("[data-proof-chart]").getAttribute("data-proof-init-width"),
  ).toBeNull();
  await expect
    .poll(() =>
      strictDocument
        .locator("[data-proof-svg-use]")
        .evaluate((element) =>
          element instanceof SVGGraphicsElement ? element.getBBox().width : 0,
        ),
    )
    .toBe(20);
  await strictDocument.locator("[data-proof-fragment]").click();
  await expect
    .poll(() => strictDocument.locator("body").evaluate(() => window.location.href))
    .toBe("about:srcdoc#preview-details");
  expect(await strictDocument.locator("[data-proof-details]").textContent()).toBe(
    "Saved report details",
  );
  await expect
    .poll(() =>
      strictDocument
        .locator("[data-proof-image]")
        .evaluate((element) =>
          element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
        ),
    )
    .toBe(1);
  await expect
    .poll(() =>
      strictDocument
        .locator("[data-proof-entity-image]")
        .evaluate((element) =>
          element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
        ),
    )
    .toBe(1);
  expect(await strictDocument.locator("[data-proof-entity-data]").getAttribute("data-chart")).toBe(
    "&copy;",
  );
  expect(await strictDocument.locator("[data-proof-blob-image]").count()).toBe(0);
  expect(
    await strictDocument
      .getByText("[Image unavailable in this isolated preview]", { exact: true })
      .count(),
  ).toBe(2);
  expect(
    await strictDocument
      .locator("body")
      .evaluate(
        () =>
          [...window.document.images].filter((image) => !image.complete || image.naturalWidth === 0)
            .length,
      ),
  ).toBe(0);
  expect(
    await strictDocument
      .locator("body")
      .evaluate(() => typeof Reflect.get(window, "htmlPreviewAuthoredScriptRan")),
  ).toBe("undefined");
  await strictDocument.locator("[data-proof-navigation]").click();
  expect(await strictDocument.locator("[data-proof-navigation-result]").textContent()).toBe("idle");
  await page.screenshot({
    path: path.join(proofDir, `${target}-html-preview-${phase}-strict.png`),
    fullPage: true,
  });
  await attachment.getByRole("button", { name: "Close preview", exact: true }).click();
  await iframe.waitFor({ state: "detached" });
  expect(await gateway.getRequests("chat.send")).toHaveLength(sendsBeforePreview);
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
    // Reveal the frame before waiting on its child's animation frames; Chromium
    // throttles offscreen frames. Access changes can also move the outer frame.
    await preview.locator("iframe").scrollIntoViewIfNeeded();
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
