import {
  dispatchWidgetPrompt,
  isWidgetFrameInteractable,
} from "../../../components/mcp-app-security.ts";
import { t } from "../../../i18n/index.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";

const OFFER = "openclaw:widget-prompt-offer";
const PROMPT = "openclaw:widget-prompt";
const READY = "openclaw:widget-prompt-host-ready";
const RESPONSE = "openclaw:widget-prompt-response";

// Adopt only the source's first offer. A replacement offer from the same
// WindowProxy cannot re-arm prompt authority across navigation.
const offeredSources = new WeakSet<object>();
const pendingPorts = new WeakMap<object, MessagePort>();
const eligibleFrames = new WeakMap<object, HTMLIFrameElement>();
const adoptedFrames = new WeakSet<HTMLIFrameElement>();
const listenerWindows = new WeakSet<Window>();
const requestRevisions = new WeakMap<HTMLIFrameElement, number>();
// A same-URL reload replaces the document without changing its WindowProxy.
const documentRevisions = new WeakMap<HTMLIFrameElement, number>();
const pendingFocusHandoffs = new WeakMap<HTMLIFrameElement, () => void>();
// A focus notification may trail an OOPIF's prompt message. Expire the handoff
// so an abandoned request cannot wait indefinitely for a later interaction.
const CANVAS_FOCUS_HANDOFF_MS = 2_000;

function waitForPromptFrameFocus(
  frame: HTMLIFrameElement,
  current: () => boolean,
): Promise<boolean> {
  const document = frame.ownerDocument;
  const view = document.defaultView;
  if (!view || !current()) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const controller = new AbortController();
    const finish = (focused: boolean) => {
      controller.abort();
      observer.disconnect();
      view.clearTimeout(timeout);
      if (pendingFocusHandoffs.get(frame) === cancel) {
        pendingFocusHandoffs.delete(frame);
      }
      resolve(focused);
    };
    const cancel = () => finish(false);
    const observeFocus = (event: Event) => {
      // Capturing Window listeners also see the previous control's blur. Only
      // the Window notification marks the cross-document focus handoff.
      if (event.type !== "focusin" && event.target !== view) {
        return;
      }
      finish(current() && isWidgetFrameInteractable(frame));
    };
    const observer = new MutationObserver(() => {
      if (!current()) {
        cancel();
      }
    });
    // Observe each containing shadow root as well as the document: removing a
    // shadow host does not mutate its shadow tree, but still revokes the frame.
    let root = frame.getRootNode();
    while (true) {
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "sandbox"],
      });
      if (!(root instanceof ShadowRoot)) {
        break;
      }
      root = root.host.getRootNode();
    }
    const events = { capture: true, signal: controller.signal };
    view.addEventListener("blur", observeFocus, events);
    view.addEventListener("focus", observeFocus, events);
    document.addEventListener("focusin", observeFocus, events);
    document.addEventListener("pointerdown", cancel, events);
    document.addEventListener("keydown", cancel, events);
    view.addEventListener("pagehide", cancel, events);
    frame.addEventListener("load", cancel, events);
    const timeout = view.setTimeout(cancel, CANVAS_FOCUS_HANDOFF_MS);
    pendingFocusHandoffs.set(frame, cancel);
  });
}

function showPromptStatus(frame: HTMLIFrameElement, state: "pending" | "accepted" | "rejected") {
  if (!frame.isConnected) {
    return;
  }
  const status = frame
    .closest(".chat-tool-card__preview")
    ?.querySelector<HTMLElement>("[data-widget-prompt-status]");
  if (status) {
    status.hidden = state === "accepted";
    status.classList.toggle("danger", state === "rejected");
    status.setAttribute("role", state === "rejected" ? "alert" : "status");
    status.textContent =
      state === "accepted"
        ? ""
        : t(
            state === "pending"
              ? "chat.toolCards.widgetMessageSending"
              : "chat.toolCards.widgetMessageRejected",
          );
  }
}

async function receivePrompt(frame: HTMLIFrameElement, port: MessagePort, data: unknown) {
  const payload = data as { type?: unknown; prompt?: unknown; id?: unknown } | null;
  if (!payload || payload.type !== PROMPT) {
    return;
  }
  const revision = (requestRevisions.get(frame) ?? 0) + 1;
  requestRevisions.set(frame, revision);
  pendingFocusHandoffs.get(frame)?.();
  const document = frame.ownerDocument;
  const root = frame.getRootNode();
  const source = frame.contentWindow;
  const src = frame.getAttribute("src");
  const sandbox = frame.getAttribute("sandbox");
  const generation = getCanvasWidgetFrameConnectionGeneration();
  const documentRevision = documentRevisions.get(frame);
  const expiresAt = performance.now() + CANVAS_FOCUS_HANDOFF_MS;
  const current = () =>
    performance.now() < expiresAt &&
    requestRevisions.get(frame) === revision &&
    documentRevisions.get(frame) === documentRevision &&
    frame.isConnected &&
    frame.ownerDocument === document &&
    frame.getRootNode() === root &&
    frame.contentWindow === source &&
    frame.getAttribute("src") === src &&
    frame.getAttribute("sandbox") === sandbox &&
    getCanvasWidgetFrameConnectionGeneration() === generation;
  showPromptStatus(frame, "pending");
  // Parent focus state can lag a real cross-process iframe click. Wait for its
  // native notification, then retain the shared focus, text, rate and owner gate.
  const focused =
    isWidgetFrameInteractable(frame) || (await waitForPromptFrameFocus(frame, current));
  const accepted =
    focused &&
    current() &&
    (await dispatchWidgetPrompt(frame, payload.prompt, frame.getAttribute("src") ?? ""));
  // An older completion must not erase a newer refusal or replace its result.
  if (requestRevisions.get(frame) === revision) {
    showPromptStatus(frame, accepted ? "accepted" : "rejected");
  }
  // Tagged Canvas documents retain their original id-less bridge in history.
  // They still submit normally and receive the same host-visible failure state.
  if (typeof payload.id === "string" && payload.id.length > 0 && payload.id.length <= 64) {
    port.postMessage({ type: RESPONSE, id: payload.id, accepted });
  }
}

function adoptPromptPort(frame: HTMLIFrameElement) {
  documentRevisions.set(frame, (documentRevisions.get(frame) ?? 0) + 1);
  pendingFocusHandoffs.get(frame)?.();
  const source = frame.contentWindow;
  if (!source || adoptedFrames.has(frame)) {
    return;
  }
  eligibleFrames.set(source, frame);
  const port = pendingPorts.get(source);
  if (!port) {
    return;
  }
  adoptedFrames.add(frame);
  pendingPorts.delete(source);
  port.addEventListener("message", (event: MessageEvent) => {
    void receivePrompt(frame, port, event.data);
  });
  port.start();
  // Readiness means the private port is adopted, not that a message was sent.
  port.postMessage({ type: READY });
}

/** Install before rendering; the returned callback adopts the frame on load. */
export function prepareCanvasWidgetPromptBridge(): (frame: HTMLIFrameElement) => void {
  if (!listenerWindows.has(window)) {
    listenerWindows.add(window);
    window.addEventListener("message", (event: MessageEvent) => {
      if (
        event.data?.type !== OFFER ||
        event.origin !== "null" ||
        !event.source ||
        !event.ports[0]
      ) {
        return;
      }
      const source = event.source;
      const port = event.ports[0];
      if (offeredSources.has(source)) {
        const frame = eligibleFrames.get(source);
        if (frame) {
          pendingFocusHandoffs.get(frame)?.();
        }
        port.close();
        return;
      }
      offeredSources.add(source);
      pendingPorts.set(source, port);
      // Posted-message and iframe-load tasks have no cross-source ordering.
      // The source lookup also adopts offers that arrive after the first load.
      const frame = eligibleFrames.get(source);
      if (frame) {
        adoptPromptPort(frame);
      }
    });
  }
  return adoptPromptPort;
}
