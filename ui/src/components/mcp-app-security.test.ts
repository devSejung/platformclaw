import { afterEach, describe, expect, it } from "vitest";
import {
  buildMcpAppHostCapabilities,
  dispatchWidgetPrompt,
  resolveMcpAppSandboxUrl,
  WIDGET_PROMPT_EVENT,
  type WidgetPromptEventDetail,
} from "./mcp-app-security.ts";

function focusedFrame() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frame.checkVisibility = () => true;
  Object.defineProperty(document, "activeElement", { get: () => frame, configurable: true });
  return frame;
}

function receivePrompt(
  frame: HTMLIFrameElement,
  receive: (detail: WidgetPromptEventDetail) => void,
) {
  frame.addEventListener(WIDGET_PROMPT_EVENT, (event) => {
    receive((event as CustomEvent<WidgetPromptEventDetail>).detail);
  });
}

afterEach(() => {
  document.body.replaceChildren();
  delete (document as unknown as Record<string, unknown>).activeElement;
});

describe("MCP App sandbox security", () => {
  it("advertises the CSP applied to MCP Apps", () => {
    expect(
      buildMcpAppHostCapabilities({ connectDomains: ["https://api.example.com"] }),
    ).toMatchObject({ sandbox: { csp: { connectDomains: ["https://api.example.com"] } } });
    expect(buildMcpAppHostCapabilities()).toMatchObject({ sandbox: { csp: {} } });
  });

  it("advertises update-model-context text support only when the handler path exists", () => {
    expect(buildMcpAppHostCapabilities(undefined, true, true)).toMatchObject({
      message: { text: {} },
      updateModelContext: { text: {} },
    });
    expect(buildMcpAppHostCapabilities(undefined, true, false)).not.toHaveProperty(
      "updateModelContext",
    );
  });

  it("accepts only the dedicated-origin sandbox endpoint", () => {
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox?csp=abc",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toBe("https://gateway.example:8444/mcp-app-sandbox?csp=abc");
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        18790,
        "https://apps.example.com",
        "wss://gateway.example",
        "https://gateway.example",
      ),
    ).toBe("https://apps.example.com/mcp-app-sandbox");

    const invalid = [
      [
        "https://attacker.example/mcp-app-sandbox",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ],
      [
        "data:text/html;base64,cHJveHk=",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ],
      [
        "/mcp-app-sandbox",
        8443,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ],
      [
        "/mcp-app-sandbox",
        8444,
        "https://gateway.example:8443",
        "wss://gateway.example:8443/openclaw",
        "https://control.example",
      ],
    ] as const;
    for (const args of invalid) {
      expect(() => resolveMcpAppSandboxUrl(args[0], args[1], args[2], args[3], args[4])).toThrow(
        "MCP App sandbox URL is invalid",
      );
    }
  });

  it("rejects a focused prompt when no chat owner accepts it", async () => {
    const frame = focusedFrame();
    expect(await dispatchWidgetPrompt(frame, "Show details", crypto.randomUUID())).toBe(false);
  });

  it("waits for the owning chat to acknowledge admission", async () => {
    const frame = focusedFrame();
    let admit!: (accepted: boolean) => void;
    const admission = new Promise<boolean>((resolve) => {
      admit = resolve;
    });
    receivePrompt(frame, (detail) => {
      expect(detail.text).toBe("Show details");
      expect(detail.sessionKey).toBe("agent:main:bound");
      expect(detail.respondWith(admission)).toBe(true);
    });
    const dispatch = dispatchWidgetPrompt(
      frame,
      "  Show details  ",
      crypto.randomUUID(),
      undefined,
      "agent:main:bound",
    );
    let settled = false;
    void dispatch.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    admit(true);
    expect(await dispatch).toBe(true);
  });

  it.each([false, "rejected"] as const)("reports failed owner admission: %s", async (result) => {
    const frame = focusedFrame();
    receivePrompt(frame, (detail) => {
      detail.respondWith(
        result === "rejected" ? Promise.reject(new Error("offline")) : Promise.resolve(result),
      );
    });
    expect(await dispatchWidgetPrompt(frame, "Show details", crypto.randomUUID())).toBe(false);
  });

  it("accepts only the first synchronous owner claim", async () => {
    const frame = focusedFrame();
    let prompt!: WidgetPromptEventDetail;
    receivePrompt(frame, (detail) => {
      prompt = detail;
      expect(detail.respondWith(Promise.resolve(true))).toBe(true);
      expect(detail.respondWith(Promise.resolve(false))).toBe(false);
    });
    expect(await dispatchWidgetPrompt(frame, "Show details", crypto.randomUUID())).toBe(true);
    expect(prompt.respondWith(Promise.resolve(false))).toBe(false);
  });

  it("rejects an owner claim made after event dispatch", async () => {
    const frame = focusedFrame();
    let prompt!: WidgetPromptEventDetail;
    receivePrompt(frame, (detail) => {
      prompt = detail;
    });
    expect(await dispatchWidgetPrompt(frame, "Show details", crypto.randomUUID())).toBe(false);
    expect(prompt.respondWith(Promise.resolve(true))).toBe(false);
  });

  it("keeps the per-view prompt budget across iframe remounts", async () => {
    const key = `agent:main:main\0view-${crypto.randomUUID()}`;
    const first = focusedFrame();
    receivePrompt(first, (detail) => detail.respondWith(Promise.resolve(true)));
    for (let index = 0; index < 10; index += 1) {
      expect(await dispatchWidgetPrompt(first, `Prompt ${index}`, key)).toBe(true);
    }

    first.remove();
    const replacement = focusedFrame();
    receivePrompt(replacement, (detail) => detail.respondWith(Promise.resolve(true)));
    expect(await dispatchWidgetPrompt(replacement, "Prompt after remount", key)).toBe(false);
  });
});
