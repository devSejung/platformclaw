import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKnoxInboundIdentityGuard,
  KnoxInboundIdentityConflictError,
} from "./inbound-identity.js";
import { knoxRequestFingerprint } from "./routing-client.js";
import type { KnoxInboundMessage } from "./types.js";

const personal = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/self-in-space.json", import.meta.url), "utf8"),
) as Extract<KnoxInboundMessage, { schemaVersion: 2 }>;
const state: Pick<PluginRuntime["state"], "openKeyedStore"> = {
  openKeyedStore: <T>(options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0]) =>
    createPluginStateKeyedStoreForTests<T>("knox", { ...options, env: process.env }),
};
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "knox-upgrade-identity-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
});
afterEach(async () => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Knox transport identity during an upgrade", () => {
  it.each([1, 2] as const)(
    "keeps native v%s receipts authoritative after bounded cache eviction",
    async (schemaVersion) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1000);
      const smallState: Pick<PluginRuntime["state"], "openKeyedStore"> = {
        openKeyedStore: <T>(options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0]) =>
          createPluginStateKeyedStoreForTests<T>("knox", {
            ...options,
            maxEntries: 2,
            env: process.env,
          }),
      };
      const openQueues = () => ({
        legacy: createChannelIngressQueueForTests({
          channelId: "knox",
          accountId: "default",
          stateDir: directory,
        }),
        personal: createChannelIngressQueueForTests({
          channelId: "knox",
          accountId: "default",
          queueNamespace: "self-in-space-v2",
          stateDir: directory,
        }),
      });
      let queues = openQueues();
      const guardOptions = {
        state: smallState,
        hasLegacyReceipt: async (id: string) => queues.legacy.has!(id),
        hasPersonalReceipt: async (id: string) => queues.personal.has!(id),
      };
      const guard = createKnoxInboundIdentityGuard(guardOptions);
      const { executionMode: _executionMode, ...common } = personal;
      const ordinary: KnoxInboundMessage = { ...common, schemaVersion: 1 };
      const original = schemaVersion === 1 ? ordinary : personal;
      await guard.assertInboundIdentity(original, "default");
      const originalQueue = schemaVersion === 1 ? queues.legacy : queues.personal;
      await originalQueue.enqueue(original.messageId, {
        version: schemaVersion,
        rawEvent: JSON.stringify(original),
      });
      await originalQueue.complete(original.messageId);
      for (let index = 1; index <= 5; index += 1) {
        vi.setSystemTime(1000 + index);
        const request = { ...ordinary, messageId: `ordinary-${index}` };
        await expect(guard.assertInboundIdentity(request, "default")).resolves.toBeUndefined();
        await queues.legacy.enqueue(request.messageId, {
          version: 1,
          rawEvent: JSON.stringify(request),
        });
        await queues.legacy.complete(request.messageId);
      }
      const cache = smallState.openKeyedStore<{ fingerprint: string }>({
        namespace: "inbound-identities",
        maxEntries: 2,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: 60 * 24 * 60 * 60 * 1000,
      });
      const entries = await cache.entries();
      expect(entries).toHaveLength(2);
      expect(
        entries.some((entry) => entry.value.fingerprint === knoxRequestFingerprint(original)),
      ).toBe(false);
      resetPluginStateStoreForTests();
      closeOpenClawStateDatabaseForTest();
      queues = openQueues();
      const restored = createKnoxInboundIdentityGuard(guardOptions);
      const replay = schemaVersion === 1 ? personal : ordinary;
      await expect(restored.assertInboundIdentity(replay, "default")).rejects.toBeInstanceOf(
        KnoxInboundIdentityConflictError,
      );
      await expect(
        restored.assertInboundIdentity({ ...ordinary, messageId: "after-reopen" }, "default"),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["pending", "claimed", "completed", "failed"] as const)(
    "refuses v2 replay of a pre-upgrade %s v1 receipt",
    async (status) => {
      const legacy = createChannelIngressQueueForTests({
        channelId: "knox",
        accountId: "default",
        stateDir: directory,
      });
      const { executionMode: _executionMode, ...common } = personal;
      const ordinary: KnoxInboundMessage = { ...common, schemaVersion: 1 };
      await legacy.enqueue(personal.messageId, { version: 1, rawEvent: JSON.stringify(ordinary) });
      if (status === "claimed") {
        await legacy.claim(personal.messageId);
      } else if (status === "completed") {
        await legacy.complete(personal.messageId);
      } else if (status === "failed") {
        await legacy.fail(personal.messageId, { reason: "fixture" });
      }
      closeOpenClawStateDatabaseForTest();
      const restored = createChannelIngressQueueForTests({
        channelId: "knox",
        accountId: "default",
        stateDir: directory,
      });
      const guard = createKnoxInboundIdentityGuard({
        state,
        hasLegacyReceipt: async (id) => {
          if (!restored.has) {
            throw new Error("native identity lookup unavailable");
          }
          return await restored.has(id);
        },
      });
      await expect(guard.assertInboundIdentity(personal, "default")).rejects.toBeInstanceOf(
        KnoxInboundIdentityConflictError,
      );
      expect(
        (
          await restored.enqueue(personal.messageId, {
            version: 2,
            rawEvent: JSON.stringify(personal),
          })
        ).kind,
      ).toBe(status);
    },
  );

  it("keeps v1 available but refuses v2 when legacy identity lookup is unavailable", async () => {
    const guard = createKnoxInboundIdentityGuard({ state });
    const { executionMode: _executionMode, ...common } = personal;
    const ordinary: KnoxInboundMessage = { ...common, schemaVersion: 1 };
    await expect(guard.assertInboundIdentity(ordinary, "default")).resolves.toBeUndefined();
    await expect(
      guard.assertInboundIdentity({ ...personal, messageId: "another-message" }, "default"),
    ).rejects.toThrow("receipt lookup is unavailable");
  });
});
