import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  createPluginRecord,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWikiHubCorpusSupplement } from "./supplement.js";
import { createVaultTurnScopeController } from "./turn-scope.js";

function fixture() {
  const { config, registry } = createPluginRegistryFixture();
  const record = createPluginRecord({ id: "platformclaw-org-memory", origin: "bundled" });
  registry.registry.plugins.push(record);
  const api = registry.createApi(record, { config });
  setActivePluginRegistry(registry.registry);
  return api;
}

afterEach(() => resetPluginRuntimeStateForTest());

describe("vault connection turn scope", () => {
  it("coalesces prompt/tool preparation and keeps a Personal Wiki toggle pinned until next turn", async () => {
    const api = fixture();
    let release!: () => void;
    let enabled = false;
    const captureScope = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { revision: 1, vaultIds: [], personalEnabled: enabled };
    });
    const controller = createVaultTurnScopeController(api, { captureScope });
    const first = controller.resolve({ runId: "scope-first", agentId: "person_one" });
    const concurrent = controller.resolve({ runId: "scope-first", agentId: "person_one" });
    release();
    expect(await first).toMatchObject({ personalEnabled: false });
    expect(await concurrent).toMatchObject({ personalEnabled: false });
    enabled = true;
    expect(await controller.resolve({ runId: "scope-first", agentId: "person_one" })).toMatchObject(
      { personalEnabled: false },
    );
    const next = controller.resolve({ runId: "scope-next", agentId: "person_one" });
    release();
    expect(await next).toMatchObject({ personalEnabled: true });
    expect(captureScope).toHaveBeenCalledTimes(2);
  });
  it("pins searches and same-run retries while the next turn gets new connections", async () => {
    const api = fixture();
    const captureScope = vi
      .fn()
      .mockResolvedValueOnce({ revision: 1, vaultIds: ["old"], personalEnabled: false })
      .mockResolvedValueOnce({ revision: 2, vaultIds: ["new"], personalEnabled: true });
    const controller = createVaultTurnScopeController(api, { captureScope });
    const search = vi.fn(async () => []);
    const supplement = createWikiHubCorpusSupplement(
      { search, get: vi.fn() },
      api.logger,
      controller.get,
    );
    const context = { runId: "first", agentId: "person_one" };
    await controller.prepare(context);
    await controller.prepare(context);
    await supplement.search({ ...context, query: "spec" });
    expect(search).toHaveBeenLastCalledWith({
      agentId: "person_one",
      query: "spec",
      turnScope: { revision: 1, vaultIds: ["old"], personalEnabled: false },
    });
    await controller.prepare({ ...context, runId: "next" });
    await supplement.search({ ...context, runId: "next", query: "spec" });
    expect(search).toHaveBeenLastCalledWith({
      agentId: "person_one",
      query: "spec",
      turnScope: { revision: 2, vaultIds: ["new"], personalEnabled: true },
    });
    expect(captureScope).toHaveBeenCalledTimes(2);
    await supplement.search({ ...context, vaultId: "explicit", query: "spec" });
    expect(search).toHaveBeenLastCalledWith({
      agentId: "person_one",
      vaultId: "explicit",
      query: "spec",
    });
    await supplement.search({ agentId: "person_one", query: "browser" });
    expect(search).toHaveBeenLastCalledWith({ agentId: "person_one", query: "browser" });
    expect(() => controller.get({ ...context, agentId: "another" })).toThrow("unavailable");
  });

  it.each([
    { revision: 1, vaultIds: ["invalid/path"], personalEnabled: true },
    { revision: 1, vaultIds: ["duplicate", "duplicate"], personalEnabled: true },
    { revision: -1, vaultIds: [], personalEnabled: true },
    { revision: 1, vaultIds: [], personalEnabled: "true" },
    {
      revision: 1,
      vaultIds: Array.from({ length: 257 }, (_, i) => `v-${i}`),
      personalEnabled: true,
    },
  ])(
    "records failed capture without broadening or recapturing in the same turn",
    async (invalid) => {
      const api = fixture();
      const captureScope = vi.fn(async () => invalid);
      const controller = createVaultTurnScopeController(api, { captureScope });
      const context = { runId: "failed", agentId: "person_one" };
      await controller.prepare(context);
      await controller.prepare(context);
      expect(captureScope).toHaveBeenCalledTimes(1);
      expect(() => controller.get(context)).toThrow("next message");
      expect(() => controller.get({ ...context, runId: "unprepared" })).toThrow("next message");
      expect(() => controller.get({ ...context, runId: "unprepared" })).toThrow(
        "hooks.allowPromptInjection",
      );
      const search = vi.fn(async () => []);
      const supplement = createWikiHubCorpusSupplement(
        { search, get: vi.fn() },
        api.logger,
        controller.get,
      );
      await expect(supplement.search({ ...context, query: "spec" })).rejects.toThrow(
        "next message",
      );
      expect(search).not.toHaveBeenCalled();
      await supplement.search({ ...context, query: "spec", vaultId: "named" });
      expect(search).toHaveBeenCalledWith({
        agentId: "person_one",
        query: "spec",
        vaultId: "named",
      });
    },
  );

  it.each(["end", "error"])(
    "host terminal %s clears scope and rejects late capture",
    async (phase) => {
      const api = fixture();
      let release!: (value: {
        revision: number;
        vaultIds: string[];
        personalEnabled: boolean;
      }) => void;
      const captureScope = vi.fn(
        () =>
          new Promise<{ revision: number; vaultIds: string[]; personalEnabled: boolean }>(
            (resolve) => {
              release = resolve;
            },
          ),
      );
      const controller = createVaultTurnScopeController(api, { captureScope });
      const context = { runId: "terminal", agentId: "person_one" };
      const pending = controller.prepare(context);
      expect(
        api.agent.events.emitAgentEvent({
          runId: context.runId,
          stream: "lifecycle",
          data: { phase },
        }).emitted,
      ).toBe(true);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      release({ revision: 1, vaultIds: ["late"], personalEnabled: true });
      await pending;
      await controller.prepare(context);
      expect(captureScope).toHaveBeenCalledTimes(1);
      expect(() => controller.get(context)).toThrow("unavailable");
      expect(
        api.runContext.getRunContext({ runId: context.runId, namespace: "vault-connections" }),
      ).toBeUndefined();
    },
  );
});
