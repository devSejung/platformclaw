import { afterEach, describe, expect, it } from "vitest";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
  getPluginRunContext,
  setPluginRunContext,
} from "./host-hook-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { markPluginRegistryActive, markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

afterEach(() => clearPluginHostRuntimeState());

const key = { runId: "agent-run", namespace: "selection" };
const patch = { ...key, value: { vaultIds: ["allowed-vault"] } };

function createFixture(mode: "full" | "discovery" | "tool-discovery") {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: mode === "full",
  });
  const record = createPluginRecord({
    id: "corpus-provider",
    source: "/plugins/corpus-provider/index.ts",
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  const api = builder.createApi(record, { config: {}, registrationMode: mode });
  return {
    ...builder,
    api,
    record,
    run: <T>(fn: () => T): T => withPluginRuntimeRegistryScope(builder.registry, fn),
  };
}

describe.each(["discovery", "tool-discovery"] as const)("%s run context", (mode) => {
  it("remains inert during registration and outside the loaded owning scope", async () => {
    const f = createFixture(mode);
    expect(f.run(() => f.api.runContext.setRunContext(patch))).toBe(false);
    f.registry.plugins.push(f.record);
    expect(f.api.runContext.setRunContext(patch)).toBe(false);
    expect(f.api.runContext.getRunContext(key)).toBeUndefined();
    const other = createFixture(mode);
    expect(other.run(() => f.api.runContext.setRunContext(patch))).toBe(false);
    await f.run(async () => {
      await Promise.resolve();
      // The tool owner can call a sibling corpus provider's API in the SAME
      // registry. Storage remains namespaced by the API's provider identity.
      withPluginRuntimePluginScope({ pluginId: "wiki-tool" }, () => {
        expect(f.api.runContext.setRunContext(patch)).toBe(true);
        expect(f.api.runContext.getRunContext(key)).toEqual(patch.value);
      });
      expect(
        f.api.agent.events.emitAgentEvent({
          runId: key.runId,
          stream: "audit",
          data: {},
        }),
      ).toMatchObject({ emitted: false, reason: "global side effects disabled" });
      expect(
        await f.api.session.workflow.scheduleSessionTurn({
          sessionKey: "agent:a:main",
          message: "must not schedule",
          at: Date.now(),
        }),
      ).toBeUndefined();
    });
    f.api.runContext.clearRunContext(key);
    expect(f.run(() => f.api.runContext.getRunContext(key))).toEqual(patch.value);
    f.run(() => f.api.runContext.clearRunContext(key));
    expect(getPluginRunContext({ pluginId: f.record.id, get: key })).toBeUndefined();
  });

  it.each(["removed", "replaced", "disabled", "failed", "retired", "rolled-back"] as const)(
    "rejects a %s handle without erasing another generation's state",
    (action) => {
      const f = createFixture(mode);
      f.registry.plugins.push(f.record);
      expect(f.run(() => f.api.runContext.setRunContext(patch))).toBe(true);
      switch (action) {
        case "removed":
          f.registry.plugins.length = 0;
          break;
        case "replaced":
          f.registry.plugins[0] = { ...f.record };
          break;
        case "disabled":
          f.record.enabled = false;
          break;
        case "failed":
          f.record.status = "error";
          break;
        case "retired":
          markPluginRegistryRetired(f.registry);
          break;
        case "rolled-back":
          f.rollbackPluginGlobalSideEffects(f.record.id, f.record);
          break;
      }
      f.run(() => {
        expect(f.api.runContext.setRunContext({ ...patch, value: "stale" })).toBe(false);
        expect(f.api.runContext.getRunContext(key)).toBeUndefined();
        f.api.runContext.clearRunContext(key);
      });
      expect(getPluginRunContext({ pluginId: f.record.id, get: key })).toEqual(patch.value);
    },
  );

  it("retains plugin/run isolation, host cleanup and the closed-run guard", async () => {
    const f = createFixture(mode);
    f.registry.plugins.push(f.record);
    setPluginRunContext({ pluginId: "another-provider", patch: { ...patch, value: "private" } });
    f.run(() => {
      expect(f.api.runContext.getRunContext(key)).toBeUndefined();
      expect(f.api.runContext.setRunContext(patch)).toBe(true);
      expect(f.api.runContext.getRunContext({ ...key, runId: "another-run" })).toBeUndefined();
    });
    dispatchPluginAgentEventSubscriptions({
      registry: f.registry,
      event: {
        runId: key.runId,
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      },
    });
    expect(f.run(() => f.api.runContext.setRunContext(patch))).toBe(false);
    await expect
      .poll(() => getPluginRunContext({ pluginId: f.record.id, get: key }))
      .toBeUndefined();
    expect(getPluginRunContext({ pluginId: "another-provider", get: key })).toBeUndefined();
  });
});

it("preserves full activation run-context behavior", () => {
  const f = createFixture("full");
  expect(f.api.runContext.setRunContext(patch)).toBe(true);
  f.registry.plugins.push(f.record);
  markPluginRegistryActive(f.registry);
  expect(f.api.runContext.getRunContext(key)).toEqual(patch.value);
  markPluginRegistryRetired(f.registry);
  expect(f.api.runContext.setRunContext(patch)).toBe(false);
  expect(f.api.runContext.getRunContext(key)).toBeUndefined();
});
