import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HORSE_RACING_RPC,
  type HorseBetRequest,
  type HorseRacingSnapshot,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import { quoteHorsePayout } from "../../../packages/platformclaw-control-plane/src/horse-racing-pricing.ts";
import { GatewayRequestError, GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "./horse-racing-game.ts";
import { horsePerimeterPoint } from "./horse-racing-perimeter.ts";
import { loadHorseRacingOpacity, saveHorseRacingOpacity } from "./horse-racing-settings.ts";
import { now, snapshot } from "./horse-racing.test-fixtures.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";

type RacingElement = OpenClawLightDomContentsElement & {
  client: GatewayBrowserClient | null;
  preferenceScope: string | null;
};

async function flush(element: RacingElement) {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await element.updateComplete;
  }
}

function racingClient(request: (method: string, params?: unknown) => Promise<unknown>) {
  const client = new GatewayBrowserClient({ url: "ws://localhost" });
  client.request = async <T>(method: string, params?: unknown) =>
    (await request(method, params)) as T;
  return client;
}

function mount(request: (method: string, params?: unknown) => Promise<unknown>) {
  const element = document.createElement("platformclaw-horse-racing") as RacingElement;
  expect(element.constructor).toBe(customElements.get("platformclaw-horse-racing"));
  expect(element).toBeInstanceOf(OpenClawLightDomContentsElement);
  element.client = racingClient(request);
  element.preferenceScope = "account-a";
  document.body.append(element);
  return element;
}
describe("horse racing spectator and wallet UI", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
  });
  afterEach(async () => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await i18n.setLocale("en");
  });

  it("shows approximate horse bars without real probabilities, then retries a lost bet with the same request ID", async () => {
    const requests: HorseBetRequest[] = [];
    let current = snapshot();
    const element = mount(async (method, params) => {
      if (method === HORSE_RACING_RPC.snapshot) {
        return current;
      }
      requests.push(params as HorseBetRequest);
      if (requests.length === 1) {
        throw new Error("response lost");
      }
      const quote = current.race!.quotes.find(
        (entry) => entry.market === "win" && entry.selection[0] === "1",
      )!;
      const receipt = {
        ...requests[0]!,
        id: "receipt-1",
        payout: null,
        refunded: false,
        quotedOdds: quote.odds,
        potentialPayout: quoteHorsePayout(quote, requests[0]!.amount),
        cancelledAt: null,
      };
      current = {
        ...snapshot(),
        gold: 50,
        walletRevision: 1,
        race: { ...snapshot().race!, myBets: [receipt] },
      };
      return { receipt, snapshot: current };
    });
    await flush(element);
    expect(element.querySelectorAll("[data-horse-id]")).toHaveLength(6);
    expect(element.textContent).toContain("한국시간 평일 09~20시 · 30분마다 · 하루 23경주");
    expect(element.textContent).toContain("100 G");
    expect(element.textContent).not.toContain("승률");
    expect(element.querySelectorAll(".platformclaw-racing__gauge")).toHaveLength(12);
    expect(element.querySelectorAll(".platformclaw-racing__rumor")).toHaveLength(6);
    element.querySelector<HTMLButtonElement>('[data-horse-id="1"]')!.click();
    await flush(element);
    const quote = current.race!.quotes.find(
      (entry) => entry.market === "win" && entry.selection[0] === "1",
    )!;
    expect(element.querySelector("[data-potential-payout]")?.textContent?.trim()).toBe(
      `${quoteHorsePayout(quote, 50)}G`,
    );
    element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.click();
    await flush(element);
    expect(element.textContent).toContain("접수 확인에 실패");
    element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.click();
    await flush(element);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({
      raceId: "race-11",
      amount: 50,
      selection: ["1"],
      market: "win",
    });
    expect(element.textContent).toContain("50 G");
    expect(element.querySelector(".platformclaw-racing__receipts")?.textContent).toContain(
      "정산 대기",
    );
  });

  it("clears definitively rejected bets and allows another selection", async () => {
    const element = mount(async (method) => {
      if (method === HORSE_RACING_RPC.snapshot) {
        return snapshot();
      }
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "잔액 부족",
        details: { errorKind: "proxy-rejection" },
      });
    });
    await flush(element);
    element.querySelector<HTMLButtonElement>('[data-horse-id="1"]')!.click();
    await flush(element);
    element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.click();
    await flush(element);
    expect(element.textContent).toContain("베팅 거절: 잔액 부족");
    element.querySelector<HTMLButtonElement>('[data-horse-id="2"]')!.click();
    await flush(element);
    expect(element.querySelector('[data-horse-id="2"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("invalidates late account responses and stops polling on disconnection and close", async () => {
    let release!: (value: HorseRacingSnapshot) => void;
    const old = new Promise<HorseRacingSnapshot>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async () => old);
    const element = mount(request);
    await flush(element);
    element.client = racingClient(async () => snapshot({ gold: 7 }));
    element.preferenceScope = "account-b";
    await flush(element);
    release(snapshot({ gold: 999 }));
    await flush(element);
    expect(element.textContent).toContain("7 G");
    expect(element.textContent).not.toContain("999 G");
    element.client = null;
    await flush(element);
    const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(count);
    element.remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses polling while hidden, resumes once visible and announces refunded receipts", async () => {
    const race = snapshot().race!;
    race.status = "cancelled";
    race.cancellationReason = "insufficient_participants";
    race.myBets = [
      {
        id: "refund",
        raceId: race.id,
        market: "win",
        selection: ["1"],
        amount: 50,
        payout: 50,
        refunded: true,
        quotedOdds: null,
        potentialPayout: null,
        cancelledAt: null,
      },
    ];
    const request = vi.fn(async () => snapshot({ race }));
    const element = mount(request);
    await flush(element);
    expect(element.textContent).toContain("50G 환불 완료");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledOnce();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(element);
    expect(request).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("keeps app focus usable and light polling minimized, restores the rail and closes immediately on Escape", async () => {
    const request = vi.fn(async () => snapshot());
    const element = mount(request);
    await flush(element);
    expect(element.querySelector(".platformclaw-racing")?.getAttribute("role")).toBe("region");
    expect(element.querySelector("[aria-modal='true']")).toBeNull();
    expect(element.querySelector(".platformclaw-racing-dock--expanded")).toBeNull();
    expect(document.body.classList.contains("platformclaw-racing-rail")).toBe(true);
    const appInput = document.createElement("input");
    document.body.prepend(appInput);
    appInput.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    appInput.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(appInput);
    element.querySelector<HTMLButtonElement>("[data-racing-collapse]")!.click();
    await flush(element);
    expect(element.querySelector(".platformclaw-racing")).toBeNull();
    expect(element.querySelector(".platformclaw-racing-pill")?.textContent).toContain(
      "쉬어가기 · 경주",
    );
    expect(document.body.classList.contains("platformclaw-racing-rail--minimized")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    element.querySelector<HTMLButtonElement>("[data-racing-restore]")!.click();
    await flush(element);
    expect(request).toHaveBeenCalledTimes(2);
    element.querySelector<HTMLButtonElement>("[data-racing-expand]")!.click();
    await flush(element);
    expect(element.querySelector(".platformclaw-racing-dock--expanded")).not.toBeNull();
    expect(element.querySelector("[aria-modal='true']")).toBeNull();
    const exit = vi.fn();
    element.addEventListener("racing-exit", exit);
    appInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(exit).toHaveBeenCalledOnce();
    await flush(element);
    // JSDOM SelectionImpl queues a zero-delay selectionchange when focused DOM is removed.
    // Drain that DOM task; leaked polling/animation timers must still fail the strict zero assertion.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.body.classList.contains("platformclaw-racing-rail")).toBe(false);
    const requestsAtClose = request.mock.calls.length;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    const replacement = vi.fn(async () => snapshot({ gold: 7 }));
    element.client = racingClient(replacement);
    element.preferenceScope = "new-account";
    element.requestUpdate();
    await flush(element);
    await vi.advanceTimersByTimeAsync(2_000);
    appInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(exit).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(requestsAtClose);
    expect(replacement).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(element.querySelector(".platformclaw-racing, .platformclaw-racing-pill")).toBeNull();
    expect(document.body.classList.contains("platformclaw-racing-rail")).toBe(false);
  });

  it("quotes quinella before any tickets exist and shows historical actual payouts without a new promise", async () => {
    const race = snapshot().race!;
    const element = mount(async () => snapshot({ race }));
    await flush(element);
    const quinella = Array.from(
      element.querySelectorAll<HTMLButtonElement>(".platformclaw-racing__markets button"),
    ).find((button) => button.textContent?.trim() === "복승")!;
    quinella.click();
    await flush(element);
    element.querySelector<HTMLButtonElement>('[data-horse-id="1"]')!.click();
    element.querySelector<HTMLButtonElement>('[data-horse-id="2"]')!.click();
    await flush(element);
    const quote = race.quotes.find(
      (entry) => entry.market === "quinella" && entry.selection.join(",") === "1,2",
    )!;
    expect(element.querySelector("[data-potential-payout]")?.textContent?.trim()).toBe(
      `${quoteHorsePayout(quote, 50)}G`,
    );
    expect(element.textContent).toContain("지급 배당");
    expect(race.totalStake).toBe(0);
    const historical = {
      ...race,
      status: "settled" as const,
      pricingVersion: "pool-v1" as const,
      quotes: [],
      myBets: [
        {
          id: "old",
          raceId: race.id,
          market: "win" as const,
          selection: ["1"],
          amount: 5,
          payout: 9,
          refunded: false,
          quotedOdds: null,
          potentialPayout: null,
          cancelledAt: null,
        },
      ],
    };
    element.client = racingClient(async () => snapshot({ race: historical }));
    await flush(element);
    expect(element.textContent).toContain("지급 9G · 순손익 +4G");
    expect(element.textContent).toContain("과거 배당");
    expect(element.querySelector("[data-potential-payout]")?.textContent?.trim()).toBe("—");
  });

  it("rechecks the same cancellation after a lost reply, blocks new bets and removes the live-feed entry", async () => {
    const quote = snapshot().race!.quotes[0]!;
    const receipt = {
      id: "ticket-1",
      raceId: "race-11",
      market: "win" as const,
      selection: ["1"],
      amount: 50,
      payout: null as number | null,
      refunded: false,
      quotedOdds: quote.odds,
      potentialPayout: quoteHorsePayout(quote, 50),
      cancelledAt: null as number | null,
    };
    let current = snapshot({
      gold: 50,
      walletRevision: 1,
      race: {
        ...snapshot().race!,
        myBets: [receipt],
        liveBets: [
          {
            id: receipt.id,
            displayName: "직원 가",
            market: "win",
            selection: ["1"],
            amount: 50,
            placedAt: now,
          },
        ],
        liveBetCount: 1,
      },
    });
    const cancels: unknown[] = [];
    const element = mount(async (method, params) => {
      if (method === HORSE_RACING_RPC.snapshot) {
        return current;
      }
      expect(method).toBe(HORSE_RACING_RPC.cancel);
      cancels.push(params);
      if (cancels.length === 1) {
        throw new Error("reply lost");
      }
      const cancelled = { ...receipt, cancelledAt: now + 1, payout: 50, refunded: true };
      current = {
        ...current,
        gold: 100,
        walletRevision: 2,
        race: { ...current.race!, myBets: [cancelled], liveBets: [], liveBetCount: 0 },
      };
      return { receipt: cancelled, snapshot: current };
    });
    await flush(element);
    expect(element.querySelector(".platformclaw-racing__live-feed")?.textContent).toContain(
      "직원 가",
    );
    element.querySelector<HTMLButtonElement>('[data-cancel-bet="ticket-1"]')!.click();
    await flush(element);
    expect(element.textContent).toContain("취소 결과를 확인하지 못했습니다");
    expect(element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.disabled).toBe(
      true,
    );
    current = {
      ...current,
      serverNow: current.race!.closesAt + 1,
      race: { ...current.race!, status: "locked" },
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(element);
    element.querySelector<HTMLButtonElement>('[data-cancel-bet="ticket-1"]')!.click();
    await flush(element);
    expect(cancels).toEqual([{ betId: "ticket-1" }, { betId: "ticket-1" }]);
    expect(element.textContent).toContain("베팅 취소 · 50G 환불 완료");
    expect(element.querySelector(".platformclaw-racing__live-feed")?.textContent).not.toContain(
      "직원 가",
    );
    expect(element.textContent).toContain("100 G");
  });

  it("pins an unknown cancellation across hidden hourly rollover and releases it after authoritative settlement", async () => {
    const race = snapshot().race!;
    const receipt = {
      id: "rollover-ticket",
      raceId: race.id,
      market: "win" as const,
      selection: ["1"],
      amount: 50,
      payout: null as number | null,
      refunded: false,
      cancelledAt: null,
      quotedOdds: race.quotes[0]!.odds,
      potentialPayout: 151,
    };
    let original = snapshot({ gold: 50, race: { ...race, myBets: [receipt] } });
    let rollover = false;
    const requests: unknown[] = [];
    const next = snapshot({
      serverNow: now + 3_600_000,
      race: {
        ...race,
        id: "race-12",
        startsAt: race.startsAt + 3_600_000,
        closesAt: race.closesAt + 3_600_000,
        endsAt: race.endsAt + 3_600_000,
      },
    });
    const element = mount(async (method, params) => {
      if (method === HORSE_RACING_RPC.cancel) {
        throw new Error("response lost");
      }
      requests.push(params);
      return rollover && !(params as { raceId?: string }).raceId ? next : original;
    });
    await flush(element);
    element.querySelector<HTMLButtonElement>('[data-cancel-bet="rollover-ticket"]')!.click();
    await flush(element);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    rollover = true;
    original = {
      ...original,
      serverNow: next.serverNow,
      race: { ...original.race!, status: "settled", myBets: [{ ...receipt, payout: 0 }] },
    };
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(element);
    expect(requests.at(-1)).toEqual({ raceId: race.id });
    expect(element.querySelector("[data-cancel-bet]")).toBeNull();
    expect(element.textContent).toContain("취소 확인 전에 경주가 정산되었습니다");
    expect(element.textContent).not.toContain("베팅을 취소하고 베팅금 전액을 환불했습니다");
    await vi.advanceTimersByTimeAsync(1000);
    await flush(element);
    expect(requests.at(-1)).toEqual({});
    element.querySelector<HTMLButtonElement>('[data-horse-id="1"]')!.click();
    await flush(element);
    expect(element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.disabled).toBe(
      false,
    );
  });

  it("keeps an authoritative cancellation when its original request fails after polling confirms it", async () => {
    const race = snapshot().race!;
    const quote = race.quotes[0]!;
    const receipt = {
      id: "delayed-cancel",
      raceId: race.id,
      market: "win" as const,
      selection: ["1"],
      amount: 50,
      payout: null as number | null,
      refunded: false,
      quotedOdds: quote.odds,
      potentialPayout: quoteHorsePayout(quote, 50),
      cancelledAt: null as number | null,
    };
    let current = snapshot({ gold: 50, walletRevision: 1, race: { ...race, myBets: [receipt] } });
    let failCancellation!: (error: Error) => void;
    const cancellation = new Promise<unknown>((_resolve, reject) => {
      failCancellation = reject;
    });
    const element = mount(async (method) =>
      method === HORSE_RACING_RPC.snapshot ? current : cancellation,
    );
    await flush(element);
    element.querySelector<HTMLButtonElement>('[data-cancel-bet="delayed-cancel"]')!.click();
    await flush(element);
    current = {
      ...current,
      serverNow: now + 1_000,
      gold: 100,
      walletRevision: 2,
      race: { ...race, myBets: [{ ...receipt, payout: 50, refunded: true, cancelledAt: now + 1 }] },
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(element);
    expect(element.textContent).toContain("베팅을 취소하고 베팅금 전액을 환불했습니다");
    failCancellation(new Error("late connection failure"));
    await flush(element);
    expect(element.textContent).not.toContain("취소 결과를 확인하지 못했습니다");
    expect(element.querySelector("[data-cancel-bet]")).toBeNull();
    expect(element.textContent).toContain("베팅 취소 · 50G 환불 완료");
    element.querySelector<HTMLButtonElement>('[data-horse-id="1"]')!.click();
    await flush(element);
    expect(element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.disabled).toBe(
      false,
    );
  });

  it("interpolates observed perimeter progress, keeps the circuit while minimized and resizes to mobile", async () => {
    const race = {
      ...snapshot().race!,
      status: "racing" as const,
      positions: snapshot().race!.positions.map((entry) => ({
        horseId: entry.horseId,
        position: 10,
      })),
    };
    let current = snapshot({ race });
    const element = mount(async () => current);
    await flush(element);
    expect(element.querySelectorAll("[data-perimeter-horse]")).toHaveLength(6);
    const point = horsePerimeterPoint(window.innerWidth, window.innerHeight, 10, 0);
    expect(element.querySelector('[data-perimeter-horse="1"]')?.getAttribute("transform")).toBe(
      `translate(${point.x} ${point.y})`,
    );
    current = {
      ...current,
      serverNow: now + 1_000,
      race: {
        ...race,
        positions: race.positions.map((entry) => ({ horseId: entry.horseId, position: 11 })),
      },
    };
    await vi.advanceTimersByTimeAsync(1_500);
    const transform = element
      .querySelector('[data-perimeter-horse="1"]')!
      .getAttribute("transform")!;
    const y = Number(transform.match(/translate\([^ ]+ ([^)]+)\)/u)?.[1]);
    const target = horsePerimeterPoint(window.innerWidth, window.innerHeight, 11, 0);
    expect(y).toBeGreaterThan(point.y);
    expect(y).toBeLessThanOrEqual(target.y);
    element.querySelector<HTMLButtonElement>("[data-racing-collapse]")!.click();
    await flush(element);
    expect(element.querySelectorAll("[data-perimeter-horse]")).toHaveLength(6);
    expect(element.querySelector(".platformclaw-racing")).toBeNull();
    const width = window.innerWidth;
    const height = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 740 });
    try {
      window.dispatchEvent(new Event("resize"));
      await flush(element);
      expect(element.querySelector(".platformclaw-racing-perimeter")?.getAttribute("viewBox")).toBe(
        "0 0 390 740",
      );
      expect(document.body.classList.contains("platformclaw-racing-rail")).toBe(false);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    }
  });

  it("accepts all three named markets at 50G and uses the exact net quote without a second fee", async () => {
    const bets: HorseBetRequest[] = [];
    const current = snapshot({ gold: 500 });
    const element = mount(async (method, params) => {
      if (method === HORSE_RACING_RPC.snapshot) {
        return current;
      }
      const request = params as HorseBetRequest;
      bets.push(request);
      return {
        snapshot: current,
        receipt: {
          ...request,
          id: "ticket",
          payout: null,
          refunded: false,
          cancelledAt: null,
          quotedOdds: 1,
          potentialPayout: 50,
        },
      };
    });
    await flush(element);
    expect(element.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("50");
    expect(element.querySelectorAll("[data-racing-amount]")).toHaveLength(5);
    expect(element.querySelector<HTMLButtonElement>('[data-racing-amount="1000"]')!.disabled).toBe(
      true,
    );
    expect(element.querySelector<HTMLInputElement>('input[type="number"]')!.max).toBe("500");
    for (const market of ["win", "quinella", "quinella-place"] as const) {
      element.querySelector<HTMLButtonElement>(`[data-racing-market="${market}"]`)!.click();
      await flush(element);
      element.querySelector<HTMLButtonElement>('[data-horse-id="1"]')!.click();
      if (market !== "win") {
        element.querySelector<HTMLButtonElement>('[data-horse-id="2"]')!.click();
      }
      await flush(element);
      expect(element.querySelector("[data-racing-selection]")!.textContent).toContain("모리");
      if (market !== "win") {
        expect(element.querySelector("[data-racing-selection]")!.textContent).toContain("파리");
      }
      const quote = current.race!.quotes.find(
        (entry) =>
          entry.market === market &&
          entry.selection[0] === "1" &&
          (market === "win" || entry.selection[1] === "2"),
      )!;
      expect(element.querySelector("[data-potential-payout]")!.textContent!.trim()).toBe(
        `${quoteHorsePayout(quote, 50).toLocaleString()}G`,
      );
      element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.click();
      await flush(element);
    }
    expect(bets.map((bet) => bet.market)).toEqual(["win", "quinella", "quinella-place"]);
    expect(bets.every((bet) => bet.amount === 50)).toBe(true);
    const input = element.querySelector<HTMLInputElement>('input[type="number"]')!;
    for (const amount of [49, 501, 1001]) {
      input.value = String(amount);
      input.dispatchEvent(new Event("input"));
      await flush(element);
      expect(
        element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.disabled,
      ).toBe(true);
    }
  });

  it("reorders six named right-side ranks from server positions and honors finish places before progress ties", async () => {
    const race = snapshot().race!;
    let current = snapshot({
      race: {
        ...race,
        status: "racing",
        positions: race.horses.map((horse, index) => ({ horseId: horse.id, position: 50 - index })),
      },
    });
    const element = mount(async () => current);
    await flush(element);
    const order = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>("[data-racing-rank]"),
        (row) => row.dataset.racingRank,
      );
    expect(order()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(element.querySelector("[data-racing-rank='1']")!.textContent).toContain("모리");
    expect(element.querySelectorAll(".platformclaw-racing__ranking progress")).toHaveLength(6);
    current = {
      ...current,
      serverNow: now + 1000,
      race: {
        ...current.race!,
        positions: [
          { horseId: "1", position: 100, finishPlace: 2 },
          { horseId: "2", position: 100, finishPlace: 1 },
          { horseId: "3", position: 60 },
          { horseId: "4", position: 80 },
          { horseId: "5", position: 70 },
          { horseId: "6", position: 50 },
        ],
      },
    };
    await vi.advanceTimersByTimeAsync(1000);
    await flush(element);
    expect(order()).toEqual(["2", "1", "4", "5", "3", "6"]);
    current = {
      ...current,
      serverNow: now + 2000,
      race: { ...current.race!, status: "settled", finishOrder: ["2", "1", "4", "5", "3", "6"] },
    };
    await vi.advanceTimersByTimeAsync(1000);
    await flush(element);
    expect(order()).toEqual(current.race!.finishOrder);
    expect(element.querySelectorAll(".platformclaw-racing__podium strong")).toHaveLength(3);
    expect(element.querySelector(".platformclaw-racing__podium")!.textContent).toContain("로시");
  });

  it("reveals ranks on phase transitions while preserving manual scroll during live polling", async () => {
    let current = snapshot();
    const element = mount(async () => current);
    await flush(element);
    const panel = element.querySelector<HTMLElement>(".platformclaw-racing")!;
    panel.scrollTop = 200;
    current = { ...current, serverNow: now + 1000, race: { ...current.race!, status: "racing" } };
    await vi.advanceTimersByTimeAsync(1000);
    await flush(element);
    expect(panel.scrollTop).toBe(0);
    panel.scrollTop = 100;
    current = { ...current, serverNow: now + 2000 };
    await vi.advanceTimersByTimeAsync(1000);
    await flush(element);
    expect(panel.scrollTop).toBe(100);
    current = {
      ...current,
      serverNow: now + 3000,
      race: { ...current.race!, status: "settled", finishOrder: ["1", "2", "3", "4", "5", "6"] },
    };
    await vi.advanceTimersByTimeAsync(1000);
    await flush(element);
    expect(panel.scrollTop).toBe(0);
  });

  it("reacts once to an observed own winning settlement and clears it on account replacement", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const race = snapshot().race!;
    let current = snapshot({ race: { ...race, status: "locked" } });
    const element = mount(async () => current);
    await flush(element);
    const receipt = {
      id: "win",
      raceId: race.id,
      market: "win" as const,
      selection: ["1"],
      amount: 50,
      payout: 151,
      refunded: false,
      cancelledAt: null,
      quotedOdds: 3.03125,
      potentialPayout: 151,
    };
    current = {
      ...current,
      serverNow: now + 1000,
      race: {
        ...race,
        status: "settled",
        finishOrder: ["1", "2", "3", "4", "5", "6"],
        myBets: [receipt],
      },
    };
    await vi.advanceTimersByTimeAsync(1000);
    await flush(element);
    const toast = element.querySelector("[data-racing-win]")!;
    expect(toast.textContent).toContain("지급 151G · 순손익 +101G");
    expect(toast.classList.contains("platformclaw-racing__win--static")).toBe(true);
    expect(toast.getAttribute("aria-live")).toBe("polite");
    expect(element.querySelector(".platformclaw-racing__receipts")!.textContent).toContain("모리");
    await vi.advanceTimersByTimeAsync(7000);
    await flush(element);
    expect(element.querySelector("[data-racing-win]")).toBeNull();
    element.client = racingClient(async () => current);
    element.preferenceScope = "another-account";
    await flush(element);
    expect(element.querySelector("[data-racing-win]")).toBeNull();
  });

  it("restores opacity across reopenings, isolates accounts and servers, and resets to fully visible", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const request = vi.fn(async (_method: string, _params?: unknown) => snapshot());
    const first = mount(request);
    await flush(first);
    const input = first.querySelector<HTMLInputElement>("#racing-opacity")!;
    expect([input.min, input.max, input.step, input.value]).toEqual(["30", "100", "5", "100"]);
    input.value = "30";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(first);
    expect(first.style.getPropertyValue("--racing-opacity")).toBe("0.3");
    expect(first.textContent).toContain("이 브라우저의 내 계정에 저장됨");
    expect(loadHorseRacingOpacity("account-a")).toBe(30);
    first.remove();

    const reopened = mount(request);
    await flush(reopened);
    expect(reopened.querySelector<HTMLInputElement>("#racing-opacity")!.value).toBe("30");
    reopened.preferenceScope = "account-b";
    await flush(reopened);
    expect(reopened.style.getPropertyValue("--racing-opacity")).toBe("1");
    reopened.preferenceScope = "other-server:account-a";
    await flush(reopened);
    expect(reopened.querySelector<HTMLInputElement>("#racing-opacity")!.value).toBe("100");
    reopened.preferenceScope = "account-a";
    await flush(reopened);
    reopened.querySelector<HTMLButtonElement>("[data-racing-collapse]")!.click();
    await flush(reopened);
    expect(reopened.style.getPropertyValue("--racing-opacity")).toBe("0.3");
    reopened.querySelector<HTMLButtonElement>("[data-racing-restore]")!.click();
    await flush(reopened);
    reopened.querySelector<HTMLButtonElement>("[data-racing-opacity-reset]")!.click();
    await flush(reopened);
    expect(reopened.style.getPropertyValue("--racing-opacity")).toBe("1");
    expect(loadHorseRacingOpacity("account-a")).toBe(100);
    expect(request.mock.calls.every(([method]) => method === HORSE_RACING_RPC.snapshot)).toBe(true);
  });

  it("keeps opacity usable when browser storage is blocked and reports the unsaved preference", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    });
    const element = mount(async () => snapshot());
    await flush(element);
    const input = element.querySelector<HTMLInputElement>("#racing-opacity")!;
    input.value = "30";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush(element);
    expect(element.style.getPropertyValue("--racing-opacity")).toBe("0.3");
    expect(element.textContent).toContain("설정을 저장할 수 없어 이번 실행에만 적용됩니다");
    element.querySelector<HTMLButtonElement>("[data-racing-opacity-reset]")!.click();
    await flush(element);
    expect(element.style.getPropertyValue("--racing-opacity")).toBe("1");
  });

  it("discards malformed or out-of-range opacity and never writes an unscoped preference", () => {
    const getItem = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem, setItem });
    for (const raw of ["{", "null", "0", "29", "31", "101", '"30"', "[]", "{}"]) {
      getItem.mockReturnValueOnce(raw);
      expect(loadHorseRacingOpacity("account-a")).toBe(100);
    }
    expect(saveHorseRacingOpacity(null, 30)).toBe(false);
    expect(saveHorseRacingOpacity("account-a", 0)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps accepted tickets cancellable while a changed opening time still blocks new bets", async () => {
    const race = snapshot().race!;
    const receipt = {
      id: "already-accepted",
      raceId: race.id,
      market: "win" as const,
      selection: ["1"],
      amount: 50,
      payout: null,
      refunded: false,
      cancelledAt: null,
      quotedOdds: race.quotes[0]!.odds,
      potentialPayout: 151,
    };
    const element = mount(async () =>
      snapshot({
        race: { ...race, opensAt: now + 60_000, myBets: [receipt] },
      }),
    );
    await flush(element);
    expect(element.querySelector<HTMLButtonElement>(".platformclaw-racing__submit")!.disabled).toBe(
      true,
    );
    expect(element.querySelector<HTMLButtonElement>('[data-horse-id="1"]')!.disabled).toBe(true);
    expect(
      element.querySelector<HTMLButtonElement>('[data-cancel-bet="already-accepted"]')!.disabled,
    ).toBe(false);
  });

  it("freezes an observed fall immediately, preserves the pose while minimized, and resumes after recovery", async () => {
    const race = snapshot().race!;
    let current = snapshot({
      race: { ...race, status: "racing", positions: [{ horseId: "1", position: 10 }] },
    });
    const element = mount(async () => current);
    await flush(element);
    current = {
      ...current,
      serverNow: now + 1_000,
      race: { ...current.race!, positions: [{ horseId: "1", position: 10.8, motion: "fallen" }] },
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(element);
    const runner = element.querySelector<SVGGElement>('[data-perimeter-horse="1"]')!;
    const point = horsePerimeterPoint(window.innerWidth, window.innerHeight, 10.8, 0);
    const stopped = `translate(${point.x} ${point.y})`;
    expect(runner.getAttribute("transform")).toBe(stopped);
    expect(runner.dataset.motion).toBe("fallen");
    expect(runner.dataset.boosting).toBe("false");
    expect(element.textContent).toContain("넘어짐 · 잠시 정지");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(runner.getAttribute("transform")).toBe(stopped);
    element.querySelector<HTMLButtonElement>("[data-racing-collapse]")!.click();
    await flush(element);
    expect(element.querySelector('[data-racing-motion="fallen"]')).not.toBeNull();
    expect(runner.dataset.motion).toBe("fallen");
    current = {
      ...current,
      serverNow: now + 3_000,
      race: {
        ...current.race!,
        positions: [{ horseId: "1", position: 10.8, motion: "recovering" }],
      },
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(element);
    expect(runner.dataset.motion).toBe("recovering");
    expect(runner.getAttribute("transform")).toBe(stopped);
    expect(element.textContent).toContain("일어나는 중");
    element.querySelector<HTMLButtonElement>("[data-racing-restore]")!.click();
    await flush(element);
    Array.from(element.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "움직임 줄이기")!
      .click();
    await flush(element);
    expect(element.querySelector(".platformclaw-racing-perimeter--paused")).not.toBeNull();
    expect(runner.dataset.motion).toBe("recovering");
    current = {
      ...current,
      serverNow: now + 5_000,
      race: { ...current.race!, positions: [{ horseId: "1", position: 11.8 }] },
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(element);
    expect(runner.dataset.motion).toBe("running");
    expect(runner.getAttribute("transform")).not.toBe(stopped);
    expect(element.querySelector("[data-racing-motion]")).toBeNull();
    expect(element.querySelector(".platformclaw-racing__wallet")!.textContent).toContain("100 G");
  });
});
