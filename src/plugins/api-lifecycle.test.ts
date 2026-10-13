// Plugin API lifecycle guard: registration-only methods stop working once
// register() returns, while runtime methods remain callable from hooks and tools.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi } from "./types.js";

function captureRegisteredPluginApi(
  handlers: Parameters<typeof buildPluginApi>[0]["handlers"],
  onRegister?: (api: OpenClawPluginApi) => void,
) {
  const api = buildPluginApi({
    id: "late-call-fixture",
    name: "Late Call Fixture",
    source: "test",
    registrationMode: "full",
    config: {} as OpenClawConfig,
    runtime: {} as PluginRuntime,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolvePath: (input) => input,
    handlers,
  });
  let captured: OpenClawPluginApi | undefined;
  runPluginRegisterSyncInRegistry(
    (pluginApi) => {
      captured = pluginApi;
      onRegister?.(pluginApi);
    },
    api,
    createEmptyPluginRegistry(),
    "late-call-fixture",
  );
  return expectDefined(captured, "captured plugin api");
}

describe.each(["flat", "grouped"] as const)("%s plugin api lifecycle", (shape) => {
  it("keeps both next-turn injection APIs callable after registration", async () => {
    const enqueueNextTurnInjection = vi.fn(async (injection) => ({
      enqueued: true,
      id: `injection-${injection.text}`,
      sessionKey: injection.sessionKey,
    }));
    const handlers =
      shape === "flat"
        ? { enqueueNextTurnInjection }
        : { session: { workflow: { enqueueNextTurnInjection } } };
    let detached: Pick<OpenClawPluginApi, "enqueueNextTurnInjection"> | undefined;
    const api = captureRegisteredPluginApi(handlers, (pluginApi) => {
      detached = { enqueueNextTurnInjection: pluginApi.enqueueNextTurnInjection };
    });

    const groupedResult = await api.session.workflow.enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "grouped",
    });
    const flatResult = await expectDefined(
      detached,
      "detached plugin api",
    ).enqueueNextTurnInjection({
      sessionKey: "agent:main:main",
      text: "flat",
    });

    expect(groupedResult).toEqual({
      enqueued: true,
      id: "injection-grouped",
      sessionKey: "agent:main:main",
    });
    expect(flatResult).toEqual({
      enqueued: true,
      id: "injection-flat",
      sessionKey: "agent:main:main",
    });
    expect(enqueueNextTurnInjection).toHaveBeenCalledTimes(2);
  });

  it("blocks registration-phase methods after registration", () => {
    const registerSessionExtension = vi.fn();
    const handlers =
      shape === "flat"
        ? { registerSessionExtension }
        : { session: { state: { registerSessionExtension } } };
    const extension = {
      namespace: "workflow",
      description: "workflow",
    };
    let cached: OpenClawPluginApi["session"]["state"] | undefined;
    const api = captureRegisteredPluginApi(handlers, (pluginApi) => {
      pluginApi.session.state.registerSessionExtension(extension);
      cached = pluginApi.session.state;
    });
    expect(registerSessionExtension).toHaveBeenCalledExactlyOnceWith(extension);

    expect(api.session.state.registerSessionExtension(extension)).toBeUndefined();
    expect(api.registerSessionExtension(extension)).toBeUndefined();
    expect(
      expectDefined(cached, "cached session API").registerSessionExtension(extension),
    ).toBeUndefined();
    expect(registerSessionExtension).toHaveBeenCalledExactlyOnceWith(extension);
  });
});
