import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASEBALL_RPC } from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadPendingWorkshop,
  savePendingWorkshop,
  clearPendingWorkshop,
  claimWorkshopTaunt,
} from "./easter-egg-workshop-journal.ts";

describe("baseball workshop receipt journal", () => {
  beforeEach(() => {
    const testNavigator = Object.create(navigator);
    Object.defineProperty(testNavigator, "locks", {
      value: { request: async (_name: string, callback: () => boolean) => callback() },
    });
    vi.stubGlobal("navigator", testNavigator);
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bounds completed receipts without letting a stale tab recreate an evicted request", async () => {
    const scope = "synthetic-bounded-journal";
    const first = {
      method: BASEBALL_RPC.enhanceBat,
      params: { requestId: "old-receipt", expectedRevision: 0 },
    };
    expect(savePendingWorkshop(scope, first)).toBe(true);
    await clearPendingWorkshop(scope, first);
    for (let index = 0; index < 138; index += 1) {
      const mutation = {
        method: BASEBALL_RPC.enhanceBat,
        params: { requestId: `receipt-${index}`, expectedRevision: index + 1 },
      };
      expect(savePendingWorkshop(scope, mutation)).toBe(true);
      await clearPendingWorkshop(scope, mutation);
    }
    expect(localStorage.length).toBe(1);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toHaveLength(128);
    expect(savePendingWorkshop(scope, first, true)).toBe(false);
    await clearPendingWorkshop(scope, first);
    expect(await claimWorkshopTaunt(scope, "old-receipt")).toBe(false);
    expect(loadPendingWorkshop(scope)).toEqual([]);
  });

  it("does not consume a cosmetic claim while its display surface is hidden or gone", async () => {
    const scope = "synthetic-visible-claim";
    const mutation = {
      method: BASEBALL_RPC.enhanceBat,
      params: { requestId: "display-once", expectedRevision: 0 },
    };
    expect(savePendingWorkshop(scope, mutation)).toBe(true);
    await clearPendingWorkshop(scope, mutation);
    expect(await claimWorkshopTaunt(scope, "display-once", () => false)).toBe(false);
    expect(await claimWorkshopTaunt(scope, "display-once", () => true)).toBe(true);
    expect(await claimWorkshopTaunt(scope, "display-once", () => true)).toBe(false);
  });
});
