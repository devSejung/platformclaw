import { describe, expect, it, vi } from "vitest";
import { reportBrowserGatewayRequestFailure } from "./browser-gateway-errors.js";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";
import { BrowserSpaceGateway } from "./browser-gateway-spaces.js";
import { FISHING_RPC, type FishingSnapshot, type FishingStore } from "./fishing-contracts.js";

describe("BrowserGatewayProxy current dispatch authority", () => {
  it("reports a completed local mutation as outcome unknown when logout prevents its response", async () => {
    const fishing = {
      executeFishing: vi.fn<FishingStore["executeFishing"]>(),
      loadFishingSnapshot: vi.fn<FishingStore["loadFishingSnapshot"]>(),
      loadFishingLeaderboard: vi.fn<FishingStore["loadFishingLeaderboard"]>(),
    };
    const { created, proxy, request, store, token, user } = await setup({ fishingStore: fishing });
    const committed: FishingSnapshot = {
      serverNow: NOW,
      economyVersion: 1,
      gold: 0,
      walletRevision: 1,
      revision: 1,
      totalCaught: 0,
      totalEarnedGold: 0,
      bestCatch: null,
      goals: { dailyCaught: 0, weeklyCaught: 0 },
      attempt: {
        id: "issued-attempt",
        issuedAt: NOW,
        biteAt: NOW + 15000,
        hookDeadlineAt: NOW + 15650,
        seed: 7,
        phase: "waiting",
        quality: null,
        behavior: null,
        difficulty: null,
        nibbles: [],
        hookedAt: null,
        finishStartedAt: null,
        finishDeadlineAt: null,
        inputs: [],
        fight: null,
        result: null,
      },
    };
    fishing.executeFishing.mockImplementation(() => {
      // Memory-store revocation records its fact synchronously before returning
      // its Promise, placing logout after the effect but before response checking.
      void store.revokeBrowserSession(created.session.id, NOW);
      return committed;
    });
    const params = { requestId: "accepted-cast" };
    const error: unknown = await proxy
      .request(token, FISHING_RPC.begin, params)
      .catch((failure: unknown) => failure);
    expect(fishing.executeFishing).toHaveBeenCalledExactlyOnceWith(
      user.id,
      {
        action: "begin",
        ...params,
      },
      NOW,
    );
    expect(request).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: "unauthenticated", requestDisposition: "outcome-unknown" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        reportBrowserGatewayRequestFailure(error, { method: FISHING_RPC.begin, elapsedMs: 1 }),
      ).toMatchObject({
        code: "UNAUTHENTICATED",
        details: { errorKind: "proxy-rejection", requestDisposition: "outcome-unknown" },
      });
    } finally {
      log.mockRestore();
    }
  });

  it("does not mutate local game state after logout during awaited Space dispatch", async () => {
    const fishing = {
      executeFishing: vi.fn<FishingStore["executeFishing"]>(),
      loadFishingSnapshot: vi.fn<FishingStore["loadFishingSnapshot"]>(),
      loadFishingLeaderboard: vi.fn<FishingStore["loadFishingLeaderboard"]>(),
    };
    const { created, proxy, request, store, token } = await setup({ fishingStore: fishing });
    const spaceDispatch = vi
      .spyOn(BrowserSpaceGateway.prototype, "request")
      .mockImplementationOnce(async () => {
        await store.revokeBrowserSession(created.session.id, NOW);
        return { handled: false };
      });
    try {
      await expect(
        proxy.request(token, FISHING_RPC.begin, {
          requestId: "revoked-cast",
        }),
      ).rejects.toMatchObject({ code: "unauthenticated" });
      expect(spaceDispatch).toHaveBeenCalledOnce();
      expect(fishing.executeFishing).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      spaceDispatch.mockRestore();
    }
  });

  for (const method of ["sessions.create", "sessions.patch"] as const) {
    it(`${method} does not dispatch after logout during model validation`, async () => {
      const { binding, created, proxy, request, store, token } = await setup();
      const key = `agent:${binding.agentId}:dashboard:authority`;
      request.mockImplementation(async (rpcMethod) => {
        expect(rpcMethod).toBe("models.list");
        await store.revokeBrowserSession(created.session.id, NOW);
        return { models: [{ id: "model", provider: "provider" }] };
      });
      await expect(
        proxy.request(token, method, { key, model: "provider/model" }),
      ).rejects.toMatchObject({
        code: "unauthenticated",
        requestDisposition: "rejected-before-dispatch",
      });
      expect(request).toHaveBeenCalledExactlyOnceWith("models.list", { view: "configured" });
    });
  }

  it("records a created session's unsent first turn when authority expires during creation", async () => {
    const { binding, created, proxy, request, store, token } = await setup();
    const key = `agent:${binding.agentId}:dashboard:authority`;
    request.mockImplementation(async (method) => {
      expect(method).toBe("sessions.create");
      await store.revokeBrowserSession(created.session.id, NOW);
      return { ok: true, key };
    });
    await expect(
      proxy.request(token, "sessions.create", { key, message: "hello" }),
    ).resolves.toMatchObject({
      ok: true,
      key,
      runStarted: false,
      runError: { message: "active browser session required" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a disabled Agent binding before dispatch", async () => {
    const { binding, proxy, request, store, token } = await setup();
    request.mockImplementation(async () => {
      await store.transitionAgent({ bindingId: binding.id, state: "disabled", changedAt: NOW });
      return { models: [{ id: "model", provider: "provider" }] };
    });
    await expect(
      proxy.request(token, "sessions.patch", {
        key: `agent:${binding.agentId}:main`,
        model: "provider/model",
      }),
    ).rejects.toMatchObject({ code: "agent-unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
