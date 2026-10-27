import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FISHING_RPC,
  type FishingAttempt,
  type FishingCatch,
  type FishingSnapshot,
} from "../../../packages/platformclaw-control-plane/src/fishing-contracts.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { CHAT_SPACE_ACTIVATION_SELECTOR } from "../pages/chat/chat-pane-shared.ts";
import { resolveFishingPresentation } from "./fishing-presentation.ts";
import { fishingFishScale, FishingLine } from "./fishing-scene.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import "./fishing-game.ts";

type FishingElement = HTMLElement & {
  client: Pick<GatewayBrowserClient, "request"> | null;
  preferenceScope: string | null;
  updateComplete: Promise<boolean>;
};
type Call = { method: string; params: unknown };
const NOW = 100_000;
const opacityKey = (scope: string) => "platformclaw.fishing.opacity:" + scope;
const storage = new Map<string, string>();
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

const snapshot = (extra: Partial<FishingSnapshot> = {}): FishingSnapshot => ({
  serverNow: NOW,
  economyVersion: 1,
  gold: 25,
  walletRevision: 0,
  revision: 0,
  totalCaught: 0,
  totalEarnedGold: 0,
  bestCatch: null,
  goals: { dailyCaught: 0, weeklyCaught: 0 },
  attempt: null,
  ...extra,
});
const attempt = (extra: Partial<FishingAttempt> = {}): FishingAttempt => ({
  id: "attempt-1",
  issuedAt: NOW - 10_000,
  biteAt: NOW,
  hookDeadlineAt: NOW + 650,
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
  ...extra,
});
const catchResult = (): FishingCatch => ({
  id: "caught-1",
  fishId: "crucian",
  lengthCm: 15,
  weightKg: 0.1,
  rewardGold: 12,
  quality: "GOOD",
  accuracy: 0,
  bonusMultiplier: 1,
  caughtAt: NOW - 1_000,
});
const fighting = (): FishingAttempt =>
  attempt({
    phase: "fighting",
    quality: "PERFECT",

    behavior: "steady",
    difficulty: 1,
    hookedAt: NOW,
    fight: { elapsedMs: 0, tension: 0.32, progress: 0, status: "fighting", escapeReason: null },
  });
const finishing = (): FishingAttempt => ({
  ...fighting(),
  seed: 0,
  phase: "finishing",
  finishStartedAt: NOW - 600,
  finishDeadlineAt: NOW + 3_400,
  fight: { elapsedMs: 5_000, tension: 0.5, progress: 1, status: "caught", escapeReason: null },
});

async function flush(element: FishingElement) {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
    await element.updateComplete;
  }
}
async function mount(
  request: (method: string, params?: unknown) => Promise<unknown>,
  scope = "account-a",
) {
  const element = document.createElement("platformclaw-fishing") as FishingElement;
  element.client = {
    request: async <T>(method: string, params?: unknown) => (await request(method, params)) as T,
  };
  element.preferenceScope = scope;
  document.body.append(element);
  await flush(element);
  return element;
}
function button(element: Element, name: string): HTMLButtonElement {
  const found = Array.from(element.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!found) throw new Error("Missing button: " + name);
  return found;
}
function key(
  target: EventTarget,
  type: "keydown" | "keyup",
  code = "Space",
  extra: KeyboardEventInit = {},
) {
  const control = code === "ControlLeft" || code === "ControlRight";
  return target.dispatchEvent(
    new KeyboardEvent(type, {
      code,
      key: control ? "Control" : code === "Space" ? " " : code === "KeyC" ? "c" : code,
      ctrlKey: control && type === "keydown",
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}
function pointerDown(target: Element) {
  target.dispatchEvent(
    new MouseEvent("pointerdown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    }),
  );
}
function pointerUp() {
  window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
}
function server(initial = snapshot()) {
  let saved = initial;
  const calls: Call[] = [];
  const request = async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === FISHING_RPC.begin) {
      saved = snapshot({ revision: saved.revision + 1, attempt: attempt() });
    } else if (method === FISHING_RPC.hook) {
      saved = snapshot({ revision: saved.revision + 1, attempt: fighting() });
    } else if (method === FISHING_RPC.reel && saved.attempt) {
      const held = (params as { held: boolean }).held;
      saved = {
        ...saved,
        revision: saved.revision + 1,
        attempt: {
          ...saved.attempt,
          inputs: [...saved.attempt.inputs, { atMs: saved.attempt.inputs.length * 100, held }],
        },
      };
    } else if (method === FISHING_RPC.finish && saved.attempt) {
      const result = {
        ...catchResult(),
        id: saved.attempt.id,
        quality: saved.attempt.quality ?? "GOOD",
        rewardGold: 24,
        accuracy: 1,
        bonusMultiplier: 2,
        caughtAt: NOW,
      };
      saved = {
        ...saved,
        revision: saved.revision + 1,
        walletRevision: saved.walletRevision + 1,
        gold: saved.gold + result.rewardGold,
        totalCaught: saved.totalCaught + 1,
        totalEarnedGold: saved.totalEarnedGold + result.rewardGold,
        bestCatch: { fishId: result.fishId, lengthCm: result.lengthCm, weightKg: result.weightKg },
        attempt: { ...saved.attempt, phase: "caught", result },
      };
    }
    if (method === FISHING_RPC.leaderboard) return { catches: [], earnedGold: [] };
    return saved;
  };
  return { calls, request };
}
function mutationCalls(calls: Call[]) {
  return calls.filter(
    ({ method }) => method !== FISHING_RPC.snapshot && method !== FISHING_RPC.leaderboard,
  );
}

beforeEach(async () => {
  await loadAllPlatformClawLocales();
  storage.clear();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => {
      storage.set(name, value);
    },
    removeItem: (name: string) => {
      storage.delete(name);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      frames.delete(id);
    }),
  );
  vi.spyOn(performance, "now").mockReturnValue(5_000);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fishing inputs and operation ownership", () => {
  it("leaves a rejected release visible and does not automatically retry with a new nonce", async () => {
    const saved = snapshot({ attempt: { ...fighting(), inputs: [{ atMs: 0, held: true }] } });
    let rejectedReleases = 0;
    const element = await mount(async (method) => {
      if (method === FISHING_RPC.reel) {
        rejectedReleases++;
        if (rejectedReleases === 1)
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Input budget reached. Wait for the result.",
            details: {
              errorKind: "proxy-rejection",
              requestDisposition: "rejected-before-dispatch",
            },
          });
        // Bound the old automatic loop so this regression fails without hanging.
        return new Promise<FishingSnapshot>(() => undefined);
      }
      return saved;
    });
    pointerUp();
    await flush(element);
    expect(rejectedReleases).toBe(1);
    expect(element.textContent).toContain("Input budget reached");
    button(element, "Refresh").click();
    await flush(element);
    expect(rejectedReleases).toBe(1);
    expect(element.textContent).not.toContain("Input budget reached");
  });

  it("ignores duplicate actions while the cast animation owns the input", async () => {
    const calls: string[] = [];
    let saved = snapshot();
    const element = await mount(async (method) => {
      calls.push(method);
      if (method === FISHING_RPC.begin) {
        saved = snapshot({
          revision: 1,
          attempt: attempt({ issuedAt: NOW, biteAt: NOW + 15_000 }),
        });
      }
      return saved;
    });
    const control = element.querySelector("section")!;
    key(control, "keydown");
    key(control, "keyup");
    await flush(element);
    expect(element.querySelector<HTMLButtonElement>("[data-fishing-action]")!.disabled).toBe(true);
    key(control, "keydown");
    key(control, "keyup");
    pointerDown(element.querySelector("canvas")!);
    pointerUp();
    await flush(element);
    expect(calls.filter((method) => method === FISHING_RPC.begin)).toHaveLength(1);
    expect(calls).not.toContain(FISHING_RPC.hook);
  });

  it.each(["[data-fishing-action]", "[data-fishing-surface]"])(
    "retains keyboard focus after pointer casting on %s and accepts scene hold/release",
    async (selector) => {
      const service = server();
      const element = await mount(service.request);
      const outside = document.createElement("button");
      document.body.append(outside);
      outside.focus();
      pointerDown(element.querySelector(selector)!);
      pointerUp();
      await flush(element);
      const surface = element.querySelector("[data-fishing-surface]")!;
      expect(document.activeElement).toBe(surface);
      expect(surface.matches(CHAT_SPACE_ACTIVATION_SELECTOR)).toBe(true);
      key(document.activeElement!, "keydown");
      key(document.activeElement!, "keyup");
      await flush(element);
      expect(service.calls.filter((call) => call.method === FISHING_RPC.hook)).toHaveLength(1);
      pointerDown(element.querySelector("canvas")!);
      await flush(element);
      pointerUp();
      await flush(element);
      expect(
        service.calls
          .filter((call) => call.method === FISHING_RPC.reel)
          .map((call) => (call.params as { held: boolean }).held),
      ).toEqual([true, false]);
      const ranking = button(element, "Rankings");
      ranking.focus();
      ranking.click();
      await flush(element);
      const before = mutationCalls(service.calls).length;
      expect(key(ranking, "keydown")).toBe(true);
      expect(key(ranking, "keyup")).toBe(true);
      expect(document.activeElement).toBe(ranking);
      expect(mutationCalls(service.calls)).toHaveLength(before);
    },
  );

  it.each(["caught", "escaped"] as const)(
    "casts again after %s without the former 23-second cooldown",
    async (phase) => {
      const result = phase === "caught" ? catchResult() : null;
      const service = server(
        snapshot({
          attempt: attempt({
            phase,
            issuedAt: NOW - 20_000,
            result,

            behavior: "steady",
            quality: "GOOD",
            hookedAt: NOW - 6_000,
            fight: {
              elapsedMs: 5_000,
              tension: 0.5,
              progress: phase === "caught" ? 1 : 0.5,
              status: phase,
              escapeReason: null,
            },
          }),
        }),
      );
      const element = await mount(service.request);
      expect(element.querySelector<HTMLButtonElement>("[data-fishing-action]")!.disabled).toBe(
        false,
      );
      pointerDown(element.querySelector("[data-fishing-surface]")!);
      pointerUp();
      await flush(element);
      expect(service.calls.filter((call) => call.method === FISHING_RPC.begin)).toHaveLength(1);
    },
  );

  it("casts on Control keydown without waiting for keyup and ignores repeats", async () => {
    const service = server();
    const element = await mount(service.request);
    key(document.body, "keydown", "ControlLeft");
    expect(mutationCalls(service.calls).map(({ method }) => method)).toEqual([FISHING_RPC.begin]);
    await flush(element);
    key(document.body, "keydown", "ControlLeft", { repeat: true });
    key(document.body, "keydown", "ControlRight");
    key(document.body, "keyup", "ControlLeft");
    key(document.body, "keyup", "ControlRight");
    await flush(element);
    expect(mutationCalls(service.calls).map(({ method }) => method)).toEqual([FISHING_RPC.begin]);
  });

  it("hooks on Control keydown, keeps reeling while held and releases only when both Controls are up", async () => {
    const service = server(snapshot({ attempt: attempt() }));
    const element = await mount(service.request);
    key(document.body, "keydown", "ControlLeft");
    expect(mutationCalls(service.calls).map(({ method }) => method)).toEqual([FISHING_RPC.hook]);
    await flush(element);
    const edges = () =>
      service.calls
        .filter(({ method }) => method === FISHING_RPC.reel)
        .map(({ params }) => (params as { held: boolean }).held);
    expect(edges()).toEqual([true]);
    key(document.body, "keydown", "ControlRight");
    key(document.body, "keyup", "ControlLeft");
    await flush(element);
    expect(edges()).toEqual([true]);
    key(document.body, "keyup", "ControlRight");
    await flush(element);
    expect(edges()).toEqual([true, false]);
  });

  it.each(["Space", "Control", "pointer"] as const)(
    "submits one server-timed finish with %s and displays the returned accuracy bonus",
    async (input) => {
      const service = server(snapshot({ attempt: finishing() }));
      const element = await mount(service.request);
      expect(element.querySelector("[data-fishing-finish]")).not.toBeNull();
      expect(element.querySelector("[data-fishing-finish-cursor]")).not.toBeNull();
      if (input === "pointer") {
        pointerDown(element.querySelector("canvas")!);
        pointerUp();
      } else if (input === "Control") {
        key(document.body, "keydown", "ControlLeft");
        expect(mutationCalls(service.calls).map(({ method }) => method)).toEqual([
          FISHING_RPC.finish,
        ]);
        key(document.body, "keyup", "ControlLeft");
      } else {
        const control = element.querySelector("section")!;
        key(control, "keydown");
        key(control, "keydown", "Space", { repeat: true });
        key(control, "keyup");
      }
      await flush(element);
      const finishes = service.calls.filter(({ method }) => method === FISHING_RPC.finish);
      expect(finishes).toHaveLength(1);
      expect(finishes[0]?.params).toEqual({
        attemptId: "attempt-1",
        requestId: expect.any(String),
      });
      const result = element.querySelector("[data-fishing-catch]")?.textContent;
      expect(result).toContain("+24 G");
      expect(result).toMatch(/100\s*%/);
      expect(result).toMatch(/×\s*2(?:\.0+)?/);
      expect(element.querySelector("[data-fishing-finish]")).toBeNull();
    },
  );

  it.each(["blur", "scope"] as const)(
    "clears held Control on %s without triggering another action on release",
    async (reset) => {
      const service = server();
      const element = await mount(service.request);
      key(document.body, "keydown", "ControlLeft");
      if (reset === "blur") window.dispatchEvent(new Event("blur"));
      else element.preferenceScope = "account-b";
      await flush(element);
      key(document.body, "keyup", "ControlLeft");
      await flush(element);
      expect(mutationCalls(service.calls).map(({ method }) => method)).toEqual([FISHING_RPC.begin]);
    },
  );

  it("ignores Control and Space in chat inputs and releases reeling on window blur", async () => {
    const service = server(snapshot({ attempt: fighting() }));
    const element = await mount(service.request);
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    key(input, "keydown");
    key(input, "keyup");
    key(input, "keydown", "ControlLeft");
    key(input, "keydown", "KeyC", { ctrlKey: true });
    key(input, "keyup", "KeyC", { ctrlKey: true });
    key(input, "keyup", "ControlLeft");
    await flush(element);
    expect(mutationCalls(service.calls)).toEqual([]);
    pointerDown(element.querySelector("canvas")!);
    await flush(element);
    window.dispatchEvent(new Event("blur"));
    await flush(element);
    expect(
      service.calls
        .filter((call) => call.method === FISHING_RPC.reel)
        .map((call) => (call.params as { held: boolean }).held),
    ).toEqual([true, false]);
    element.remove();
    const before = service.calls.length;
    key(document.body, "keydown", "ControlLeft");
    key(document.body, "keyup", "ControlLeft");
    expect(service.calls).toHaveLength(before);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it.each([
    ["transport", null, null],
    ["FORBIDDEN authorization", "FORBIDDEN", "authorization"],
    ["UNAUTHENTICATED authorization", "UNAUTHENTICATED", "authorization"],
    ["FORBIDDEN proxy rejection", "FORBIDDEN", "proxy-rejection"],
    ["UNAUTHENTICATED proxy rejection", "UNAUTHENTICATED", "proxy-rejection"],
  ] as const)(
    "retries an unknown %s outcome with the same nonce and ignores repeated Space",
    async (_kind, code, errorKind) => {
      let first = true;
      const casts: unknown[] = [];
      const element = await mount(async (method, params) => {
        if (method === FISHING_RPC.begin) {
          casts.push(params);
          if (first) {
            first = false;
            if (code === null) throw new Error("lost response");
            throw new GatewayRequestError({
              code,
              message: "Authority changed after dispatch",
              details: { errorKind, requestDisposition: "outcome-unknown" },
            });
          }
        }
        return snapshot();
      });
      const control = element.querySelector("section")!;
      key(control, "keydown");
      key(control, "keydown", "Space", { repeat: true });
      key(control, "keyup");
      await flush(element);
      expect(casts).toHaveLength(1);
      expect(element.textContent).toContain("outcome could not be confirmed");
      button(element, "Retry request").click();
      await flush(element);
      expect(casts).toHaveLength(2);
      expect(casts[1]).toEqual(casts[0]);
    },
  );

  it("does not let a delayed read erase a newer unknown cast outcome", async () => {
    let release!: (value: FishingSnapshot) => void;
    let reads = 0;
    const element = await mount(async (method) => {
      if (method === FISHING_RPC.leaderboard) return { catches: [], earnedGold: [] };
      if (method === FISHING_RPC.begin) throw new Error("lost receipt");
      if (++reads > 1)
        return new Promise<FishingSnapshot>((resolve) => {
          release = resolve;
        });
      return snapshot();
    });
    button(element, "Rankings").click();
    await flush(element);
    button(element, "Refresh").click();
    await flush(element);
    key(element.querySelector("section")!, "keydown");
    key(element.querySelector("section")!, "keyup");
    await flush(element);
    release(snapshot());
    await flush(element);
    expect(element.textContent).toContain("outcome could not be confirmed");
    expect(button(element, "Retry request")).toBeDefined();
  });

  it("rejects late snapshots from an account that has been replaced", async () => {
    let release!: (value: FishingSnapshot) => void;
    const old = new Promise<FishingSnapshot>((resolve) => {
      release = resolve;
    });
    const element = await mount(async () => old);
    element.preferenceScope = "account-b";
    element.client = { request: async <T>() => snapshot({ gold: 17 }) as T };
    await flush(element);
    release(snapshot({ gold: 999999 }));
    await flush(element);
    expect(element.textContent).toContain("17 G");
    expect(element.textContent).not.toContain("999,999");
  });
});

describe("minimal fishing presentation and preferences", () => {
  it("ends the bite signal at the hook deadline and refreshes late input without a futile hook", async () => {
    const expired = attempt({ biteAt: NOW - 651, hookDeadlineAt: NOW - 1 });
    const saved = snapshot({ attempt: expired });
    expect(resolveFishingPresentation(saved, NOW - 1, false, false).scene.phase).toBe("bite");
    expect(resolveFishingPresentation(saved, NOW, false, false).scene.phase).toBe("miss");
    const calls: string[] = [];
    const element = await mount(async (method) => {
      calls.push(method);
      return saved;
    });
    expect(element.querySelector("[data-fishing-bite]")).toBeNull();
    expect(element.querySelector<HTMLButtonElement>("[data-fishing-action]")!.disabled).toBe(true);
    key(element.querySelector("[data-fishing-surface]")!, "keydown");
    key(element.querySelector("[data-fishing-surface]")!, "keyup");
    await flush(element);
    expect(calls.filter((method) => method === FISHING_RPC.snapshot)).toHaveLength(2);
    expect(calls).not.toContain(FISHING_RPC.hook);
  });

  it("shows a head-side exclamation only for a real bite, never a nibble", async () => {
    let saved = snapshot({
      attempt: attempt({ biteAt: NOW + 1000, nibbles: [{ at: NOW, durationMs: 300 }] }),
    });
    const element = await mount(async () => saved);
    expect(element.querySelector("[data-fishing-bite]")).toBeNull();
    expect(element.textContent).toContain("Not yet");
    saved = snapshot({ revision: 1, attempt: attempt() });
    element.client = { request: async <T>() => saved as T };
    await flush(element);
    expect(element.querySelector("[data-fishing-bite]")?.textContent).toBe("!");
    expect(element.querySelector("[data-fishing-bite]")?.getAttribute("aria-label")).toContain(
      "Hook",
    );
  });

  it.each([
    [2000, true, "high", "release!"],
    [700, false, "low", "reel!"],
  ] as const)(
    "shows tension risk for an actual replay at %sms",
    async (elapsed, held, risk, hint) => {
      const element = await mount(
        server(
          snapshot({
            attempt: {
              ...fighting(),
              hookedAt: NOW - elapsed,
              inputs: held ? [{ atMs: 0, held: true }] : [],
            },
          }),
        ).request,
      );
      expect(element.querySelector("[data-danger]")?.getAttribute("data-danger")).toBe(risk);
      expect(element.querySelector("[data-danger]")?.textContent).toContain(hint);
      const value = element.querySelector("meter")!.value;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(
        element.querySelector(".platformclaw-fishing__tension-track i")?.getAttribute("style"),
      ).toContain(`${value * 100}%`);
    },
  );

  it.each([
    ["line_broken", "Line broke"],
    ["slack", "slack line"],
    ["timeout", "long fight"],
  ] as const)(
    "reports the authoritative %s cause and keeps its visual timing",
    async (reason, message) => {
      const saved = snapshot({
        attempt: {
          ...fighting(),
          phase: "escaped",
          hookedAt: NOW - 2100,
          fight: {
            elapsedMs: 2000,
            tension: reason === "line_broken" ? 1 : 0,
            progress: 0.3,
            status: "escaped",
            escapeReason: reason,
          },
        },
      });
      const element = await mount(server(saved).request);
      expect(element.textContent).toContain(message);
      const { scene } = resolveFishingPresentation(saved, NOW, false, false);
      expect(scene).toMatchObject({
        phase: "miss",
        phaseTime: 100,
        escapeReason: reason,
      });
    },
  );

  it("keeps every live fish anonymous and shows actual size only after the catch", async () => {
    expect(fishingFishScale(10)).toBeLessThan(fishingFishScale(35));
    expect(fishingFishScale(35)).toBeLessThan(fishingFishScale(200));
    for (const pending of [attempt(), fighting(), finishing()]) {
      const saved = snapshot({ attempt: pending });
      expect(resolveFishingPresentation(saved, NOW, false, false).scene.fishLengthCm).toBeNull();
      const element = await mount(server(saved).request);
      expect(element.textContent).not.toContain("붕어");
      expect(element.textContent).not.toContain("Difficulty");
      element.remove();
    }
    const result = { ...catchResult(), lengthCm: 35 };
    const saved = snapshot({ attempt: attempt({ phase: "caught", result }) });
    expect(resolveFishingPresentation(saved, NOW, false, false).scene.fishLengthCm).toBe(35);
    const element = await mount(server(saved).request);
    expect(element.querySelector("[data-fishing-catch]")?.textContent).toContain("붕어");
    expect(element.querySelector("[data-fishing-catch]")?.textContent).toContain("35 cm");
  });

  it("opens only the requested ranking or records panel and closes the active panel on a second click", async () => {
    const service = server(
      snapshot({
        totalCaught: 7,
        totalEarnedGold: 84,
        bestCatch: { fishId: "crucian", lengthCm: 30, weightKg: 1 },
        goals: { dailyCaught: 2, weeklyCaught: 7 },
      }),
    );
    const element = await mount(service.request);
    expect(element.querySelector("#fishing-panel")).toBeNull();
    expect(button(element, "Rankings").getAttribute("aria-expanded")).toBe("false");
    expect(button(element, "Records").getAttribute("aria-expanded")).toBe("false");
    button(element, "Records").click();
    await flush(element);
    expect(button(element, "Records").getAttribute("aria-expanded")).toBe("true");
    expect(element.querySelector("#fishing-panel")?.textContent).toContain("30 cm");
    expect(element.querySelector("#fishing-panel")?.textContent).toContain("84");
    button(element, "Records").click();
    await flush(element);
    expect(element.querySelector("#fishing-panel")).toBeNull();
    button(element, "Rankings").click();
    await flush(element);
    expect(button(element, "Rankings").getAttribute("aria-expanded")).toBe("true");
    expect(service.calls.filter(({ method }) => method === FISHING_RPC.leaderboard)).toHaveLength(
      1,
    );
    button(element, "Rankings").click();
    await flush(element);
    expect(element.querySelector("#fishing-panel")).toBeNull();
    expect(element.textContent).not.toMatch(
      /Sell all|Workshop|Field guide|Auto fishing|Sound on|Sound off/,
    );
  });

  it("shows the settled reward without celebrating an old personal best and casts without a location", async () => {
    const result = catchResult();
    const saved = snapshot({
      gold: 37,
      totalCaught: 1,
      totalEarnedGold: 12,
      bestCatch: { fishId: result.fishId, lengthCm: result.lengthCm, weightKg: result.weightKg },
      attempt: attempt({ phase: "caught", result }),
    });
    const service = server(saved);
    const element = await mount(service.request);
    expect(element.querySelector("[data-fishing-catch]")?.textContent).toContain("+12 G");
    expect(element.querySelector("[data-fishing-catch]")?.textContent).not.toContain(
      "Personal best",
    );
    expect(element.textContent).toContain("37 G");
    expect(element.querySelector("select")).toBeNull();
    button(element, "Rankings").click();
    await flush(element);
    button(element, "Refresh").click();
    await flush(element);
    pointerDown(element.querySelector("canvas")!);
    pointerUp();
    await flush(element);
    expect(service.calls.find(({ method }) => method === FISHING_RPC.begin)?.params).toEqual({
      requestId: expect.any(String),
    });
  });

  it("starts at 45 percent opacity and persists slider values per account", async () => {
    const service = server();
    const element = await mount(service.request);
    const slider = () => element.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider()).toMatchObject({ min: "10", max: "100", step: "5", value: "45" });
    expect(element.querySelector("section")!.style.getPropertyValue("--fish-opacity")).toBe("0.45");
    slider().value = "70";
    slider().dispatchEvent(new Event("input", { bubbles: true }));
    await flush(element);
    expect(storage.get(opacityKey("account-a"))).toBe("70");
    expect(element.querySelector("section")!.style.getPropertyValue("--fish-opacity")).toBe("0.7");
    element.preferenceScope = "account-b";
    await flush(element);
    expect(slider().value).toBe("45");
    slider().value = "10";
    slider().dispatchEvent(new Event("input", { bubbles: true }));
    await flush(element);
    element.preferenceScope = "account-a";
    await flush(element);
    expect(slider().value).toBe("70");
    expect(storage.get(opacityKey("account-b"))).toBe("10");
  });

  it("keeps docking independent of chat layout and closes on Escape", async () => {
    const element = await mount(server().request);
    expect(element.style.getPropertyValue("--fish-right")).toBe("");
    expect(element.style.getPropertyValue("--fish-bottom")).toBe("");
    const exit = vi.fn();
    element.addEventListener("fishing-exit", exit);
    key(element.querySelector("section")!, "keydown", "Escape");
    expect(exit).toHaveBeenCalledOnce();
  });
});

describe("visual rope numerical stability", () => {
  it.each([15, 30, 60, 120])("keeps both anchors and finite bounded segments at %s fps", (fps) => {
    const line = new FishingLine();
    const start = { x: 120, y: 100 };
    const end = { x: 310, y: 185 };
    line.reset(start, end);
    for (let frame = 0; frame < fps * 10; frame++) {
      line.advance(start, end, 1000 / fps, 0.6);
    }
    expect(line.points[0]).toMatchObject(start);
    expect(line.points.at(-1)).toMatchObject(end);
    expect(
      line.points.every(
        (point) =>
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          point.x > 50 &&
          point.x < 400 &&
          point.y > 50 &&
          point.y < 240,
      ),
    ).toBe(true);
  });
});
