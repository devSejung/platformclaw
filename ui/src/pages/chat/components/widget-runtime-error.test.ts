/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import { renderToolPreview, WIDGET_PROMPT_EVENT } from "./widget-card.ts";

const containers = new Set<HTMLElement>();
const ports = new Set<MessagePort>();

afterEach(() => {
  for (const port of ports) {
    port.close();
  }
  ports.clear();
  for (const container of containers) {
    container.remove();
  }
  containers.clear();
});

function widget(external = false) {
  const container = document.createElement("div");
  containers.add(container);
  document.body.append(container);
  render(
    renderToolPreview(
      {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        viewId: "cv_runtime_error",
        url: external
          ? "https://external.invalid/widget"
          : "/__openclaw__/canvas/documents/cv_runtime_error/index.html",
      },
      "chat_message",
      external ? { allowExternalEmbedUrls: true } : {},
    ),
    container,
  );
  const frame = container.querySelector("iframe");
  const status = container.querySelector<HTMLElement>("[data-widget-runtime-error]");
  const promptStatus = container.querySelector<HTMLElement>("[data-widget-prompt-status]");
  if (!frame?.contentWindow || !status || !promptStatus) {
    throw new Error("Expected a widget frame with independent diagnostic and prompt status");
  }
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
  frame.dispatchEvent(new Event("load"));
  return { container, frame, status, promptStatus, port: channel.port1 };
}

async function flushPorts() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function report(port: MessagePort, message: string, extra: Record<string, unknown> = {}) {
  port.postMessage({ type: "openclaw:widget-runtime-error", message, ...extra });
}

describe("widget runtime error feedback", () => {
  it("displays private-port errors as text without changing prompt status or submitting a message", async () => {
    const { container, frame, status, promptStatus, port } = widget();
    let prompts = 0;
    container.addEventListener(WIDGET_PROMPT_EVENT, () => {
      prompts += 1;
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "openclaw:widget-runtime-error", message: "Public window message" },
        origin: "null",
        source: frame.contentWindow,
      }),
    );
    await flushPorts();
    expect(status.hidden).toBe(true);
    report(port, '<img src="broken" onerror="alert(1)">', {
      source: "https://host.invalid/private/plot.js?key=secret",
      line: 12,
      column: 3,
    });
    await flushPorts();
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('<img src="broken" onerror="alert(1)"> (plot.js:12:3)');
    expect(status.textContent).toContain("Ask the agent to repair");
    expect(status.textContent).not.toContain("private");
    expect(status.textContent).not.toContain("secret");
    expect(status.querySelector("img")).toBeNull();
    expect(promptStatus.hidden).toBe(true);
    expect(prompts).toBe(0);
  });

  it("bounds diagnostics again at the host and ignores duplicates and malformed messages", async () => {
    const { status, port } = widget();
    port.postMessage({ type: "openclaw:widget-runtime-error", message: { toString: "bad" } });
    report(port, "   ");
    report(port, "First");
    report(port, "First");
    report(port, "Second");
    report(port, "x".repeat(800), { source: "y".repeat(300), line: 3.5, column: -1 });
    report(port, "Fourth");
    await flushPorts();
    expect(status.textContent).toContain(`${"x".repeat(500)} (${"y".repeat(200)})`);
    expect(status.textContent).not.toContain("x".repeat(501));
    expect(status.textContent).not.toContain("Fourth");
    expect(status.textContent).not.toContain(":3.5");
  });

  it.each(["src", "sandbox", "load", "generation", "detached"] as const)(
    "ignores a report after its original document loses authority through %s",
    async (change) => {
      const { container, frame, status, port } = widget();
      if (change === "src") {
        frame.setAttribute("src", "/replacement");
      } else if (change === "sandbox") {
        frame.setAttribute("sandbox", "");
      } else if (change === "load") {
        report(port, "Original document error");
        await flushPorts();
        expect(status.hidden).toBe(false);
        frame.dispatchEvent(new Event("load"));
      } else if (change === "generation") {
        bumpCanvasWidgetFrameConnectionGeneration();
      } else {
        container.remove();
      }
      report(port, "Stale widget error");
      await flushPorts();
      expect(status.hidden).toBe(true);
      expect(status.textContent).not.toContain("Stale widget error");
    },
  );

  it("does not adopt diagnostics from externally allowed embed frames", async () => {
    const { status, port } = widget(true);
    report(port, "External widget error");
    await flushPorts();
    expect(status.hidden).toBe(true);
  });
});
