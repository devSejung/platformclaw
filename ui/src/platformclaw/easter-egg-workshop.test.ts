import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballEnhanceBatResult,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { getBaseballEnhancementAppearance } from "../../../packages/platformclaw-control-plane/src/baseball-enhancement.ts";
import { GatewayRequestError } from "../api/gateway.ts";
import type { BaseballMutation } from "./easter-egg-persistence.ts";
import {
  loadPendingWorkshop,
  savePendingWorkshop,
  clearPendingWorkshop,
} from "./easter-egg-workshop-journal.ts";
import "./easter-egg-game.ts";
import { PLATFORMCLAW_EASTER_EGG_EVENT } from "./easter-egg.ts";
import { platformClawT as t } from "./i18n.ts";

type WorkshopElement = HTMLElement & {
  client: { request<T>(method: string, params?: unknown): Promise<T> } | null;
  now: () => number;
  random: () => number;
  preferenceScope: string | null;
  updateComplete: Promise<unknown>;
  progress: BaseballProgress | null;
  pendingMutation: unknown;
  workshopNotice: unknown;
  workshopEffect: string;
  workshopTaunt: string;
  awardedGold: number;
  startGame: () => Promise<void>;
  resolveAtBat: (outcome: "home_run" | "miss", distance?: number) => void;
  runMutation: (mutation: BaseballMutation) => Promise<void>;
  confirmWorkshop: (method: string, id: string, response: unknown) => void;
};

function progress(overrides: Partial<BaseballProgress> = {}): BaseballProgress {
  return {
    gold: 1_000,
    ownedBatIds: ["wood"],
    equippedBatId: "wood",
    totalHomers: 0,
    bestDistanceM: 0,
    currentHomeRunStreak: 0,
    bestHomeRunStreak: 0,
    revision: 0,
    ...overrides,
  };
}

function enhanced(level = 0, overrides: Partial<BaseballProgress> = {}): BaseballProgress {
  return progress({
    enhancement: { level, status: "ready", equipped: true, version: 1 },
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(egg: WorkshopElement): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await egg.updateComplete;
  }
}

function button(egg: WorkshopElement, selector: string): HTMLButtonElement {
  const value = egg.querySelector<HTMLButtonElement>(selector);
  expect(value).not.toBeNull();
  return value!;
}

async function click(egg: WorkshopElement, selector: string): Promise<void> {
  button(egg, selector).click();
  await flush(egg);
}

function notifyJournal(kind: "pending" | "receipts" = "pending"): void {
  const key = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).find((value) => value?.includes(`${kind}.v1`))!;
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

function queueEnhancement(egg: WorkshopElement, requestId: string, expectedRevision: number): void {
  expect(
    savePendingWorkshop(egg.preferenceScope, {
      method: BASEBALL_RPC.enhanceBat,
      params: { requestId, expectedRevision },
    }),
  ).toBe(true);
}

function requestCount(request: { mock: { calls: unknown[][] } }, method: string): number {
  return request.mock.calls.filter(([called]) => called === method).length;
}

function preview(egg: WorkshopElement): HTMLElement {
  return egg.querySelector<HTMLElement>(".platformclaw-baseball-forge__preview")!;
}

async function openWorkshop(
  initial: BaseballProgress,
  mutate: (method: string, params: Record<string, unknown>) => unknown,
  scope = JSON.stringify(["wss://synthetic.test/gateway", "workshop-account-a"]),
) {
  const egg = document.createElement("platformclaw-easter-egg") as WorkshopElement;
  let serverProgress = initial;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === BASEBALL_RPC.progress) {
      return serverProgress;
    }
    if (method === BASEBALL_RPC.leaderboard) {
      return { distance: [], homeRunStreak: [] };
    }
    if (method === BASEBALL_RPC.beginAtBat) {
      const state = serverProgress.enhancement;
      return {
        id: "synthetic-workshop-at-bat",
        pitchSample: 0,
        batId: getBaseballEnhancementAppearance(state?.level ?? 0).batId,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 120_000,
        enhancementLevel: state?.level ?? 0,
        powerRuleVersion: "sweetspot-v1",
      };
    }
    return mutate(method, params as Record<string, unknown>);
  });
  egg.client = {
    request: async <T>(method: string, params?: unknown) => (await request(method, params)) as T,
  };
  egg.now = () => Date.now();
  egg.random = () => 0;
  egg.preferenceScope = scope;
  document.body.append(egg);
  await flush(egg);
  window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
  await flush(egg);
  button(egg, '[data-game-choice="baseball"]').click();
  await flush(egg);
  await click(egg, ".platformclaw-easter-egg__shop-trigger");
  return {
    egg,
    request,
    setServerProgress: (value: BaseballProgress) => {
      serverProgress = value;
    },
  };
}

function receipt(
  params: Record<string, unknown>,
  next: BaseballProgress,
  overrides: Partial<BaseballEnhanceBatResult> = {},
): BaseballEnhanceBatResult {
  return {
    requestId: params.requestId as string,
    outcome: "success",
    fromLevel: 0,
    targetLevel: 1,
    level: 1,
    chargedGold: 100,
    evolved: false,
    automaticRestart: false,
    progress: next,
    ...overrides,
  };
}

describe("baseball enhancement workshop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    const testNavigator = Object.create(navigator);
    Object.defineProperty(testNavigator, "locks", {
      value: { request: async (_name: string, callback: () => boolean) => callback() },
    });
    vi.stubGlobal("navigator", testNavigator);
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "legacy diamond owner without enhancement",
      initial: progress({
        gold: 5_000,
        revision: 7,
        ownedBatIds: ["wood", "diamond"],
        equippedBatId: "diamond",
        totalHomers: 9,
        bestDistanceM: 147,
        bestHomeRunStreak: 4,
        teamId: "lg",
      }),
      level: 0,
    },
    { name: "new player", initial: progress(), level: 0 },
    { name: "existing enhanced player", initial: enhanced(7), level: 7 },
    {
      name: "unequipped enhancement with a historical diamond",
      initial: enhanced(12, {
        ownedBatIds: ["wood", "diamond"],
        equippedBatId: "diamond",
        enhancement: { level: 12, status: "ready", equipped: false, version: 1 },
      }),
      level: 12,
    },
  ])(
    "uses only enhancement for $name and preserves it across reconnect",
    async ({ initial, level }) => {
      const { egg, request } = await openWorkshop(initial, () => {
        throw new Error("Opening the workshop must not mutate account data");
      });
      const appearance = getBaseballEnhancementAppearance(level);
      const assertEnhancement = () => {
        expect(egg.progress).toEqual(initial);
        expect(egg.querySelector("[data-forge-equip]")).toBeNull();
        expect(egg.querySelector("[data-shop-bat]")).toBeNull();
        expect(egg.querySelector("[data-enhancement-level]")?.textContent).toContain(`+${level}`);
        expect(egg.querySelector(".platformclaw-easter-egg__shop-trigger")?.textContent).toContain(
          `+${level}`,
        );
        expect(egg.querySelector<HTMLElement>('[role="application"]')?.dataset).toMatchObject({
          batId: appearance.batId,
          batAppearance: appearance.appearanceId,
          roundEnhancement: String(level),
        });
      };
      assertEnhancement();
      const client = egg.client;
      egg.client = null;
      await flush(egg);
      egg.client = client;
      await flush(egg);
      assertEnhancement();
      expect(requestCount(request, BASEBALL_RPC.progress)).toBe(2);
      for (const method of [
        BASEBALL_RPC.purchaseBat,
        BASEBALL_RPC.equipBat,
        BASEBALL_RPC.equipEnhancedBat,
      ]) {
        expect(requestCount(request, method)).toBe(0);
      }
    },
  );

  it("settles a previously journaled opt-in receipt without exposing a new equip action", async () => {
    const scope = "synthetic-historical-opt-in";
    const intent = {
      method: BASEBALL_RPC.equipEnhancedBat,
      params: { requestId: "previous-opt-in", expectedRevision: 7 },
    };
    expect(savePendingWorkshop(scope, intent)).toBe(true);
    const committed = enhanced(0, { gold: 5_000, revision: 8, equippedBatId: "diamond" });
    const { egg, request } = await openWorkshop(
      committed,
      (method, params) => {
        expect(method).toBe(intent.method);
        expect(params).toEqual(intent.params);
        return { requestId: params.requestId, changed: true, progress: committed };
      },
      scope,
    );
    expect(egg.querySelector("[data-forge-equip]")).toBeNull();
    expect(requestCount(request, BASEBALL_RPC.beginAtBat)).toBe(0);
    await click(egg, ".platformclaw-easter-egg__save-status button");
    expect(egg.pendingMutation).toBeNull();
    expect(loadPendingWorkshop(scope)).toEqual([]);
    expect(egg.progress).toEqual(committed);
    expect(requestCount(request, BASEBALL_RPC.equipEnhancedBat)).toBe(1);
  });

  it("ignores a second click and changes level and feedback only after the confirmed receipt", async () => {
    const reply = deferred<unknown>();
    const { egg, request } = await openWorkshop(enhanced(), () => reply.promise);
    const enhance = button(egg, "[data-forge-enhance]");
    enhance.click();
    enhance.click();
    await flush(egg);
    expect(requestCount(request, BASEBALL_RPC.enhanceBat)).toBe(1);
    expect(
      egg.querySelector("[data-enhancement-level]")?.getAttribute("data-enhancement-level"),
    ).toBe("0");
    expect(preview(egg).dataset.effect).toBe("");
    expect(egg.querySelector("[data-forge-result]")).toBeNull();
    expect(egg.querySelector("[data-forge-taunt]")).toBeNull();
    const params = request.mock.calls.find(
      ([method]) => method === BASEBALL_RPC.enhanceBat,
    )![1] as Record<string, unknown>;
    reply.resolve(receipt(params, enhanced(1, { gold: 900, revision: 1 })));
    await flush(egg);
    expect(egg.progress).toMatchObject({ gold: 900, revision: 1, enhancement: { level: 1 } });
    expect(preview(egg).dataset.effect).toBe("success");
    expect(egg.querySelector("[data-forge-taunt]")).toBeNull();
    expect(egg.querySelector('[data-forge-result="success"]')?.textContent).toContain("100G");
  });

  it("shows the server's charged maintain outcome while keeping the same level", async () => {
    const { egg } = await openWorkshop(enhanced(), (_method, params) =>
      receipt(params, enhanced(0, { gold: 900, revision: 1 }), { outcome: "maintain", level: 0 }),
    );
    await click(egg, "[data-forge-enhance]");
    expect(egg.progress).toMatchObject({ gold: 900, enhancement: { level: 0 } });
    expect(egg.querySelector('[data-forge-result="maintain"]')?.textContent).toContain("100G");
    expect(preview(egg).dataset.effect).toBe("maintain");
  });

  it.each(["maintain", "drop", "destroy", "total_destroy"] as const)(
    "shows a nonblocking taunt for exactly two seconds only after confirmed %s",
    async (outcome) => {
      const { egg } = await openWorkshop(enhanced(15, { gold: 50_000 }), (_method, params) =>
        receipt(
          params,
          enhanced(0, {
            gold: 40_000,
            revision: 1,
            enhancement: {
              level: 0,
              status: outcome === "destroy" ? "broken" : "ready",
              equipped: true,
              version: 1,
            },
          }),
          { outcome, level: 0 },
        ),
      );
      expect(egg.querySelector("[data-forge-taunt]")).toBeNull();
      await click(egg, "[data-forge-enhance]");
      expect([
        "줴줴이야~",
        "ㅋㅋ",
        "ㅋ",
        "ㅋㅋㄹㅇ",
        "어림없지",
        "다시 와라",
        "ㅈㄴ못하네~",
      ]).toContain(egg.querySelector("[data-forge-taunt]")?.textContent?.trim());
      const action = outcome === "destroy" ? "[data-forge-recover]" : "[data-forge-enhance]";
      expect(button(egg, action).disabled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(egg.querySelector("[data-forge-taunt]")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await flush(egg);
      expect(egg.querySelector("[data-forge-taunt]")).toBeNull();
      expect(egg.querySelector(`[data-forge-result="${outcome}"]`)).not.toBeNull();
    },
  );

  it("replaces the taunt timer for a new result, suppresses a replay and cleans up on removal", async () => {
    let revision = 0;
    const { egg } = await openWorkshop(enhanced(0, { gold: 5_000 }), (_method, params) =>
      receipt(params, enhanced(0, { gold: 5_000 - 100 * ++revision, revision }), {
        outcome: "maintain",
        level: 0,
      }),
    );
    await click(egg, "[data-forge-enhance]");
    await vi.advanceTimersByTimeAsync(1_000);
    await click(egg, "[data-forge-enhance]");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(egg.querySelector("[data-forge-taunt]")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(egg);
    expect(egg.querySelector("[data-forge-taunt]")).toBeNull();
    const notice = egg.workshopNotice as { requestId: string };
    egg.confirmWorkshop(
      BASEBALL_RPC.enhanceBat,
      notice.requestId,
      receipt({ requestId: notice.requestId }, egg.progress!, { outcome: "maintain", level: 0 }),
    );
    await flush(egg);
    expect(egg.querySelector("[data-forge-taunt]")).toBeNull();
    await click(egg, "[data-forge-enhance]");
    expect(egg.querySelector("[data-forge-taunt]")).not.toBeNull();
    egg.remove();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(egg.workshopTaunt).toBe("");
  });

  it("retries a lost response with the identical request ID and revision without speculative effects", async () => {
    let attempts = 0;
    const { egg, request } = await openWorkshop(enhanced(0, { revision: 4 }), (_method, params) => {
      if (++attempts === 1) {
        throw new Error("synthetic response lost");
      }
      return receipt(params, enhanced(1, { gold: 900, revision: 5 }));
    });
    await click(egg, "[data-forge-enhance]");
    expect(egg.progress?.enhancement?.level).toBe(0);
    expect(preview(egg).dataset.effect).toBe("");
    expect(egg.querySelector("[data-forge-result]")).toBeNull();
    expect(egg.pendingMutation).not.toBeNull();
    await click(egg, ".platformclaw-easter-egg__save-status button");
    const attemptsMade = request.mock.calls.filter(
      ([method]) => method === BASEBALL_RPC.enhanceBat,
    );
    expect(attemptsMade).toHaveLength(2);
    expect(attemptsMade[1]![1]).toEqual(attemptsMade[0]![1]);
    expect(attemptsMade[0]![1]).toMatchObject({ expectedRevision: 4 });
    expect(egg.progress).toMatchObject({ gold: 900, revision: 5, enhancement: { level: 1 } });
    expect(egg.pendingMutation).toBeNull();
    expect(preview(egg).dataset.effect).toBe("success");
  });

  it("evolves +2 into named silver +3, clears its effect at 700ms and retains its receipt", async () => {
    const { egg } = await openWorkshop(enhanced(2, { revision: 10 }), (_method, params) =>
      receipt(params, enhanced(3, { gold: 800, revision: 11 }), {
        fromLevel: 2,
        targetLevel: 3,
        level: 3,
        chargedGold: 200,
        evolved: true,
      }),
    );
    await click(egg, "[data-forge-enhance]");
    expect(egg.querySelector("[data-enhancement-level]")?.textContent).toBe("실버 +3");
    expect(preview(egg).dataset.appearance).toBe("silver");
    expect(preview(egg).dataset.effect).toBe("evolution");
    await vi.advanceTimersByTimeAsync(699);
    await flush(egg);
    expect(preview(egg).dataset.effect).toBe("evolution");
    await vi.advanceTimersByTimeAsync(1);
    await flush(egg);
    expect(preview(egg).dataset.effect).toBe("");
    expect(egg.querySelector('[data-forge-result="success"]')?.textContent).toContain("+3");
  });

  it.each(["remove", "account switch"] as const)(
    "clears receipt and effect on %s",
    async (change) => {
      const { egg } = await openWorkshop(enhanced(), (_method, params) =>
        receipt(params, enhanced(1, { gold: 900, revision: 1 })),
      );
      await click(egg, "[data-forge-enhance]");
      expect(egg.workshopNotice).not.toBeNull();
      expect(egg.workshopEffect).toBe("success");
      if (change === "remove") {
        egg.remove();
      } else {
        egg.preferenceScope = JSON.stringify([
          "wss://synthetic.test/gateway",
          "workshop-account-b",
        ]);
      }
      await flush(egg);
      expect(egg.workshopNotice).toBeNull();
      expect(egg.workshopEffect).toBe("");
      await vi.advanceTimersByTimeAsync(700);
      expect(egg.workshopNotice).toBeNull();
      if (change === "account switch") {
        expect(egg.querySelector('[role="application"]')).toBeNull();
      }
    },
  );

  it.each([
    { action: "restore", gold: 20_000, outcome: "restored", level: 12, chargedGold: 15_000 },
    { action: "restart", gold: 20_000, outcome: "restarted", level: 0, chargedGold: 0 },
    { action: "restore", gold: 5_000, outcome: "restarted", level: 0, chargedGold: 0 },
  ] as const)("renders confirmed $action with $gold G as $outcome +$level", async (scenario) => {
    const initial = enhanced(0, {
      gold: scenario.gold,
      revision: 42,
      enhancement: { level: 0, status: "broken", equipped: true, version: 1 },
    });
    const { egg, request } = await openWorkshop(initial, (method, params) => {
      expect(method).toBe(BASEBALL_RPC.recoverBat);
      return {
        requestId: params.requestId,
        outcome: scenario.outcome,
        chargedGold: scenario.chargedGold,
        progress: enhanced(scenario.level, {
          gold: scenario.gold - scenario.chargedGold,
          revision: 43,
        }),
      };
    });
    expect(egg.querySelector("[data-forge-enhance]")).toBeNull();
    const recover = button(egg, `[data-forge-recover="${scenario.action}"]`);
    expect(recover.disabled).toBe(false);
    recover.click();
    await flush(egg);
    const params = request.mock.calls.find(([method]) => method === BASEBALL_RPC.recoverBat)![1];
    expect(params).toMatchObject({ expectedRevision: 42, action: scenario.action });
    expect(egg.progress).toMatchObject({
      gold: scenario.gold - scenario.chargedGold,
      enhancement: { level: scenario.level, status: "ready" },
    });
    expect(egg.querySelector(`[data-forge-result="${scenario.outcome}"]`)).not.toBeNull();
    expect(preview(egg).dataset.effect).toBe(scenario.outcome);
    expect(egg.querySelector("[data-forge-recover]")).toBeNull();
  });

  it("renders star diamond +20 and offers no further enhancement", async () => {
    const { egg, request } = await openWorkshop(enhanced(20, { gold: 100_000 }), () => {
      throw new Error("unexpected max-level mutation");
    });
    expect(preview(egg).dataset.appearance).toBe("star-diamond");
    expect(preview(egg).dataset.bat).toBe("diamond");
    expect(egg.querySelector("[data-enhancement-level]")?.textContent).toBe("스타 다이아 +20");
    expect(egg.querySelector("[data-forge-max]")).not.toBeNull();
    expect(egg.querySelector("[data-forge-enhance]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === BASEBALL_RPC.enhanceBat)).toBe(false);
  });

  it("keeps the replayed result but reconciles a newer racing-wallet revision before another click", async () => {
    const initial = enhanced(0, { gold: 1000, revision: 4 });
    const committed = enhanced(1, { gold: 900, revision: 5 });
    const latest = enhanced(1, { gold: 850, revision: 6, teamId: "lg" });
    const attempts: Record<string, unknown>[] = [];
    const { egg, request, setServerProgress } = await openWorkshop(initial, (_method, params) => {
      attempts.push(params);
      if (attempts.length === 1) {
        throw new Error("committed response lost");
      }
      return receipt(params, committed);
    });
    await click(egg, "[data-forge-enhance]");
    setServerProgress(latest);
    expect(egg.querySelectorAll(".platformclaw-easter-egg__save-status button")).toHaveLength(1);
    await click(egg, ".platformclaw-easter-egg__shop header button");
    expect(egg.querySelector('[role="dialog"]')).toBeNull();
    expect(egg.pendingMutation).not.toBeNull();
    expect(egg.querySelector(".platformclaw-easter-egg__save-status button")).not.toBeNull();
    await click(egg, ".platformclaw-easter-egg__shop-trigger");
    egg
      .querySelectorAll<HTMLButtonElement>(".platformclaw-easter-egg__save-status button")[0]!
      .click();
    await flush(egg);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(egg.progress).toMatchObject(latest);
    expect(egg.querySelector('[data-forge-result="success"]')?.textContent).toContain("100G");
    expect(egg.querySelector<HTMLElement>('[role="application"]')?.dataset.teamId).toBe("lg");
    expect(requestCount(request, BASEBALL_RPC.progress)).toBe(2);
    expect(egg.pendingMutation).toBeNull();
  });

  it("does not retry a confirmed mutation when its latest-wallet read fails", async () => {
    const initial = enhanced(0, { gold: 1000, revision: 4 });
    const committed = enhanced(1, { gold: 900, revision: 5 });
    let attempts = 0;
    const { egg } = await openWorkshop(initial, (_method, params) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("committed response lost");
      }
      return receipt(params, committed);
    });
    await click(egg, "[data-forge-enhance]");
    const request = egg.client!.request.bind(egg.client);
    egg.client!.request = async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === BASEBALL_RPC.progress) {
        throw new Error("balance read offline");
      }
      return request<T>(method, params);
    };
    egg
      .querySelectorAll<HTMLButtonElement>(".platformclaw-easter-egg__save-status button")[0]!
      .click();
    await flush(egg);
    expect(attempts).toBe(2);
    expect(egg.pendingMutation).toBeNull();
    expect(egg.progress).toMatchObject(committed);
    expect(egg.querySelector('[data-forge-result="success"]')).not.toBeNull();
    expect(egg.querySelector(".platformclaw-easter-egg__save-status")?.textContent).toContain(
      "결과 확인됨",
    );
  });

  it.each(["games", "racing", "close", "trigger", "remove"] as const)(
    "recovers the identical paid intent after %s and recreating the element",
    async (exit) => {
      const initial = enhanced(0, { gold: 1000, revision: 4 });
      const committed = enhanced(1, { gold: 900, revision: 5 });
      let original: Record<string, unknown> | undefined;
      const first = await openWorkshop(initial, (_method, params) => {
        original = params;
        throw new Error("committed response lost");
      });
      await click(first.egg, "[data-forge-enhance]");
      if (exit === "trigger") {
        window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
      } else if (exit !== "remove") {
        const index = ["games", "racing", "close"].indexOf(exit);
        const navigation = first.egg.querySelectorAll<HTMLButtonElement>(
          ".platformclaw-games-nav button",
        );
        navigation[index]!.click();
      }
      first.egg.remove();
      const next = await openWorkshop(committed, (_method, params) => {
        expect(params).toEqual(original);
        return receipt(params, committed);
      });
      expect(next.egg.pendingMutation).toMatchObject({ params: original });
      expect(next.request.mock.calls.some(([method]) => method === BASEBALL_RPC.beginAtBat)).toBe(
        false,
      );
      button(next.egg, ".platformclaw-easter-egg__save-status button").click();
      await flush(next.egg);
      expect(next.egg.pendingMutation).toBeNull();
      expect(next.egg.progress).toMatchObject(committed);
      expect(next.egg.querySelector('[data-forge-result="success"]')).not.toBeNull();
      expect(
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).some(
          (key) => key?.startsWith("platformclaw.baseball.pending.v1:"),
        ),
      ).toBe(false);
    },
  );

  it("keeps an unknown request across same-account reconnect but isolates a replacement account", async () => {
    const { egg } = await openWorkshop(enhanced(), () => {
      throw new Error("unknown");
    });
    await click(egg, "[data-forge-enhance]");
    const pending = egg.pendingMutation;
    egg.client = null;
    await flush(egg);
    expect(egg.pendingMutation).toBe(pending);
    const other = await openWorkshop(
      enhanced(),
      () => {
        throw new Error("must not replay");
      },
      "synthetic-other-account",
    );
    expect(other.egg.pendingMutation).toBeNull();
    expect(other.request.mock.calls.some(([method]) => method === BASEBALL_RPC.enhanceBat)).toBe(
      false,
    );
  });

  it("does not send a paid request when durable recovery storage is unavailable", async () => {
    const { egg, request } = await openWorkshop(enhanced(), () => {
      throw new Error("must not send");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await click(egg, "[data-forge-enhance]");
    expect(request.mock.calls.some(([method]) => method === BASEBALL_RPC.enhanceBat)).toBe(false);
    expect(egg.pendingMutation).toBeNull();
    expect(egg.textContent).toContain("전송하지 않았습니다");
  });

  it.each(["confirm", "reject"] as const)(
    "advances the full pending queue immediately after %s",
    async (settlement) => {
      const { egg, request } = await openWorkshop(enhanced(), (_method, params) => {
        if (params.requestId === "queue-a" && settlement === "reject") {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Synthetic stale request",
          });
        }
        return receipt(params, enhanced(1, { gold: 900, revision: 2 }));
      });
      for (const [requestId, expectedRevision] of [
        ["queue-a", 0],
        ["queue-b", 1],
      ] as const) {
        queueEnhancement(egg, requestId, expectedRevision);
      }
      notifyJournal();
      await flush(egg);
      expect(egg.pendingMutation).toMatchObject({ params: { requestId: "queue-a" } });
      await click(egg, ".platformclaw-easter-egg__save-status button");
      expect(egg.pendingMutation).toMatchObject({ params: { requestId: "queue-b" } });
      expect(button(egg, ".platformclaw-easter-egg__save-status button").disabled).toBe(false);
      await click(egg, ".platformclaw-easter-egg__save-status button");
      expect(egg.pendingMutation).toBeNull();
      expect(loadPendingWorkshop(egg.preferenceScope)).toEqual([]);
      expect(
        request.mock.calls
          .filter(([method]) => method === BASEBALL_RPC.enhanceBat)
          .map(([, params]) => (params as { requestId: string }).requestId),
      ).toEqual(["queue-a", "queue-b"]);
    },
  );

  it("shares settled receipts and taunt claims between two same-account instances", async () => {
    const mutate = (_method: string, params: Record<string, unknown>) =>
      receipt(params, enhanced(0, { gold: 900, revision: 1 }), { outcome: "maintain", level: 0 });
    const first = await openWorkshop(enhanced(), mutate);
    const second = await openWorkshop(enhanced(), mutate);
    // The global logo event closes other elements in one document; real tabs have separate windows.
    await first.egg.startGame();
    await click(first.egg, ".platformclaw-easter-egg__shop-trigger");
    const intent = {
      method: BASEBALL_RPC.enhanceBat,
      params: { requestId: "shared-receipt", expectedRevision: 0 },
    };
    expect(savePendingWorkshop(first.egg.preferenceScope, intent)).toBe(true);
    notifyJournal();
    await flush(first.egg);
    await flush(second.egg);
    button(first.egg, ".platformclaw-easter-egg__save-status button").click();
    button(second.egg, ".platformclaw-easter-egg__save-status button").click();
    await flush(first.egg);
    await flush(second.egg);
    expect(
      first.egg.querySelectorAll("[data-forge-taunt]").length +
        second.egg.querySelectorAll("[data-forge-taunt]").length,
    ).toBe(1);
    expect(savePendingWorkshop(first.egg.preferenceScope, intent)).toBe(false);
    expect(loadPendingWorkshop(first.egg.preferenceScope)).toEqual([]);
    expect(first.egg.pendingMutation).toBeNull();
    expect(second.egg.pendingMutation).toBeNull();
  });

  it("shows a retry's taunt outside the closed workshop without stealing input focus", async () => {
    let attempts = 0;
    const { egg } = await openWorkshop(enhanced(), (_method, params) => {
      if (++attempts === 1) {
        throw new Error("lost response");
      }
      return receipt(params, enhanced(0, { gold: 900, revision: 1 }), {
        outcome: "maintain",
        level: 0,
      });
    });
    await click(egg, "[data-forge-enhance]");
    await click(egg, ".platformclaw-easter-egg__shop header button");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await click(egg, ".platformclaw-easter-egg__save-status button");
    expect(egg.querySelector('[role="dialog"]')).toBeNull();
    expect(egg.querySelector("[data-forge-taunt]")).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("releases a request settled by another tab and ignores its late response after a newer result", async () => {
    const held = deferred<unknown>();
    const committed = enhanced(0, { gold: 900, revision: 1 });
    const newest = enhanced(1, { gold: 800, revision: 2 });
    let attempts = 0;
    const first = await openWorkshop(enhanced(), (_method, params) =>
      ++attempts === 1 ? held.promise : receipt(params, newest),
    );
    const second = await openWorkshop(enhanced(), (_method, params) =>
      receipt(params, committed, { outcome: "maintain", level: 0 }),
    );
    await first.egg.startGame();
    await click(first.egg, ".platformclaw-easter-egg__shop-trigger");
    await click(first.egg, "[data-forge-enhance]");
    const original = first.egg.pendingMutation as { params: Record<string, unknown> };
    notifyJournal();
    await flush(second.egg);
    first.setServerProgress(committed);
    second.setServerProgress(committed);
    await click(second.egg, ".platformclaw-easter-egg__save-status button");
    notifyJournal("receipts");
    await flush(first.egg);
    expect(first.egg.pendingMutation).toBeNull();
    expect(button(first.egg, "[data-forge-enhance]").disabled).toBe(false);
    await click(first.egg, "[data-forge-enhance]");
    expect(first.egg.progress).toMatchObject(newest);
    expect(first.egg.querySelector('[data-forge-result="success"]')).not.toBeNull();
    held.resolve(receipt(original.params, committed, { outcome: "maintain", level: 0 }));
    await flush(first.egg);
    expect(first.egg.progress).toMatchObject(newest);
    expect(first.egg.querySelector('[data-forge-result="success"]')).not.toBeNull();
    expect(first.egg.querySelector('[data-forge-result="maintain"]')).toBeNull();
  });

  it.each([
    [10, 0, 18],
    [0, 10, 18],
    [10, 10, 28],
  ])(
    "shows confirmed total %s and streak %s bonuses with the full %sG reward",
    async (totalBonus, streakBonus, gold) => {
      const awarded = enhanced(0, {
        gold: 1000 + gold,
        revision: 1,
        totalHomers: 15,
        currentHomeRunStreak: 15,
      });
      const { egg } = await openWorkshop(enhanced(), () =>
        Promise.resolve({
          awardedGold: gold,
          homeRunBonusGold: totalBonus,
          homeRunStreakBonusGold: streakBonus,
          progress: awarded,
        }),
      );
      await click(egg, ".platformclaw-easter-egg__shop header button");
      egg.resolveAtBat("home_run", 145);
      await flush(egg);
      const effect = egg.querySelector(".platformclaw-easter-egg__bonus");
      expect(effect?.textContent?.includes(t("platformClaw.baseball.bonus", { gold: "10" }))).toBe(
        totalBonus > 0,
      );
      expect(
        effect?.textContent?.includes(t("platformClaw.baseball.streakBonus", { gold: "10" })),
      ).toBe(streakBonus > 0);
      expect(egg.awardedGold).toBe(gold);
      expect(egg.textContent).toContain(t("platformClaw.baseball.reward", { gold: String(gold) }));
    },
  );

  it("keeps an active plate receipt through another tab's workshop entry and preserves the next-round timer", async () => {
    const plate = deferred<unknown>();
    const awarded = enhanced(0, { gold: 1_010, revision: 1, totalHomers: 5 });
    const upgraded = enhanced(1, { gold: 910, revision: 2, totalHomers: 5 });
    const { egg, request, setServerProgress } = await openWorkshop(
      enhanced(0, { totalHomers: 4 }),
      (method, params) =>
        method === BASEBALL_RPC.plateAppearance ? plate.promise : receipt(params, upgraded),
    );
    await click(egg, ".platformclaw-easter-egg__shop header button");
    egg.resolveAtBat("home_run", 145);
    await flush(egg);
    const original = egg.pendingMutation;
    expect(original).toMatchObject({ method: BASEBALL_RPC.plateAppearance });
    queueEnhancement(egg, "queued-after-plate", 1);
    notifyJournal();
    await flush(egg);
    expect(egg.pendingMutation).toBe(original);
    plate.resolve({ awardedGold: 10, homeRunBonusGold: 5, progress: awarded });
    await flush(egg);
    expect(egg.awardedGold).toBe(10);
    expect(egg.pendingMutation).toMatchObject({
      method: BASEBALL_RPC.enhanceBat,
      params: { requestId: "queued-after-plate" },
    });
    setServerProgress(upgraded);
    await click(egg, ".platformclaw-easter-egg__save-status button");
    expect(egg.pendingMutation).toBeNull();
    const atBats = () =>
      request.mock.calls.filter(([method]) => method === BASEBALL_RPC.beginAtBat).length;
    expect(atBats()).toBe(1);
    await vi.advanceTimersByTimeAsync(649);
    expect(atBats()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush(egg);
    expect(atBats()).toBe(2);
  });

  it.each([false, true])(
    "advances deferred workshop work after a rejected at-bat: queued=%s",
    async (queued) => {
      const rejectPlate = deferred<void>();
      const upgraded = enhanced(1, { gold: 900, revision: 1 });
      const { egg, request, setServerProgress } = await openWorkshop(
        enhanced(),
        (method, params) =>
          method === BASEBALL_RPC.plateAppearance
            ? rejectPlate.promise.then(() => {
                throw new GatewayRequestError({
                  code: "INVALID_REQUEST",
                  message: "Synthetic expired nonce",
                });
              })
            : receipt(params, upgraded),
      );
      await click(egg, ".platformclaw-easter-egg__shop header button");
      egg.resolveAtBat("miss");
      await flush(egg);
      if (queued) {
        queueEnhancement(egg, "queued-after-rejection", 0);
        notifyJournal();
        await flush(egg);
      }
      rejectPlate.resolve(undefined);
      await flush(egg);
      expect(requestCount(request, BASEBALL_RPC.beginAtBat)).toBe(1);
      if (queued) {
        expect(egg.pendingMutation).toMatchObject({
          method: BASEBALL_RPC.enhanceBat,
          params: { requestId: "queued-after-rejection" },
        });
        setServerProgress(upgraded);
      } else {
        expect(egg.pendingMutation).toBeNull();
        expect(egg.querySelector(".platformclaw-easter-egg__save-status")?.textContent).toContain(
          "Synthetic expired nonce",
        );
      }
      await click(egg, ".platformclaw-easter-egg__save-status button");
      expect(egg.pendingMutation).toBeNull();
      expect(requestCount(request, BASEBALL_RPC.beginAtBat)).toBe(2);
    },
  );

  it("keeps the reconnect retry's release handle after the old invocation finishes", async () => {
    const oldResponse = deferred<unknown>();
    const newResponse = deferred<unknown>();
    const committed = enhanced(1, { gold: 900, revision: 1 });
    const { egg, request, setServerProgress } = await openWorkshop(
      enhanced(),
      () => oldResponse.promise,
    );
    await click(egg, "[data-forge-enhance]");
    const original = egg.pendingMutation as BaseballMutation;
    const oldClient = egg.client!;
    const retry = vi.fn(
      async <T>(method: string, params?: unknown): Promise<T> =>
        method === BASEBALL_RPC.enhanceBat
          ? (newResponse.promise as Promise<T>)
          : oldClient.request<T>(method, params),
    );
    egg.client = {
      request: async <T>(method: string, params?: unknown) => (await retry(method, params)) as T,
    };
    await flush(egg);
    expect(egg.pendingMutation).toBe(original);
    await click(egg, ".platformclaw-easter-egg__save-status button");
    expect(retry.mock.calls.find(([method]) => method === BASEBALL_RPC.enhanceBat)?.[1]).toEqual(
      request.mock.calls.find(([method]) => method === BASEBALL_RPC.enhanceBat)?.[1],
    );
    oldResponse.resolve(receipt(original.params, committed));
    await flush(egg);
    setServerProgress(committed);
    await clearPendingWorkshop(egg.preferenceScope, original);
    notifyJournal("receipts");
    await flush(egg);
    expect(egg.pendingMutation).toBeNull();
    expect(egg.progress).toMatchObject(committed);
    expect(button(egg, "[data-forge-enhance]").disabled).toBe(false);
    newResponse.resolve(receipt(original.params, committed));
    await flush(egg);
    expect(button(egg, "[data-forge-enhance]").disabled).toBe(false);
  });

  it("confirms a retry before a slow wallet read and never rolls back a newer result", async () => {
    const initial = enhanced(0, { gold: 1000, revision: 4 });
    const committed = enhanced(1, { gold: 900, revision: 5 });
    const newest = enhanced(2, { gold: 750, revision: 7 });
    let attempts = 0;
    const { egg } = await openWorkshop(initial, (_method, params) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("response lost");
      }
      return receipt(params, attempts === 2 ? committed : newest);
    });
    await click(egg, "[data-forge-enhance]");
    const wallet = deferred<BaseballProgress>();
    const request = egg.client!.request.bind(egg.client);
    egg.client!.request = async <T>(method: string, params?: unknown) =>
      method === BASEBALL_RPC.progress
        ? (wallet.promise as Promise<T>)
        : request<T>(method, params);
    await click(egg, ".platformclaw-easter-egg__save-status button");
    expect(egg.pendingMutation).toBeNull();
    expect(egg.progress).toMatchObject(committed);
    expect(egg.querySelector('[data-forge-result="success"]')).not.toBeNull();
    expect(button(egg, "[data-forge-enhance]").disabled).toBe(false);
    await click(egg, "[data-forge-enhance]");
    expect(egg.progress).toMatchObject(newest);
    wallet.resolve(enhanced(1, { gold: 850, revision: 6 }));
    await flush(egg);
    expect(egg.progress).toMatchObject(newest);
  });

  it.each([false, true])(
    "blocks a broken enhancement regardless of equipped=%s until recovery",
    async (equipped) => {
      const initial = enhanced(0, {
        gold: 500,
        ownedBatIds: ["wood", "diamond"],
        equippedBatId: "diamond",
        enhancement: { level: 0, status: "broken", equipped, version: 1 },
      });
      const next = {
        ...initial,
        revision: 1,
        enhancement: { level: 0, status: "ready" as const, equipped: true, version: 1 as const },
      };
      const { egg, request, setServerProgress } = await openWorkshop(initial, (method, params) => {
        expect(method).toBe(BASEBALL_RPC.recoverBat);
        expect(params.action).toBe("restart");
        return {
          requestId: params.requestId,
          outcome: "restarted",
          chargedGold: 0,
          progress: next,
        };
      });
      expect(egg.querySelector("[data-shop-bat]")).toBeNull();
      expect(egg.querySelector("[data-forge-equip]")).toBeNull();
      expect(requestCount(request, BASEBALL_RPC.beginAtBat)).toBe(0);
      await click(egg, ".platformclaw-easter-egg__shop header button");
      expect(requestCount(request, BASEBALL_RPC.beginAtBat)).toBe(0);
      await click(egg, ".platformclaw-easter-egg__shop-trigger");
      setServerProgress(next);
      await click(egg, '[data-forge-recover="restart"]');
      await click(egg, ".platformclaw-easter-egg__shop header button");
      expect(requestCount(request, BASEBALL_RPC.beginAtBat)).toBe(1);
      expect(egg.querySelector<HTMLElement>('[role="application"]')?.dataset).toMatchObject({
        batId: "wood",
        roundEnhancement: "0",
      });
      expect(egg.progress).toMatchObject({
        ...initial,
        revision: 1,
        enhancement: next.enhancement,
      });
      expect(requestCount(request, BASEBALL_RPC.equipBat)).toBe(0);
      expect(requestCount(request, BASEBALL_RPC.purchaseBat)).toBe(0);
    },
  );

  it("clears a definitively rejected pending attempt and refreshes gold without inventing a new retry", async () => {
    const { egg, request, setServerProgress } = await openWorkshop(
      enhanced(0, { revision: 8 }),
      () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Game balance changed; refresh progress",
        });
      },
    );
    setServerProgress(enhanced(0, { gold: 50, revision: 9, teamId: "lg" }));
    await click(egg, "[data-forge-enhance]");
    expect(egg.pendingMutation).toBeNull();
    expect(egg.progress).toMatchObject({ gold: 50, revision: 9, enhancement: { level: 0 } });
    expect(egg.querySelector<HTMLElement>('[role="application"]')?.dataset.teamId).toBe("lg");
    expect(button(egg, "[data-forge-enhance]").disabled).toBe(true);
    expect(egg.querySelector(".platformclaw-easter-egg__save-status")?.textContent).toContain(
      "Game balance changed",
    );
    expect(preview(egg).dataset.effect).toBe("");
    expect(egg.querySelector("[data-forge-result]")).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestCount(request, BASEBALL_RPC.enhanceBat)).toBe(1);
    expect(requestCount(request, BASEBALL_RPC.progress)).toBe(2);
  });
});
