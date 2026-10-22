import { dispatchWidgetPrompt } from "../../../components/mcp-app-security.ts";
import { t } from "../../../i18n/index.ts";

const OFFER = "openclaw:widget-prompt-offer";
const PROMPT = "openclaw:widget-prompt";
const READY = "openclaw:widget-prompt-host-ready";
const RESPONSE = "openclaw:widget-prompt-response";

// The trusted wrapper offers its private port before authored code runs.
// Only that document's first offer may be adopted; navigation cannot re-arm it.
const offeredSources = new WeakSet<object>();
const pendingPorts = new WeakMap<object, MessagePort>();
const eligibleFrames = new WeakMap<object, HTMLIFrameElement>();
const adoptedFrames = new WeakSet<HTMLIFrameElement>();
const listenerWindows = new WeakSet<Window>();
const requestRevisions = new WeakMap<HTMLIFrameElement, number>();

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
  showPromptStatus(frame, "pending");
  const accepted = await dispatchWidgetPrompt(
    frame,
    payload.prompt,
    frame.getAttribute("src") ?? "",
  );
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
