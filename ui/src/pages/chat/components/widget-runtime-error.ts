import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { t } from "../../../i18n/index.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";

/** Display-only diagnostics belong to the document that offered the private port. */
export function createWidgetRuntimeErrorReporter(
  frame: HTMLIFrameElement,
  documentIsCurrent: () => boolean,
): (raw: unknown) => void {
  const generation = getCanvasWidgetFrameConnectionGeneration();
  const document = frame.ownerDocument;
  const root = frame.getRootNode();
  const source = frame.contentWindow;
  const src = frame.getAttribute("src");
  const sandbox = frame.getAttribute("sandbox");
  const seen = new Set<string>();
  return (raw) => {
    const data = asOptionalRecord(raw);
    if (
      data?.type !== "openclaw:widget-runtime-error" ||
      typeof data.message !== "string" ||
      !documentIsCurrent() ||
      !frame.isConnected ||
      frame.ownerDocument !== document ||
      frame.getRootNode() !== root ||
      frame.contentWindow !== source ||
      frame.getAttribute("src") !== src ||
      frame.getAttribute("sandbox") !== sandbox ||
      getCanvasWidgetFrameConnectionGeneration() !== generation ||
      seen.size >= 3
    ) {
      return;
    }
    const message = truncateUtf16Safe(data.message.trim(), 500);
    if (!message || seen.has(message)) {
      return;
    }
    const status = frame
      .closest(".chat-tool-card__preview")
      ?.querySelector<HTMLElement>("[data-widget-runtime-error]");
    if (!status) {
      return;
    }
    const filename =
      typeof data.source === "string"
        ? truncateUtf16Safe(data.source.split(/[?#]/u, 1)[0]?.split(/[\\/]/u).at(-1) ?? "", 200)
        : "";
    const line =
      typeof data.line === "number" && Number.isSafeInteger(data.line) && data.line > 0
        ? data.line
        : undefined;
    const column =
      typeof data.column === "number" && Number.isSafeInteger(data.column) && data.column > 0
        ? data.column
        : undefined;
    const lineAndColumn = line ? `:${line}${column ? `:${column}` : ""}` : "";
    const position = filename ? ` (${filename}${lineAndColumn})` : "";
    seen.add(message);
    status.textContent = t("chat.toolCards.widgetRuntimeError", {
      message: `${message}${position}`,
    });
    status.hidden = false;
  };
}
