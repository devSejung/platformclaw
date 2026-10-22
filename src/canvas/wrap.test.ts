import { setImmediate as nextTurn } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWidgetDocument } from "./wrap.js";

type PromptRequest = { type: string; id: string; prompt: string };
type WidgetWindow = {
  parent: {
    postMessage: (message: { type: string }, origin: string, ports?: MessagePort[]) => void;
  };
  openclaw?: { prompt: { send: (text: string) => Promise<boolean> } };
  sendPrompt?: (text: string) => void;
};

const cleanups: Array<() => void> = [];

function createPromptBridge() {
  const channels: MessageChannel[] = [];
  cleanups.push(() => {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
  });
  const offers = new Map<string, MessagePort>();
  let hostInitTimeout: (() => void) | undefined;
  class WidgetMessageChannel extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  }
  const window: WidgetWindow = {
    parent: {
      postMessage: (message, _origin, ports) => {
        if (ports?.[0]) {
          offers.set(message.type, ports[0]);
        }
      },
    },
  };
  const context = createContext({
    window,
    MessageChannel: WidgetMessageChannel,
    navigator: {
      userActivation: Object.create({
        get isActive() {
          return true;
        },
      }),
    },
    // Only execute the authority-capturing bridge, with its one readiness timer.
    // DOM/theme/snapshot scripts belong to the browser integration tests.
    setTimeout: (callback: () => void) => {
      hostInitTimeout = callback;
      return 1;
    },
    clearTimeout: () => {
      hostInitTimeout = undefined;
    },
  });
  const html = buildWidgetDocument("Prompt bridge", "<p>widget</p>");
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  if (!script) {
    throw new Error("widget bridge script missing");
  }
  runInContext(script, context);
  const port = offers.get("openclaw:widget-prompt-offer");
  if (!port || !window.openclaw || !window.sendPrompt) {
    throw new Error("widget prompt bridge did not initialize");
  }
  const messages: unknown[] = [];
  const receivers: Array<(message: unknown) => void> = [];
  port.on("message", (message: unknown) => {
    const receiver = receivers.shift();
    if (receiver) {
      receiver(message);
    } else {
      messages.push(message);
    }
  });
  return {
    send: window.openclaw.prompt.send,
    legacySend: window.sendPrompt,
    ready: () => port.postMessage({ type: "openclaw:widget-prompt-host-ready" }),
    reply: (message: unknown) => port.postMessage(message),
    async receive(): Promise<PromptRequest> {
      const message = messages.length
        ? messages.shift()
        : await new Promise<unknown>((resolve) => {
            receivers.push(resolve);
          });
      expect(message).toMatchObject({
        type: "openclaw:widget-prompt",
        id: expect.any(String),
        prompt: expect.any(String),
      });
      return message as PromptRequest;
    },
    expireHostInit() {
      if (!hostInitTimeout) {
        throw new Error("widget host timer missing");
      }
      const callback = hostInitTimeout;
      hostInitTimeout = undefined;
      callback();
    },
    runAuthoredScript: (source: string) => {
      runInContext(source, context);
    },
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("generated widget prompt bridge", () => {
  it("waits for boolean acceptance of the exact request and ignores malformed or duplicate replies", async () => {
    const bridge = createPromptBridge();
    bridge.ready();
    const first = bridge.send("First prompt");
    const second = bridge.send("Second prompt");
    const settled = vi.fn();
    void first.then((accepted) => settled("first", accepted));
    void second.then((accepted) => settled("second", accepted));
    const a = await bridge.receive();
    const b = await bridge.receive();
    expect([a.prompt, b.prompt]).toEqual(["First prompt", "Second prompt"]);
    expect(a.id).not.toBe(b.id);
    await nextTurn();
    expect(settled).not.toHaveBeenCalled();

    for (const malformed of [
      { type: "other-response", id: a.id, accepted: true },
      { type: "openclaw:widget-prompt-response", id: a.id, accepted: "true" },
      { type: "openclaw:widget-prompt-response", id: 1, accepted: true },
      { type: "openclaw:widget-prompt-response", id: `${a.id}-unknown`, accepted: true },
    ]) {
      bridge.reply(malformed);
    }
    bridge.reply({ type: "openclaw:widget-prompt-response", id: a.id, accepted: false });
    await expect(first).resolves.toBe(false);
    expect(settled.mock.calls).toEqual([["first", false]]);
    bridge.reply({ type: "openclaw:widget-prompt-response", id: a.id, accepted: false });
    bridge.reply({ type: "openclaw:widget-prompt-response", id: b.id, accepted: true });
    await expect(second).resolves.toBe(true);
    expect(settled.mock.calls).toEqual([
      ["first", false],
      ["second", true],
    ]);
  });

  it("bounds all pending prompts to ten before and after readiness and releases settled slots", async () => {
    const bridge = createPromptBridge();
    const pending = Array.from({ length: 10 }, (_, index) => bridge.send(`Prompt ${index}`));
    await expect(bridge.send("Overflow before ready")).resolves.toBe(false);
    bridge.ready();
    const requests: PromptRequest[] = [];
    for (let index = 0; index < 10; index++) {
      requests.push(await bridge.receive());
    }
    expect(requests.map((request) => request.prompt)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Prompt ${index}`),
    );
    await expect(bridge.send("Overflow while waiting for replies")).resolves.toBe(false);
    bridge.reply({ type: "openclaw:widget-prompt-response", id: requests[0]!.id, accepted: false });
    await expect(pending[0]).resolves.toBe(false);
    const replacement = bridge.send("Replacement");
    const request = await bridge.receive();
    expect(request.prompt).toBe("Replacement");
    bridge.reply({ type: "openclaw:widget-prompt-response", id: request.id, accepted: true });
    await expect(replacement).resolves.toBe(true);
    for (const remaining of requests.slice(1)) {
      bridge.reply({ type: "openclaw:widget-prompt-response", id: remaining.id, accepted: true });
    }
    expect(await Promise.all(pending)).toEqual([false, ...Array<boolean>(9).fill(true)]);
  });

  it("uses captured Map primitives after authored code changes its realm's prototypes", async () => {
    const bridge = createPromptBridge();
    bridge.runAuthoredScript(`
      const poison=()=>{throw new Error("authored Map mutation");};
      Map.prototype.get=poison;Map.prototype.set=poison;Map.prototype.delete=poison;
      Object.defineProperty(Map.prototype,"size",{get:poison});
    `);
    bridge.ready();
    const result = bridge.send("Captured primitives");
    const request = await bridge.receive();
    expect(request.prompt).toBe("Captured primitives");
    bridge.reply({ type: "openclaw:widget-prompt-response", id: request.id, accepted: true });
    await expect(result).resolves.toBe(true);
  });

  it("keeps the legacy helper void, consumes readiness failure, and posts over the private port", async () => {
    const bridge = createPromptBridge();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(bridge.legacySend("Waiting for host")).toBeUndefined();
      bridge.expireHostInit();
      await nextTurn();
      expect(unhandled).not.toHaveBeenCalled();
      const hosted = createPromptBridge();
      hosted.ready();
      expect(hosted.legacySend("Legacy prompt")).toBeUndefined();
      const request = await hosted.receive();
      expect(request.prompt).toBe("Legacy prompt");
      hosted.reply({ type: "openclaw:widget-prompt-response", id: request.id, accepted: true });
      await nextTurn();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
