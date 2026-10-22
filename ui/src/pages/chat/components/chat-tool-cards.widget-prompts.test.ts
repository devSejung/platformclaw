/* @vitest-environment jsdom */
// Covers the interactive-widget prompt channel: offer adoption, text
// validation, rate limiting, user-interaction gating, and external-embed
// rejection — all through the real port + DOM event path.

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import {
  renderToolPreview,
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "./chat-tool-cards.ts";

const containers = new Set<HTMLElement>();
const ports = new Set<MessagePort>();
const schedulePortTask = globalThis.setTimeout;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const port of ports) {
    port.close();
  }
  ports.clear();
  for (const container of containers) {
    container.remove();
  }
  containers.clear();
});

function renderWidgetPreviewFrame(url: string, allowExternalEmbedUrls = false) {
  const container = document.createElement("div");
  containers.add(container);
  document.body.append(container);
  const rerender = () =>
    render(
      renderToolPreview(
        {
          kind: "canvas",
          surface: "assistant_message",
          render: "url",
          viewId: "cv_prompt",
          url,
        },
        "chat_message",
        allowExternalEmbedUrls ? { allowExternalEmbedUrls } : {},
      ),
      container,
    );
  rerender();
  const frame = container.querySelector("iframe");
  expect(frame).not.toBeNull();
  expect(frame!.contentWindow).not.toBeNull();
  return { container, frame: frame!, rerender };
}

function offerPromptPort(frame: HTMLIFrameElement): MessagePort {
  const channel = new MessageChannel();
  ports.add(channel.port1);
  ports.add(channel.port2);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "openclaw:widget-prompt-offer" },
      origin: "null",
      source: frame.contentWindow,
      ports: [channel.port2],
    }),
  );
  return channel.port1;
}

function postPrompt(port: MessagePort, prompt: unknown, id?: unknown) {
  port.postMessage({ type: "openclaw:widget-prompt", prompt, ...(id === undefined ? {} : { id }) });
}

function collectHostMessages(port: MessagePort): unknown[] {
  const messages: unknown[] = [];
  port.addEventListener("message", (event) => messages.push(event.data));
  port.start();
  return messages;
}

function promptStatus(container: HTMLElement): HTMLElement {
  const status = container.querySelector<HTMLElement>("[data-widget-prompt-status]");
  expect(status).not.toBeNull();
  return status!;
}

async function flushPorts() {
  // Port delivery may take more than one macrotask on loaded CI workers.
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => {
      schedulePortTask(resolve, 0);
    });
  }
}

function emulateInteractableFrame(frame: HTMLIFrameElement) {
  // jsdom has no layout and cannot focus iframes; emulate a visible frame the
  // user clicked into, which is what the host checks require.
  (frame as HTMLIFrameElement & { checkVisibility: () => boolean }).checkVisibility = () => true;
  vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
}

function collectPromptEvents(container: HTMLElement): string[] {
  const received: string[] = [];
  container.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
    const detail = (event as CustomEvent<WidgetPromptEventDetail>).detail;
    received.push(detail.text);
    detail.respondWith(Promise.resolve(true));
  });
  return received;
}

function restoreActiveElement() {
  vi.restoreAllMocks();
}

describe("widget prompts", () => {
  function delayFrameFocus(frame: HTMLIFrameElement) {
    const schedule = window.setTimeout;
    const clear = window.clearTimeout;
    const view = frame.contentWindow!.parent;
    // Vitest rewrites defaultView to its Node global, while jsdom dispatches
    // Window events on the real DOM Window. Keep browser identity and the
    // test's real/fake scheduler together without changing the host guard.
    vi.spyOn(view, "setTimeout").mockImplementation(schedule);
    vi.spyOn(view, "clearTimeout").mockImplementation(clear);
    vi.spyOn(document, "defaultView", "get").mockReturnValue(
      view as NonNullable<Document["defaultView"]>,
    );
    const input = document.createElement("textarea");
    frame.parentElement!.append(input);
    let active: Element = input;
    frame.checkVisibility = () => true;
    vi.spyOn(document, "activeElement", "get").mockImplementation(() => active);
    return {
      focusFrame: () => {
        // Window capture also sees the textarea's nonbubbling blur while
        // activeElement is BODY; only the later window event confirms focus.
        active = document.body;
        input.dispatchEvent(new FocusEvent("blur"));
        active = frame;
        // Chromium can notify the parent with window blur after the child's
        // private-port message, without an iframe focusin event.
        view.dispatchEvent(new Event("blur"));
      },
    };
  }

  it("admits a private-port prompt after the parent's delayed window-blur focus notification", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_focus_handoff/index.html",
    );
    const port = offerPromptPort(frame);
    const messages = collectHostMessages(port);
    frame.dispatchEvent(new Event("load"));
    const { focusFrame } = delayFrameFocus(frame);
    const received = collectPromptEvents(container);

    postPrompt(port, "Show details", "delayed-focus");
    await flushPorts();
    expect(received).toEqual([]);
    expect(messages).toEqual([{ type: "openclaw:widget-prompt-host-ready" }]);
    focusFrame();
    await flushPorts();

    expect(received).toEqual(["Show details"]);
    expect(messages).toContainEqual({
      type: "openclaw:widget-prompt-response",
      id: "delayed-focus",
      accepted: true,
    });
    expect(promptStatus(container).hidden).toBe(true);
  });

  it("expires an unfocused request so a later click cannot replay it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_focus_expiry/index.html",
    );
    const port = offerPromptPort(frame);
    const messages = collectHostMessages(port);
    frame.dispatchEvent(new Event("load"));
    const { focusFrame } = delayFrameFocus(frame);
    const received = collectPromptEvents(container);

    postPrompt(port, "Expired selection", "expired-focus");
    await flushPorts();
    await vi.advanceTimersByTimeAsync(2_001);
    await flushPorts();
    focusFrame();
    await flushPorts();

    expect(received).toEqual([]);
    expect(messages).toContainEqual({
      type: "openclaw:widget-prompt-response",
      id: "expired-focus",
      accepted: false,
    });
    expect(promptStatus(container).getAttribute("role")).toBe("alert");
  });

  it("checks the monotonic expiry even when the cleanup timer has not run", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_focus_late_timer/index.html",
    );
    const port = offerPromptPort(frame);
    const messages = collectHostMessages(port);
    frame.dispatchEvent(new Event("load"));
    const { focusFrame } = delayFrameFocus(frame);
    const received = collectPromptEvents(container);

    postPrompt(port, "Expired before cleanup", "expired-before-timer");
    await flushPorts();
    now.mockReturnValue(2_101);
    focusFrame();
    await flushPorts();

    expect(received).toEqual([]);
    expect(messages).toContainEqual({
      type: "openclaw:widget-prompt-response",
      id: "expired-before-timer",
      accepted: false,
    });
  });

  it.each([
    "detach",
    "shadow-host-detach",
    "load",
    "src",
    "sandbox",
    "generation",
    "pointerdown",
    "keydown",
    "pagehide",
  ] as const)("cancels a pending focus handoff on %s before later focus", async (reason) => {
    const { container, frame } = renderWidgetPreviewFrame(
      `/__openclaw__/canvas/documents/cv_focus_cancel_${reason}/index.html`,
    );
    let shadowHost: HTMLElement | undefined;
    if (reason === "shadow-host-detach") {
      shadowHost = document.createElement("div");
      containers.add(shadowHost);
      document.body.append(shadowHost);
      shadowHost.attachShadow({ mode: "open" }).append(container);
      expect(frame.contentWindow).not.toBeNull();
    }
    const port = offerPromptPort(frame);
    const messages = collectHostMessages(port);
    frame.dispatchEvent(new Event("load"));
    const { focusFrame } = delayFrameFocus(frame);
    const received = collectPromptEvents(container);

    postPrompt(port, "Canceled selection", "canceled-focus");
    await flushPorts();
    if (reason === "detach") {
      container.remove();
    } else if (reason === "shadow-host-detach") {
      shadowHost!.remove();
    } else if (reason === "generation") {
      bumpCanvasWidgetFrameConnectionGeneration();
    } else if (reason === "src" || reason === "sandbox") {
      frame.setAttribute(reason, reason === "src" ? "/replacement.html" : "");
    } else if (reason === "load") {
      frame.dispatchEvent(new Event("load"));
    } else if (reason === "pagehide") {
      window.dispatchEvent(new Event("pagehide"));
    } else {
      document.dispatchEvent(new Event(reason, { bubbles: true }));
    }
    await flushPorts();
    focusFrame();
    await flushPorts();

    expect(received).toEqual([]);
    expect(
      messages.filter((message) => (message as { id?: string }).id === "canceled-focus"),
    ).toEqual([{ type: "openclaw:widget-prompt-response", id: "canceled-focus", accepted: false }]);
  });

  it("retains only the latest pending request for a frame", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_focus_replace/index.html",
    );
    const port = offerPromptPort(frame);
    const messages = collectHostMessages(port);
    frame.dispatchEvent(new Event("load"));
    const { focusFrame } = delayFrameFocus(frame);
    const received = collectPromptEvents(container);

    postPrompt(port, "Older selection", "older-focus");
    await flushPorts();
    postPrompt(port, "Latest selection", "latest-focus");
    await flushPorts();
    focusFrame();
    await flushPorts();

    expect(received).toEqual(["Latest selection"]);
    expect(messages).toContainEqual({
      type: "openclaw:widget-prompt-response",
      id: "older-focus",
      accepted: false,
    });
    expect(messages).toContainEqual({
      type: "openclaw:widget-prompt-response",
      id: "latest-focus",
      accepted: true,
    });
  });

  it.each(["src", "sandbox", "load", "generation"] as const)(
    "rejects a %s change after focus notification but before asynchronous dispatch",
    async (change) => {
      const { container, frame } = renderWidgetPreviewFrame(
        `/__openclaw__/canvas/documents/cv_focus_changed_${change}/index.html`,
      );
      const port = offerPromptPort(frame);
      const messages = collectHostMessages(port);
      frame.dispatchEvent(new Event("load"));
      const { focusFrame } = delayFrameFocus(frame);
      const received = collectPromptEvents(container);

      postPrompt(port, "Changed document selection", "changed-focus");
      await flushPorts();
      // This listener runs after the owner's focus observer resolves. The
      // awaiting continuation must revalidate the document before dispatch.
      window.addEventListener(
        "blur",
        () => {
          if (change === "load") {
            frame.dispatchEvent(new Event("load"));
          } else if (change === "generation") {
            bumpCanvasWidgetFrameConnectionGeneration();
          } else {
            frame.setAttribute(change, change === "src" ? "/replacement.html" : "");
          }
        },
        { once: true },
      );
      focusFrame();
      await flushPorts();

      expect(received).toEqual([]);
      expect(messages).toContainEqual({
        type: "openclaw:widget-prompt-response",
        id: "changed-focus",
        accepted: false,
      });
    },
  );

  it("returns the private request id only after the owning chat admits the message", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_admission/index.html",
    );
    const port = offerPromptPort(frame);
    const messages = collectHostMessages(port);
    frame.dispatchEvent(new Event("load"));
    emulateInteractableFrame(frame);
    let admit!: (value: boolean) => void;
    const admission = new Promise<boolean>((resolve) => {
      admit = resolve;
    });
    const owner = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<WidgetPromptEventDetail>).detail;
      expect(detail.text).toBe("Show details");
      detail.respondWith(admission);
    });
    container.addEventListener(WIDGET_PROMPT_EVENT, owner);

    postPrompt(port, "  Show details  ", "request-accepted");
    await flushPorts();
    expect(owner).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ type: "openclaw:widget-prompt-host-ready" }]);
    const status = promptStatus(container);
    expect(status.hidden).toBe(false);
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).not.toBe("");

    admit(true);
    await flushPorts();
    expect(messages).toEqual([
      { type: "openclaw:widget-prompt-host-ready" },
      { type: "openclaw:widget-prompt-response", id: "request-accepted", accepted: true },
    ]);
    expect(status.hidden).toBe(true);
    expect(status.textContent).toBe("");
  });

  it.each(["refused", "no owner", "invalid", "owner failure"] as const)(
    "returns false and a visible outcome for %s messages",
    async (kind) => {
      const { container, frame } = renderWidgetPreviewFrame(
        `/__openclaw__/canvas/documents/cv_rejected_${kind.replaceAll(" ", "_")}/index.html`,
      );
      const port = offerPromptPort(frame);
      const messages = collectHostMessages(port);
      frame.dispatchEvent(new Event("load"));
      emulateInteractableFrame(frame);
      const owner = vi.fn((event: Event) => {
        const detail = (event as CustomEvent<WidgetPromptEventDetail>).detail;
        detail.respondWith(
          kind === "owner failure"
            ? Promise.reject(new Error("private storage failure"))
            : Promise.resolve(false),
        );
      });
      if (kind !== "no owner") {
        container.addEventListener(WIDGET_PROMPT_EVENT, owner);
      }

      postPrompt(port, kind === "invalid" ? "/approve" : "Show details", "request-rejected");
      await flushPorts();

      expect(owner).toHaveBeenCalledTimes(kind === "no owner" || kind === "invalid" ? 0 : 1);
      expect(messages).toEqual([
        { type: "openclaw:widget-prompt-host-ready" },
        { type: "openclaw:widget-prompt-response", id: "request-rejected", accepted: false },
      ]);
      const status = promptStatus(container);
      expect(status.hidden).toBe(false);
      expect(status.getAttribute("role")).toBe("alert");
      expect(status.textContent).not.toBe("");
      expect(status.textContent).not.toContain("private storage failure");
      expect(status.querySelector("*")).toBeNull();
    },
  );

  it("preserves a rejection through rerender and clears it after a later admission", async () => {
    const { container, frame, rerender } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_retry/index.html",
    );
    const port = offerPromptPort(frame);
    const messages = collectHostMessages(port);
    frame.dispatchEvent(new Event("load"));
    emulateInteractableFrame(frame);
    let accepted = false;
    container.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
      (event as CustomEvent<WidgetPromptEventDetail>).detail.respondWith(Promise.resolve(accepted));
    });

    postPrompt(port, "Show details", "first");
    await flushPorts();
    const status = promptStatus(container);
    const rejection = status.textContent;
    expect(status.hidden).toBe(false);
    expect(status.getAttribute("role")).toBe("alert");

    rerender();
    expect(container.querySelector("iframe")).toBe(frame);
    expect(promptStatus(container)).toBe(status);
    expect(status.hidden).toBe(false);
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.textContent).toBe(rejection);

    accepted = true;
    postPrompt(port, "Show details", "second");
    await flushPorts();
    expect(messages).toContainEqual({
      type: "openclaw:widget-prompt-response",
      id: "second",
      accepted: true,
    });
    expect(status.hidden).toBe(true);
    expect(status.textContent).toBe("");
  });

  it("does not show a late rejection after the widget detaches", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_detached/index.html",
    );
    const port = offerPromptPort(frame);
    frame.dispatchEvent(new Event("load"));
    emulateInteractableFrame(frame);
    let refuse!: (value: boolean) => void;
    const admission = new Promise<boolean>((resolve) => {
      refuse = resolve;
    });
    container.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
      (event as CustomEvent<WidgetPromptEventDetail>).detail.respondWith(admission);
    });
    postPrompt(port, "Show details", "detached");
    await flushPorts();
    const status = promptStatus(container);
    expect(status.getAttribute("role")).toBe("status");
    const pendingText = status.textContent;

    container.remove();
    refuse(false);
    await flushPorts();
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe(pendingText);
  });

  it.each([
    { olderAccepted: true, newerAccepted: false },
    { olderAccepted: false, newerAccepted: true },
  ])(
    "keeps the latest outcome when older=$olderAccepted completes after newer=$newerAccepted",
    async ({ olderAccepted, newerAccepted }) => {
      const { container, frame } = renderWidgetPreviewFrame(
        `/__openclaw__/canvas/documents/cv_order_${olderAccepted}/index.html`,
      );
      const port = offerPromptPort(frame);
      const messages = collectHostMessages(port);
      frame.dispatchEvent(new Event("load"));
      emulateInteractableFrame(frame);
      let finishOlder!: (value: boolean) => void;
      const olderAdmission = new Promise<boolean>((resolve) => {
        finishOlder = resolve;
      });
      container.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
        const detail = (event as CustomEvent<WidgetPromptEventDetail>).detail;
        detail.respondWith(
          detail.text === "Older selection" ? olderAdmission : Promise.resolve(newerAccepted),
        );
      });

      postPrompt(port, "Older selection", "older");
      await flushPorts();
      expect(promptStatus(container).getAttribute("role")).toBe("status");
      postPrompt(port, "Newer selection", "newer");
      await flushPorts();
      const status = promptStatus(container);
      expect(status.hidden).toBe(newerAccepted);
      expect(status.getAttribute("role")).toBe(newerAccepted ? "status" : "alert");
      const latestText = status.textContent;

      finishOlder(olderAccepted);
      await flushPorts();
      expect(status.hidden).toBe(newerAccepted);
      expect(status.getAttribute("role")).toBe(newerAccepted ? "status" : "alert");
      expect(status.textContent).toBe(latestText);
      expect(messages).toEqual([
        { type: "openclaw:widget-prompt-host-ready" },
        { type: "openclaw:widget-prompt-response", id: "newer", accepted: newerAccepted },
        { type: "openclaw:widget-prompt-response", id: "older", accepted: olderAccepted },
      ]);
    },
  );

  it.each([42, "", "x".repeat(65), { private: "not a request id" }])(
    "does not reflect an invalid request id %j",
    async (id) => {
      const { container, frame } = renderWidgetPreviewFrame(
        "/__openclaw__/canvas/documents/cv_bad_id/index.html",
      );
      const port = offerPromptPort(frame);
      const messages = collectHostMessages(port);
      frame.dispatchEvent(new Event("load"));
      emulateInteractableFrame(frame);
      collectPromptEvents(container);

      postPrompt(port, "Show details", id);
      await flushPorts();
      expect(messages).toEqual([{ type: "openclaw:widget-prompt-host-ready" }]);
    },
  );

  it("adopts the bridge's prompt port offer and enforces the prompt contract", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_prompt/index.html",
    );
    // The bridge posts its offer at parse time, before the frame's load event.
    const port = offerPromptPort(frame);
    const hostMessages: unknown[] = [];
    port.addEventListener("message", (event) => hostMessages.push(event.data));
    port.start();
    frame.dispatchEvent(new Event("load"));
    await flushPorts();
    expect(hostMessages).toContainEqual({ type: "openclaw:widget-prompt-host-ready" });
    emulateInteractableFrame(frame);
    const received = collectPromptEvents(container);
    try {
      postPrompt(port, "  Show details  ");
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // Slash and bang commands would run host commands on the widget's behalf;
      // the send path must only ever receive conversational text.
      postPrompt(port, "/approve");
      postPrompt(port, "!pwd");
      postPrompt(port, "   ");
      postPrompt(port, 42);
      postPrompt(port, "x".repeat(4_001));
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // A replacement document's later offer must not displace or re-arm the
      // adopted grant, even across another load event.
      const lateOfferPort = offerPromptPort(frame);
      frame.dispatchEvent(new Event("load"));
      postPrompt(lateOfferPort, "From takeover");
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // Without focus on the frame there is no user-activation signal; drop.
      restoreActiveElement();
      postPrompt(port, "Auto send");
      await flushPorts();
      expect(received).toEqual(["Show details"]);
      // Rate limit: 10 accepted prompts per rolling minute per widget document.
      emulateInteractableFrame(frame);
      for (let index = 2; index <= 12; index += 1) {
        postPrompt(port, `Prompt ${index}`);
      }
      await flushPorts();
      expect(received).toHaveLength(10);
      expect(received.at(-1)).toBe("Prompt 10");
    } finally {
      restoreActiveElement();
      container.remove();
    }
  });

  it("adopts a prompt offer that arrives after the frame's load event", async () => {
    const { container, frame } = renderWidgetPreviewFrame(
      "/__openclaw__/canvas/documents/cv_late_offer/index.html",
    );
    // Posted-message and load tasks have no guaranteed ordering; here load wins.
    frame.dispatchEvent(new Event("load"));
    const port = offerPromptPort(frame);
    emulateInteractableFrame(frame);
    const received = collectPromptEvents(container);
    try {
      postPrompt(port, "Late but valid");
      await flushPorts();
      expect(received).toEqual(["Late but valid"]);
    } finally {
      restoreActiveElement();
      container.remove();
    }
  });

  it("never adopts prompt offers from externally allowed embed URLs", async () => {
    const { container, frame } = renderWidgetPreviewFrame("https://canvas.example/widget", true);
    const port = offerPromptPort(frame);
    frame.dispatchEvent(new Event("load"));
    emulateInteractableFrame(frame);
    const received = collectPromptEvents(container);
    try {
      postPrompt(port, "External send");
      await flushPorts();
      expect(received).toEqual([]);
    } finally {
      restoreActiveElement();
      container.remove();
    }
  });
});
