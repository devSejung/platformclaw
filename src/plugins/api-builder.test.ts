import { describe, expect, it, vi } from "vitest";
import { buildPluginApi } from "./api-builder.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

type PluginApiHandlers = NonNullable<Parameters<typeof buildPluginApi>[0]["handlers"]>;

function createApi(id: string, handlers: PluginApiHandlers) {
  return buildPluginApi({
    id,
    name: id,
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: new Proxy({} as PluginRuntime, {
      get() {
        throw new Error("API construction must not materialize the plugin runtime");
      },
    }),
    logger: { info() {}, warn() {}, error() {} },
    resolvePath: (input) => input,
    handlers,
  });
}

describe.each(["flat", "grouped"] as const)("%s host API handlers", (shape) => {
  it("preserves receiver ownership and live overrides for detached namespace calls", () => {
    const getRunContext = vi.fn(function (this: OpenClawPluginApi) {
      return this.id;
    });
    const handlers = shape === "flat" ? { getRunContext } : { runContext: { getRunContext } };
    const first = createApi("first-plugin", handlers);
    const second = createApi("second-plugin", handlers);
    const readFirst = first.runContext.getRunContext;
    const readSecond = second.runContext.getRunContext;
    const key = { runId: "run", namespace: "state" };

    expect(readFirst(key)).toBe("first-plugin");
    expect(first.getRunContext(key)).toBe("first-plugin");
    expect(readSecond(key)).toBe("second-plugin");
    expect(second.getRunContext(key)).toBe("second-plugin");

    first.getRunContext = function (this: OpenClawPluginApi) {
      return `updated-${this.id}`;
    };
    expect(readFirst(key)).toBe("updated-first-plugin");
    expect(readSecond(key)).toBe("second-plugin");
    expect(getRunContext).toHaveBeenCalledTimes(5);
  });

  it("preserves unwired methods when the host supplies only one handler", async () => {
    const registerSessionExtension = vi.fn();
    const handlers =
      shape === "flat"
        ? { registerSessionExtension }
        : { session: { state: { registerSessionExtension } } };
    const api = createApi("partial-plugin", handlers);
    const extension = { namespace: "workflow", description: "workflow" };
    api.session.state.registerSessionExtension(extension);
    api.registerSessionExtension(extension);
    expect(registerSessionExtension).toHaveBeenNthCalledWith(1, extension);
    expect(registerSessionExtension).toHaveBeenNthCalledWith(2, extension);

    expect(api.runContext.setRunContext({ runId: "run", namespace: "state", value: true })).toBe(
      false,
    );
    expect(api.runContext.getRunContext({ runId: "run", namespace: "state" })).toBeUndefined();
    expect(api.agent.events.emitAgentEvent({ runId: "run", stream: "audit", data: {} })).toEqual({
      emitted: false,
      reason: "not wired",
    });
    await expect(
      api.session.workflow.enqueueNextTurnInjection({ sessionKey: "session", text: "context" }),
    ).resolves.toEqual({ enqueued: false, id: "", sessionKey: "session" });
    await expect(
      api.session.workflow.unscheduleSessionTurnsByTag({ sessionKey: "session", tag: "work" }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
  });
});
