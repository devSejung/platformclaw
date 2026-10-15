import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  HorseRacingError,
  HORSE_RACING_MIN_BET_GOLD,
  HORSE_RACING_MAX_BET_GOLD,
  HORSE_RACING_PRICING_VERSION,
  type HorseBetReceipt,
  type HorseBetRequest,
  type HorseBetResult,
  type HorseRaceQuote,
  type HorseRacingSnapshot,
  type HorseRacingStore,
  type RacingHorse,
} from "./horse-racing-contracts.js";
import {
  createRacingHorses,
  drawHorseFinishOrder,
  getHorseRaceDayStarts,
  horseRaceCommitment,
  horseRacePositions,
  horseRaceOpensAt,
  nextHorseRaceStartsAt,
  HORSE_RACE_DURATION_MS,
  HORSE_RACE_LOCK_BEFORE_MS,
  HORSE_RACING_ALGORITHM_VERSION,
  HORSE_RACING_ANIMATION_VERSION,
} from "./horse-racing-engine.js";
import { quoteHorseBet } from "./horse-racing-pricing.js";
import {
  createSyncKysely,
  executeSync,
  runImmediateTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import type { SqliteGameEconomy } from "./sqlite-game-economy.js";
import {
  ensureHorseRacingSchema,
  type HorseBetRow,
  type HorseRaceRow,
  type HorseRacingDatabase,
} from "./sqlite-schema-horse-racing.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type RacingWallet = {
  prepare(): void;
  ensure(userId: string): void;
  economy: SqliteGameEconomy;
};

type QuotedBet = HorseBetRow & {
  quoted_odds: number | null;
  potential_payout: number | null;
  cancelled_at: number | null;
};

function ticketReceipt(row: QuotedBet): HorseBetReceipt {
  return {
    id: row.id,
    raceId: row.race_id,
    market: row.market,
    selection: row.selection.split(","),
    amount: row.amount,
    payout: row.payout,
    refunded: row.refunded === 1,
    quotedOdds: row.quoted_odds,
    potentialPayout: row.potential_payout,
    cancelledAt: row.cancelled_at,
  };
}

function canonicalSelection(request: HorseBetRequest): string {
  if (
    !["win", "quinella", "quinella-place"].includes(request.market) ||
    !Array.isArray(request.selection) ||
    request.selection.length !== (request.market === "win" ? 1 : 2) ||
    request.selection.some((id) => typeof id !== "string" || !/^[1-6]$/.test(id)) ||
    new Set(request.selection).size !== request.selection.length
  ) {
    throw new HorseRacingError(
      "invalid_selection",
      "단승은 말 1마리, 복승·복연승은 서로 다른 말 2마리를 선택하세요.",
    );
  }
  return request.selection.toSorted().join(",");
}

export class SqliteHorseRacingStore implements HorseRacingStore {
  private readonly query = createSyncKysely<
    HorseRacingDatabase & Pick<ControlPlaneDatabase, "platform_users">
  >();
  private ready = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly wallet: RacingWallet,
  ) {}

  private prepare(): void {
    if (!this.ready) {
      this.wallet.prepare();
      ensureHorseRacingSchema(this.db);
      this.ready = true;
    }
  }

  advance(now: number): void {
    this.prepare();
    runImmediateTransaction(this.db, () => {
      const starts = getHorseRaceDayStarts(now);
      starts.push(nextHorseRaceStartsAt(now));
      for (const startsAt of new Set(starts)) {
        const id = `race-${startsAt}`;
        if (!this.findRace(id)) {
          const seed = randomBytes(32).toString("hex");
          const horses = createRacingHorses(id, seed);
          executeSync(
            this.db,
            this.query.insertInto("horse_races").values({
              id,
              starts_at: startsAt,
              status: "scheduled",
              horses_json: JSON.stringify(horses),
              seed,
              commitment: horseRaceCommitment(id, horses, seed),
              algorithm_version: HORSE_RACING_ALGORITHM_VERSION,
              pricing_version: HORSE_RACING_PRICING_VERSION,
              animation_version: HORSE_RACING_ANIMATION_VERSION,
              finish_order_json: null,
              cancellation_reason: null,
            }),
          );
        }
      }
      const pending = executeSync(
        this.db,
        this.query
          .selectFrom("horse_races")
          .selectAll()
          .where("status", "not in", ["settled", "cancelled"])
          .orderBy("starts_at", "asc"),
      ).rows;
      for (const race of pending) {
        if (now < horseRaceOpensAt(race.starts_at)) {
          continue;
        }
        if (
          race.algorithm_version !== HORSE_RACING_ALGORITHM_VERSION ||
          race.pricing_version !== HORSE_RACING_PRICING_VERSION ||
          race.animation_version !== HORSE_RACING_ANIMATION_VERSION
        ) {
          this.refund(this.raceBets(race.id), now);
          executeSync(
            this.db,
            this.query
              .updateTable("horse_races")
              .set({ status: "cancelled", cancellation_reason: "engine_changed" })
              .where("id", "=", race.id),
          );
          continue;
        }
        if (now < race.starts_at - HORSE_RACE_LOCK_BEFORE_MS) {
          this.setRaceStatus(race.id, "betting");
          continue;
        }
        const bets = this.raceBets(race.id);
        if (new Set(bets.map((bet) => bet.user_id)).size < 2) {
          this.refund(bets, now);
          executeSync(
            this.db,
            this.query
              .updateTable("horse_races")
              .set({ status: "cancelled", cancellation_reason: "insufficient_participants" })
              .where("id", "=", race.id),
          );
          continue;
        }
        // Record the drawn fact at close. Live positions, crash recovery and payout all consume this same order.
        const horses = JSON.parse(race.horses_json) as RacingHorse[];
        const order = race.finish_order_json
          ? (JSON.parse(race.finish_order_json) as string[])
          : drawHorseFinishOrder(horses, race.seed);
        if (!race.finish_order_json) {
          executeSync(
            this.db,
            this.query
              .updateTable("horse_races")
              .set({ finish_order_json: JSON.stringify(order) })
              .where("id", "=", race.id),
          );
        }
        if (now < race.starts_at) {
          this.setRaceStatus(race.id, "locked");
        } else if (now < race.starts_at + HORSE_RACE_DURATION_MS) {
          this.setRaceStatus(race.id, "racing");
        } else {
          this.settle(bets, order, now);
          executeSync(
            this.db,
            this.query
              .updateTable("horse_races")
              .set({ status: "settled", finish_order_json: JSON.stringify(order) })
              .where("id", "=", race.id),
          );
        }
      }
    });
  }

  snapshot(userId: string, now: number, raceId?: string): HorseRacingSnapshot {
    this.advance(now);
    return runImmediateTransaction(this.db, () => {
      this.wallet.ensure(userId);
      return this.buildSnapshot(userId, now, raceId);
    });
  }

  placeBet(userId: string, request: HorseBetRequest, now: number): HorseBetResult {
    this.advance(now);
    if (
      typeof request.requestId !== "string" ||
      !request.requestId.trim() ||
      request.requestId.length > 128 ||
      typeof request.raceId !== "string" ||
      request.raceId.length > 128 ||
      !Number.isSafeInteger(request.amount) ||
      request.amount < 1
    ) {
      throw new HorseRacingError("invalid_bet", "베팅금은 50~1,000G 정수여야 합니다.");
    }
    const selection = canonicalSelection(request);
    return runImmediateTransaction(this.db, () => {
      this.wallet.ensure(userId);
      const prior = takeFirstSync(
        this.db,
        this.betsQuery()
          .where("horse_bets.user_id", "=", userId)
          .where("horse_bets.request_id", "=", request.requestId),
      );
      if (prior) {
        if (
          prior.race_id !== request.raceId ||
          prior.market !== request.market ||
          prior.selection !== selection ||
          prior.amount !== request.amount
        ) {
          throw new HorseRacingError(
            "idempotency_conflict",
            "같은 요청 번호로 다른 베팅을 접수할 수 없습니다.",
          );
        }
        return {
          receipt: ticketReceipt(prior),
          snapshot: this.buildSnapshot(userId, now, prior.race_id),
        };
      }
      // A replay honors an already accepted stake, including pre-limit preview tickets.
      // Only new debits apply the current policy; tightening limits cannot erase a durable receipt.
      if (
        request.amount < HORSE_RACING_MIN_BET_GOLD ||
        request.amount > HORSE_RACING_MAX_BET_GOLD
      ) {
        throw new HorseRacingError("invalid_bet", "베팅금은 50~1,000G 정수여야 합니다.");
      }
      // Re-read the race under the same write lock as the debit: a late ticket cannot cross close/settlement.
      const race = this.findRace(request.raceId);
      if (
        !race ||
        race.status !== "betting" ||
        now < horseRaceOpensAt(race.starts_at) ||
        now >= race.starts_at - HORSE_RACE_LOCK_BEFORE_MS
      ) {
        throw new HorseRacingError(
          "betting_closed",
          "베팅 접수 시간이 아닙니다. 다음 경주 시간을 확인하세요.",
        );
      }
      const currentBets = this.raceBets(race.id);
      // Cancelled receipts remain visible; keep the existing lifetime quota to bound churn and history.
      if (this.raceBets(race.id, true).filter((bet) => bet.user_id === userId).length >= 20) {
        throw new HorseRacingError(
          "ticket_limit",
          "한 경주에 누적 최대 20장의 베팅표를 접수할 수 있습니다. 취소한 베팅표도 포함됩니다.",
        );
      }
      if (currentBets.reduce((sum, bet) => sum + bet.amount, 0) + request.amount > 1_000_000_000) {
        throw new HorseRacingError("stake_limit", "이 경주의 베팅 접수 한도에 도달했습니다.");
      }
      const quote = quoteHorseBet(
        JSON.parse(race.horses_json) as RacingHorse[],
        request.market,
        request.selection,
        request.amount,
      );
      const ticket: HorseBetRow = {
        id: randomUUID(),
        user_id: userId,
        request_id: request.requestId,
        race_id: race.id,
        market: request.market,
        selection,
        amount: request.amount,
        payout: null,
        refunded: 0,
      };
      this.wallet.economy.change(userId, -ticket.amount, "horse_bet", ticket.id, now);
      executeSync(this.db, this.query.insertInto("horse_bets").values(ticket));
      // The accepted payout is recorded with the debit; later bettors and deploys cannot change this promise.
      executeSync(
        this.db,
        this.query
          .insertInto("horse_bet_quotes")
          .values({ bet_id: ticket.id, odds: quote.odds, potential_payout: quote.potentialPayout }),
      );
      executeSync(
        this.db,
        this.query.insertInto("horse_bet_activity").values({ bet_id: ticket.id, created_at: now }),
      );
      return {
        receipt: ticketReceipt({
          ...ticket,
          quoted_odds: quote.odds,
          potential_payout: quote.potentialPayout,
          cancelled_at: null,
        }),
        snapshot: this.buildSnapshot(userId, now, race.id),
      };
    });
  }

  cancelBet(userId: string, betId: string, now: number): HorseBetResult {
    this.advance(now);
    if (typeof betId !== "string" || !betId.trim() || betId.length > 128) {
      throw new HorseRacingError("invalid_bet", "취소할 베팅표 번호가 올바르지 않습니다.");
    }
    return runImmediateTransaction(this.db, () => {
      this.wallet.ensure(userId);
      const bet = takeFirstSync(
        this.db,
        this.betsQuery()
          .where("horse_bets.id", "=", betId)
          .where("horse_bets.user_id", "=", userId),
      );
      if (!bet) {
        throw new HorseRacingError("unknown_bet", "취소할 베팅표를 찾을 수 없습니다.");
      }
      // The durable cancellation is the replay receipt, even after close or a restart.
      if (bet.cancelled_at !== null) {
        return {
          receipt: ticketReceipt(bet),
          snapshot: this.buildSnapshot(userId, now, bet.race_id),
        };
      }
      const race = this.findRace(bet.race_id);
      // A schedule update can move opening later after this ticket was accepted.
      // Its owner retains cancellation until close; the opening gate belongs to new debits only.
      if (!race || race.status !== "betting" || now >= race.starts_at - HORSE_RACE_LOCK_BEFORE_MS) {
        throw new HorseRacingError("betting_closed", "베팅 접수가 마감되어 취소할 수 없습니다.");
      }
      // Cancellation, refund and ledger share the race write lock; recovery sees only active tickets.
      executeSync(
        this.db,
        this.query
          .insertInto("horse_bet_cancellations")
          .values({ bet_id: bet.id, created_at: now }),
      );
      this.refund([bet], now);
      return {
        receipt: ticketReceipt({ ...bet, cancelled_at: now, payout: bet.amount, refunded: 1 }),
        snapshot: this.buildSnapshot(userId, now, race.id),
      };
    });
  }

  private findRace(id: string): HorseRaceRow | undefined {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("horse_races").selectAll().where("id", "=", id),
    );
  }

  private betsQuery() {
    return this.query
      .selectFrom("horse_bets")
      .leftJoin("horse_bet_quotes", "horse_bet_quotes.bet_id", "horse_bets.id")
      .leftJoin("horse_bet_cancellations", "horse_bet_cancellations.bet_id", "horse_bets.id")
      .selectAll("horse_bets")
      .select([
        "horse_bet_quotes.odds as quoted_odds",
        "horse_bet_quotes.potential_payout",
        "horse_bet_cancellations.created_at as cancelled_at",
      ]);
  }

  private raceBets(id: string, includeCancelled = false): QuotedBet[] {
    const query = this.betsQuery()
      .where("horse_bets.race_id", "=", id)
      .orderBy("horse_bets.id", "asc");
    return executeSync(
      this.db,
      includeCancelled ? query : query.where("horse_bet_cancellations.bet_id", "is", null),
    ).rows;
  }

  private setRaceStatus(id: string, status: HorseRaceRow["status"]): void {
    executeSync(
      this.db,
      this.query.updateTable("horse_races").set({ status }).where("id", "=", id),
    );
  }

  private refund(bets: HorseBetRow[], now: number): void {
    for (const bet of bets) {
      this.wallet.ensure(bet.user_id);
      this.wallet.economy.change(bet.user_id, bet.amount, "horse_refund", bet.id, now);
      executeSync(
        this.db,
        this.query
          .updateTable("horse_bets")
          .set({ payout: bet.amount, refunded: 1 })
          .where("id", "=", bet.id),
      );
    }
  }

  private settle(bets: QuotedBet[], order: string[], now: number): void {
    const quinella = order.slice(0, 2).toSorted().join(",");
    for (const bet of bets) {
      if (bet.potential_payout === null) {
        throw new Error("Committed fixed-odds ticket is missing its accepted payout");
      }
      const won =
        bet.market === "quinella-place"
          ? bet.selection.split(",").every((horseId) => order.slice(0, 3).includes(horseId))
          : bet.selection === (bet.market === "win" ? order[0] : quinella);
      const payout = won ? bet.potential_payout : 0;
      if (payout > 0) {
        this.wallet.ensure(bet.user_id);
        this.wallet.economy.change(bet.user_id, payout, "horse_payout", bet.id, now);
      }
      executeSync(
        this.db,
        this.query.updateTable("horse_bets").set({ payout }).where("id", "=", bet.id),
      );
    }
  }
  private buildSnapshot(userId: string, now: number, raceId?: string): HorseRacingSnapshot {
    const nextStartsAt = nextHorseRaceStartsAt(now);
    const latestStarted = takeFirstSync(
      this.db,
      this.query
        .selectFrom("horse_races")
        .selectAll()
        .where("starts_at", "<=", now)
        .orderBy("starts_at", "desc")
        .limit(1),
    );
    const recent = executeSync(
      this.db,
      this.query
        .selectFrom("horse_races")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb("horse_races.starts_at", "<=", now),
            eb.exists(
              eb
                .selectFrom("horse_bets")
                .leftJoin(
                  "horse_bet_cancellations",
                  "horse_bet_cancellations.bet_id",
                  "horse_bets.id",
                )
                .select("horse_bets.id")
                .whereRef("horse_bets.race_id", "=", "horse_races.id")
                .where("horse_bets.user_id", "=", userId)
                .where("horse_bets.payout", "is", null)
                .where("horse_bet_cancellations.bet_id", "is", null),
            ),
          ]),
        )
        .orderBy("starts_at", "desc")
        .limit(7),
    ).rows;
    // Own future tickets remain reachable after a timetable update without displacing the live race.
    const next = this.findRace(`race-${nextStartsAt}`);
    const selected = raceId
      ? this.findRace(raceId)
      : next && now >= horseRaceOpensAt(next.starts_at)
        ? next
        : (latestStarted ?? next);
    if (raceId && !selected) {
      throw new HorseRacingError("unknown_race", "경주를 찾을 수 없습니다.");
    }
    const wallet = this.wallet.economy.read(userId);
    return {
      serverNow: now,
      gold: wallet.gold,
      walletRevision: wallet.revision,
      nextStartsAt,
      recentRaces: recent.map((race) => {
        const horses = JSON.parse(race.horses_json) as RacingHorse[];
        const winner =
          race.status === "settled" && race.finish_order_json
            ? (JSON.parse(race.finish_order_json) as string[])[0]
            : null;
        return {
          id: race.id,
          startsAt: race.starts_at,
          status: race.status,
          winnerName: horses.find((horse) => horse.id === winner)?.name ?? null,
        };
      }),
      race: selected ? this.projectRace(selected, userId, now) : null,
    };
  }

  private projectRace(
    race: HorseRaceRow,
    userId: string,
    now: number,
  ): HorseRacingSnapshot["race"] {
    const horses = JSON.parse(race.horses_json) as RacingHorse[];
    const allBets = this.raceBets(race.id, true);
    const bets = allBets.filter((bet) => bet.cancelled_at === null);
    const terminal = race.status === "settled" || race.status === "cancelled";
    // Completed races read their recorded order; a future engine upgrade cannot rewrite old winners.
    const order = race.finish_order_json ? (JSON.parse(race.finish_order_json) as string[]) : [];
    const currentEngine = race.algorithm_version === HORSE_RACING_ALGORITHM_VERSION;
    const currentPricing = currentEngine && race.pricing_version === HORSE_RACING_PRICING_VERSION;
    const quotes: HorseRaceQuote[] = [];
    if (currentPricing) {
      for (const market of ["win", "quinella", "quinella-place"] as const) {
        const selections =
          market === "win"
            ? horses.map((horse) => [horse.id])
            : horses.flatMap((horse, index) =>
                horses.slice(index + 1).map((other) => [horse.id, other.id]),
              );
        for (const selection of selections) {
          const quote = quoteHorseBet(horses, market, selection, HORSE_RACING_MIN_BET_GOLD);
          quotes.push({
            market,
            selection: selection.toSorted(),
            odds: quote.odds,
            numerator: quote.numerator,
            denominator: quote.denominator,
          });
        }
      }
    }
    return {
      id: race.id,
      startsAt: race.starts_at,
      opensAt: horseRaceOpensAt(race.starts_at),
      closesAt: race.starts_at - HORSE_RACE_LOCK_BEFORE_MS,
      // v1 preview history committed a 60-second race; retain that display contract without running its retired animation.
      endsAt:
        race.starts_at +
        (race.algorithm_version === "sha256-weighted-order-v1" ? 60_000 : HORSE_RACE_DURATION_MS),
      status: race.status,
      // Private weights and condition stay server-owned until reveal; public odds alone never expose the raw seed.
      horses: horses.map((horse) => ({
        id: horse.id,
        name: horse.name,
        color: horse.color,
        speed: horse.speed,
        stamina: horse.stamina,
        rumor: currentEngine ? horse.rumor : "이전 경주의 기록입니다.",
        condition: terminal && currentEngine ? horse.condition : null,
        weight: terminal && currentEngine ? horse.weight : null,
        winProbability: terminal && currentEngine ? horse.winProbability : null,
      })),
      commitment: race.commitment,
      algorithmVersion: race.algorithm_version,
      animationVersion: race.animation_version,
      revealedSeed: terminal ? race.seed : null,
      finishOrder: race.status === "settled" ? order : null,
      positions:
        race.status === "settled"
          ? order.map((horseId, index) => ({ horseId, position: 100, finishPlace: index + 1 }))
          : race.status === "racing"
            ? horseRacePositions(horses, order, race.seed, now - race.starts_at)
            : horses.map((horse) => ({ horseId: horse.id, position: 0 })),
      pricingVersion: race.pricing_version,
      quotes,
      totalStake: bets.reduce((sum, bet) => sum + bet.amount, 0),
      liveBets: executeSync(
        this.db,
        this.query
          .selectFrom("horse_bets")
          .innerJoin("horse_bet_activity", "horse_bet_activity.bet_id", "horse_bets.id")
          .innerJoin("platform_users", "platform_users.id", "horse_bets.user_id")
          .leftJoin("horse_bet_cancellations", "horse_bet_cancellations.bet_id", "horse_bets.id")
          .select([
            "horse_bets.id",
            "horse_bets.market",
            "horse_bets.selection",
            "horse_bets.amount",
            "horse_bet_activity.created_at",
            "platform_users.display_name",
            "platform_users.account_id",
          ])
          .where("horse_bets.race_id", "=", race.id)
          .where("horse_bet_cancellations.bet_id", "is", null)
          .orderBy("horse_bet_activity.created_at", "desc")
          .orderBy("horse_bets.id", "asc")
          .limit(30),
      ).rows.map((row) => ({
        id: row.id,
        displayName: row.display_name ?? row.account_id,
        market: row.market,
        selection: row.selection.split(","),
        amount: row.amount,
        placedAt: row.created_at,
      })),
      liveBetCount: bets.length,
      participants: new Set(bets.map((bet) => bet.user_id)).size,
      myBets: allBets.filter((bet) => bet.user_id === userId).map(ticketReceipt),
      cancellationReason: race.cancellation_reason,
    };
  }
}
