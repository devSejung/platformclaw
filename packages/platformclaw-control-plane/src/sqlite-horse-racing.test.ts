import { describe, expect, it } from "vitest";
import type { RacingHorse } from "./horse-racing-contracts.js";
import {
  horseRaceCommitment,
  HORSE_RACE_DURATION_MS,
  HORSE_RACE_LOCK_BEFORE_MS,
} from "./horse-racing-engine.js";
import {
  START,
  OPEN,
  setup,
  inspect,
  finishOrder,
  bet,
  closeStore,
  createStore,
} from "./sqlite-horse-racing.test-harness.js";
describe("SQLite horse racing and shared game economy", () => {
  it("uses baseball-earned gold for racing and enhancement across connections", async () => {
    const { first, second, alice, bob, race } = await setup(49);
    const ticket = first.racing.placeBet(alice.id, bet(race.id, "alice-bet", 50, ["1"]), OPEN);
    expect(ticket.snapshot.gold).toBe(97);
    const progress = await second.loadBaseballProgress(alice.id);
    expect(progress.gold).toBe(97);
    await expect(
      second.enhanceBaseballBat({
        userId: alice.id,
        requestId: "enhance-before-hit",
        expectedRevision: progress.revision,
      }),
    ).rejects.toMatchObject({ code: "insufficient_gold" });
    const reward = await first.rewardBaseballPlateAppearance({
      userId: alice.id,
      requestId: "another-hit",
      outcome: "hit",
      distanceM: 80,
    });
    const enhanced = await second.enhanceBaseballBat({
      userId: alice.id,
      requestId: "enhance-after-hit",
      expectedRevision: reward.progress.revision,
    });
    expect(enhanced.chargedGold).toBe(100);
    expect(enhanced.progress.gold).toBe(0);
    expect(first.racing.snapshot(alice.id, OPEN).gold).toBe(0);
    expect(first.racing.snapshot(bob.id, OPEN).gold).toBe(147);
    expect(first.racing.snapshot(bob.id, OPEN).race?.myBets).toEqual([]);
    expect(first.racing.snapshot(bob.id, OPEN).race?.totalStake).toBe(50);
    const winQuote = race.quotes.find(
      (quote) => quote.market === "win" && quote.selection[0] === "1",
    )!;
    expect(ticket.receipt.quotedOdds).toBe(winQuote.odds);
    expect(ticket.receipt.potentialPayout).toBeGreaterThanOrEqual(50);
    expect(enhanced.progress.enhancement?.equipped).toBe(true);
  });

  it("withholds condition and draw weights before reveal and publishes a bounded active named bet feed", async () => {
    const { first, second, alice, bob, race } = await setup();
    expect(
      race.horses.every(
        (horse) =>
          horse.condition === null &&
          horse.weight === null &&
          horse.winProbability === null &&
          horse.rumor.length > 0,
      ),
    ).toBe(true);
    let cancelId = "";
    for (let index = 0; index < 34; index++) {
      const receipt = (index % 2 === 0 ? first : second).racing.placeBet(
        index % 2 === 0 ? alice.id : bob.id,
        bet(race.id, `feed-${index}`, 50, [String((index % 6) + 1)]),
        OPEN + index,
      ).receipt;
      if (index === 33) {
        cancelId = receipt.id;
      }
    }
    const before = first.racing.snapshot(alice.id, OPEN + 40).race!;
    expect(before.liveBetCount).toBe(34);
    expect(before.liveBets).toHaveLength(30);
    expect(before.liveBets[0]).toMatchObject({
      id: cancelId,
      displayName: "bob",
      market: "win",
      selection: ["4"],
      amount: 50,
      placedAt: OPEN + 33,
    });
    expect(
      before.liveBets.every(
        (entry) => !Object.hasOwn(entry, "userId") && !Object.hasOwn(entry, "email"),
      ),
    ).toBe(true);
    second.racing.cancelBet(bob.id, cancelId, OPEN + 41);
    const after = first.racing.snapshot(alice.id, OPEN + 42).race!;
    expect(after.liveBetCount).toBe(33);
    expect(after.liveBets.some((entry) => entry.id === cancelId)).toBe(false);
    expect(after.quotes).toEqual(before.quotes);
    const end = first.racing.snapshot(alice.id, START + HORSE_RACE_DURATION_MS, race.id).race!;
    expect(
      end.horses.every(
        (horse) => typeof horse.condition === "number" && typeof horse.weight === "number",
      ),
    ).toBe(true);
  });

  it("replays duplicate tickets without another debit, rejects conflicts and closes at the exact deadline", async () => {
    const { first, second, alice, bob, race } = await setup();
    const request = bet(race.id, "same-ticket", 350, ["2", "1"], "quinella");
    const firstTicket = first.racing.placeBet(alice.id, request, OPEN);
    const replay = second.racing.placeBet(
      alice.id,
      { ...request, selection: ["1", "2"] },
      OPEN + 1,
    );
    expect(replay.receipt).toEqual(firstTicket.receipt);
    expect(replay.snapshot.gold).toBe(850);
    expect(() => second.racing.placeBet(alice.id, { ...request, amount: 400 }, OPEN + 2)).toThrow(
      /같은 요청/,
    );
    second.racing.placeBet(
      bob.id,
      bet(race.id, "bob-ticket", 150, ["1"]),
      START - HORSE_RACE_LOCK_BEFORE_MS - 1,
    );
    expect(() =>
      first.racing.placeBet(
        alice.id,
        bet(race.id, "too-late", 50, ["1"]),
        START - HORSE_RACE_LOCK_BEFORE_MS,
      ),
    ).toThrow(/접수 시간/);
    expect(
      first.racing.snapshot(alice.id, START - HORSE_RACE_LOCK_BEFORE_MS, race.id).race?.status,
    ).toBe("locked");
    const lateReplay = first.racing.placeBet(alice.id, request, START);
    expect(lateReplay.receipt.id).toBe(firstTicket.receipt.id);
    expect(lateReplay.snapshot.race?.totalStake).toBe(500);
    expect(lateReplay.snapshot.race?.quotes).toEqual(race.quotes);
    expect(lateReplay.snapshot.gold).toBe(850);
  });

  it("refunds a solo participant exactly once and preserves their gold after reopening", async () => {
    const { databasePath, first, second, alice, race } = await setup();
    first.racing.placeBet(alice.id, bet(race.id, "solo-win", 450, ["1"]), OPEN);
    first.racing.placeBet(
      alice.id,
      bet(race.id, "solo-quinella", 200, ["1", "2"], "quinella"),
      OPEN,
    );
    const cancelled = second.racing.snapshot(alice.id, START - HORSE_RACE_LOCK_BEFORE_MS, race.id);
    expect(cancelled).toMatchObject({
      gold: 1200,
      race: {
        status: "cancelled",
        cancellationReason: "insufficient_participants",
        participants: 1,
      },
    });
    expect(cancelled.race?.myBets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: 450, payout: 450, refunded: true }),
        expect.objectContaining({ amount: 200, payout: 200, refunded: true }),
      ]),
    );
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    reopened.racing.advance(START + HORSE_RACE_DURATION_MS);
    expect((await reopened.loadBaseballProgress(alice.id)).gold).toBe(1200);
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM game_gold_transactions WHERE reason = 'horse_refund'",
          )
          .get(),
      ),
    ).toEqual({ count: 2 });
  });

  it("pins cancellation ownership, preserves quotes, and stops fresh cancellations at the exact close", async () => {
    const { first, second, alice, bob, race } = await setup();
    const ticket = first.racing.placeBet(
      alice.id,
      bet(race.id, "cancel-before-close", 350, ["1"]),
      OPEN,
    ).receipt;
    const late = first.racing.placeBet(
      alice.id,
      bet(race.id, "cancel-too-late", 150, ["2"]),
      OPEN,
    ).receipt;
    second.racing.placeBet(bob.id, bet(race.id, "bob-stays", 100, ["1"]), OPEN);
    expect(() => second.racing.cancelBet(bob.id, ticket.id, OPEN)).toThrow(/찾을 수 없습니다/);
    expect(second.racing.snapshot(bob.id, OPEN).gold).toBe(1100);
    const closesAt = START - HORSE_RACE_LOCK_BEFORE_MS;
    const cancelled = second.racing.cancelBet(alice.id, ticket.id, closesAt - 1);
    expect(cancelled.receipt).toEqual({
      ...ticket,
      payout: 350,
      refunded: true,
      cancelledAt: closesAt - 1,
    });
    expect(cancelled.snapshot.gold).toBe(1050);
    expect(cancelled.snapshot.race).toMatchObject({ totalStake: 250, participants: 2 });
    expect(() => first.racing.cancelBet(alice.id, late.id, closesAt)).toThrow(/마감/);
    expect(first.racing.cancelBet(alice.id, ticket.id, closesAt).receipt).toEqual(
      cancelled.receipt,
    );
    expect(first.racing.snapshot(alice.id, closesAt, race.id).race?.myBets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ticket.id,
          cancelledAt: closesAt - 1,
          quotedOdds: ticket.quotedOdds,
          potentialPayout: ticket.potentialPayout,
        }),
        expect.objectContaining({ id: late.id, cancelledAt: null, payout: null }),
      ]),
    );
  });

  it("refunds a cancellation once across reopening and excludes it from subsequent whole-race refunds", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const aliceTicket = first.racing.placeBet(
      alice.id,
      bet(race.id, "remaining-alice", 500, ["1"]),
      OPEN,
    ).receipt;
    const bobTicket = second.racing.placeBet(
      bob.id,
      bet(race.id, "departing-bob", 600, ["2"]),
      OPEN,
    ).receipt;
    const cancelled = first.racing.cancelBet(bob.id, bobTicket.id, OPEN + 1);
    expect(cancelled.snapshot).toMatchObject({
      gold: 1200,
      race: { participants: 1, totalStake: 500 },
    });
    expect(
      second.racing.placeBet(bob.id, bet(race.id, "departing-bob", 600, ["2"]), OPEN + 2).receipt,
    ).toEqual(cancelled.receipt);
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    const replay = reopened.racing.cancelBet(bob.id, bobTicket.id, START + HORSE_RACE_DURATION_MS);
    expect(replay.receipt).toEqual(cancelled.receipt);
    expect(replay.snapshot).toMatchObject({
      gold: 1200,
      race: {
        status: "cancelled",
        cancellationReason: "insufficient_participants",
        participants: 1,
      },
    });
    expect(
      reopened.racing.snapshot(alice.id, START + HORSE_RACE_DURATION_MS, race.id).race?.myBets,
    ).toEqual([
      expect.objectContaining({
        id: aliceTicket.id,
        refunded: true,
        payout: 500,
        cancelledAt: null,
      }),
    ]);
    expect((await reopened.loadBaseballProgress(alice.id)).gold).toBe(1200);
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT count(*) AS count FROM game_gold_transactions WHERE reason = 'horse_refund'",
          )
          .get(),
      ),
    ).toEqual({ count: 2 });
    expect(
      inspect(databasePath, (db) =>
        db.prepare("SELECT count(*) AS count FROM horse_bet_cancellations").get(),
      ),
    ).toEqual({ count: 1 });
  });

  it("bounds accepted-ticket history and never pays a cancelled winning quote during settlement", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const winner = finishOrder(databasePath, race.id)[0]!;
    const tickets = Array.from(
      { length: 20 },
      (_, index) =>
        first.racing.placeBet(alice.id, bet(race.id, `active-${index}`, 50, [winner]), OPEN)
          .receipt,
    );
    second.racing.placeBet(bob.id, bet(race.id, "bob-winner", 50, [winner]), OPEN);
    expect(() =>
      first.racing.placeBet(alice.id, bet(race.id, "replacement", 50, [winner]), OPEN),
    ).toThrow(/최대 20/);
    first.racing.cancelBet(alice.id, tickets[0]!.id, OPEN + 1);
    expect(() =>
      first.racing.placeBet(alice.id, bet(race.id, "replacement", 50, [winner]), OPEN + 2),
    ).toThrow(/취소한 베팅표도 포함/);
    const current = first.racing.snapshot(alice.id, OPEN + 2, race.id);
    expect(current.race).toMatchObject({ participants: 2, totalStake: 1000 });
    expect(current.race?.myBets).toHaveLength(20);
    const settled = second.racing.snapshot(alice.id, START + HORSE_RACE_DURATION_MS, race.id);
    expect(settled.race?.myBets.find((ticket) => ticket.id === tickets[0]!.id)).toEqual({
      ...tickets[0]!,
      payout: 50,
      refunded: true,
      cancelledAt: OPEN + 1,
    });
    expect(settled.gold).toBe(
      1200 - 950 + tickets.slice(1).reduce((sum, ticket) => sum + ticket.potentialPayout!, 0),
    );
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT count(*) AS count FROM game_gold_transactions WHERE reason = 'horse_payout' AND reference_id = ?",
          )
          .get(tickets[0]!.id),
      ),
    ).toEqual({ count: 0 });
  });

  it("rolls back cancellation state, ticket outcome and wallet together if its refund ledger fails", async () => {
    const { databasePath, first, alice, race } = await setup();
    const ticket = first.racing.placeBet(
      alice.id,
      bet(race.id, "atomic-cancel", 500, ["1"]),
      OPEN,
    ).receipt;
    inspect(databasePath, (db) =>
      db.exec(
        "CREATE TRIGGER reject_test_refund BEFORE INSERT ON game_gold_transactions WHEN NEW.reason = 'horse_refund' BEGIN SELECT RAISE(ABORT, 'refund ledger failed'); END",
      ),
    );
    expect(() => first.racing.cancelBet(alice.id, ticket.id, OPEN + 1)).toThrow(
      /refund ledger failed/,
    );
    expect(first.racing.snapshot(alice.id, OPEN + 1)).toMatchObject({
      gold: 700,
      race: {
        totalStake: 500,
        myBets: [{ id: ticket.id, payout: null, refunded: false, cancelledAt: null }],
      },
    });
    expect(
      inspect(databasePath, (db) =>
        db.prepare("SELECT count(*) AS count FROM horse_bet_cancellations").get(),
      ),
    ).toEqual({ count: 0 });
    inspect(databasePath, (db) => db.exec("DROP TRIGGER reject_test_refund"));
    expect(first.racing.cancelBet(alice.id, ticket.id, OPEN + 2).snapshot.gold).toBe(1200);
  });

  it("rolls back the ticket and debit together if its fixed payout cannot be recorded", async () => {
    const { databasePath, first, alice, race } = await setup();
    inspect(databasePath, (db) =>
      db.exec(
        "CREATE TRIGGER reject_test_quote BEFORE INSERT ON horse_bet_quotes BEGIN SELECT RAISE(ABORT, 'quote storage failed'); END",
      ),
    );
    expect(() =>
      first.racing.placeBet(alice.id, bet(race.id, "atomic-quote", 500, ["1"]), OPEN),
    ).toThrow(/quote storage failed/);
    expect(first.racing.snapshot(alice.id, OPEN).gold).toBe(1200);
    expect(first.racing.snapshot(alice.id, OPEN).race?.myBets).toEqual([]);
    expect(
      inspect(databasePath, (db) =>
        db.prepare("SELECT count(*) AS count FROM horse_bet_activity").get(),
      ),
    ).toEqual({ count: 0 });
    inspect(databasePath, (db) => db.exec("DROP TRIGGER reject_test_quote"));
    const retry = first.racing.placeBet(alice.id, bet(race.id, "atomic-quote", 500, ["1"]), OPEN);
    expect(retry.snapshot.gold).toBe(700);
    expect(retry.receipt.potentialPayout).toBeGreaterThan(500);
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare("SELECT created_at FROM horse_bet_activity WHERE bet_id = ?")
          .get(retry.receipt.id),
      ),
    ).toEqual({ created_at: OPEN });
  });

  it("pays accepted fixed quotes, loses winnerless tickets, and catches up after a restart only once", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    expect(race.revealedSeed).toBeNull();
    expect(race.finishOrder).toBeNull();
    expect(race.positions.every((position) => position.position === 0)).toBe(true);
    const order = finishOrder(databasePath, race.id);
    const winner = order[0]!;
    const loser = order[2]!;
    const losingPair = order.slice(2, 4);
    const aliceQuote = first.racing.placeBet(
      alice.id,
      bet(race.id, "alice-win", 50, [winner]),
      OPEN,
    ).receipt;
    const bobQuote = second.racing.placeBet(
      bob.id,
      bet(race.id, "bob-win", 100, [winner]),
      OPEN,
    ).receipt;
    first.racing.placeBet(alice.id, bet(race.id, "alice-lose", 100, [loser]), OPEN);
    first.racing.placeBet(alice.id, bet(race.id, "alice-pair", 50, losingPair, "quinella"), OPEN);
    second.racing.placeBet(
      bob.id,
      bet(race.id, "bob-pair", 50, losingPair.toReversed(), "quinella"),
      OPEN,
    );
    const running = first.racing.snapshot(alice.id, START + 1, race.id).race!;
    expect(running).toMatchObject({
      status: "racing",
      revealedSeed: null,
      finishOrder: null,
      commitment: race.commitment,
    });
    expect(
      first.racing
        .snapshot(alice.id, START + 1, race.id)
        .recentRaces.find((entry) => entry.id === race.id)?.winnerName,
    ).toBeNull();
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    const end = START + HORSE_RACE_DURATION_MS;
    const settledA = reopened.racing.snapshot(alice.id, end, race.id);
    const settledB = reopened.racing.snapshot(bob.id, end, race.id);
    expect(settledA.race?.status).toBe("settled");
    expect(settledA.race?.finishOrder).toEqual(order);
    expect(
      settledA.race!.horses.every(
        (horse) =>
          horse.condition !== null && horse.weight !== null && horse.winProbability !== null,
      ),
    ).toBe(true);
    expect(
      horseRaceCommitment(
        race.id,
        settledA.race!.horses as RacingHorse[],
        settledA.race!.revealedSeed!,
      ),
    ).toBe(race.commitment);
    const allTickets = [...settledA.race!.myBets, ...settledB.race!.myBets];
    expect(allTickets.reduce((sum, ticket) => sum + ticket.amount, 0)).toBe(350);
    const expectedPayout = aliceQuote.potentialPayout! + bobQuote.potentialPayout!;
    expect(allTickets.reduce((sum, ticket) => sum + (ticket.payout ?? 0), 0)).toBe(expectedPayout);
    expect(
      allTickets
        .filter((ticket) => ticket.market === "win")
        .map((ticket) => ticket.payout)
        .toSorted((a, b) => (a ?? -1) - (b ?? -1)),
    ).toEqual(
      [0, aliceQuote.potentialPayout, bobQuote.potentialPayout].toSorted(
        (a, b) => (a ?? -1) - (b ?? -1),
      ),
    );
    expect(
      allTickets
        .filter((ticket) => ticket.market === "quinella")
        .every((ticket) => !ticket.refunded && ticket.payout === 0),
    ).toBe(true);
    expect(settledA.gold + settledB.gold).toBe(2400 - 350 + expectedPayout);
    expect(settledA.race!.myBets.find((ticket) => ticket.id === aliceQuote.id)).toMatchObject({
      quotedOdds: aliceQuote.quotedOdds,
      potentialPayout: aliceQuote.potentialPayout,
      payout: aliceQuote.potentialPayout,
    });
    const before = inspect(databasePath, (db) =>
      db.prepare("SELECT COUNT(*) AS count FROM game_gold_transactions").get(),
    );
    const persisted = inspect(databasePath, (db) =>
      db.prepare("SELECT finish_order_json FROM horse_races WHERE id = ?").get(race.id),
    ) as { finish_order_json: string };
    expect(JSON.parse(persisted.finish_order_json)).toEqual(settledA.race?.finishOrder);
    reopened.racing.advance(end + 10_000);
    expect(reopened.racing.snapshot(alice.id, end + 10_000, race.id).gold).toBe(settledA.gold);
    expect(
      inspect(databasePath, (db) =>
        db.prepare("SELECT COUNT(*) AS count FROM game_gold_transactions").get(),
      ),
    ).toEqual(before);
    const mirror = createStore(databasePath);
    mirror.racing.advance(end + 20_000);
    expect((await mirror.loadBaseballProgress(bob.id)).gold).toBe(settledB.gold);
  });

  it.each(["algorithm_version", "pricing_version", "animation_version"] as const)(
    "refunds unfinished races if a deployment changes committed %s",
    async (versionColumn) => {
      const { databasePath, first, second, alice, bob, race } = await setup();
      first.racing.placeBet(alice.id, bet(race.id, "version-a", 350, ["1"]), OPEN);
      second.racing.placeBet(bob.id, bet(race.id, "version-b", 450, ["2"]), OPEN);
      first.racing.advance(START);
      inspect(databasePath, (db) =>
        db
          .prepare(`UPDATE horse_races SET ${versionColumn} = ? WHERE id = ?`)
          .run(
            versionColumn === "pricing_version"
              ? "probability-fair-v1"
              : versionColumn === "animation_version"
                ? "seeded-pace-v1"
                : "future-algorithm",
            race.id,
          ),
      );
      closeStore(first);
      closeStore(second);
      const reopened = createStore(databasePath);
      const snapshot = reopened.racing.snapshot(alice.id, START + 1, race.id);
      expect(snapshot.race).toMatchObject({
        status: "cancelled",
        cancellationReason: "engine_changed",
      });
      expect(snapshot.gold).toBe(1200);
      reopened.racing.advance(START + HORSE_RACE_DURATION_MS);
      expect((await reopened.loadBaseballProgress(bob.id)).gold).toBe(1200);
      expect(
        inspect(databasePath, (db) =>
          db
            .prepare(
              "SELECT count(*) AS count FROM game_gold_transactions WHERE reason = 'horse_refund'",
            )
            .get(),
        ),
      ).toEqual({ count: 2 });
    },
  );

  it("pays each winning quinella at its fixed quote independently of win tickets", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const order = finishOrder(databasePath, race.id);
    const pair = order.slice(0, 2);
    const aliceQuote = first.racing.placeBet(
      alice.id,
      bet(race.id, "pair-a", 150, pair.toReversed(), "quinella"),
      OPEN,
    ).receipt;
    const bobQuote = second.racing.placeBet(
      bob.id,
      bet(race.id, "pair-b", 100, pair, "quinella"),
      OPEN,
    ).receipt;
    expect(aliceQuote.quotedOdds).toBe(bobQuote.quotedOdds);
    second.racing.placeBet(
      bob.id,
      bet(race.id, "pair-loser", 200, order.slice(2, 4), "quinella"),
      OPEN,
    );
    first.racing.placeBet(alice.id, bet(race.id, "win-no-winner", 50, [order[2]!]), OPEN);
    const end = START + HORSE_RACE_DURATION_MS;
    const snapshotA = first.racing.snapshot(alice.id, end, race.id);
    const snapshotB = second.racing.snapshot(bob.id, end, race.id);
    const tickets = [...snapshotA.race!.myBets, ...snapshotB.race!.myBets];
    expect(
      tickets
        .filter((ticket) => ticket.market === "quinella")
        .map((ticket) => ticket.payout)
        .toSorted((a, b) => (a ?? -1) - (b ?? -1)),
    ).toEqual(
      [0, aliceQuote.potentialPayout, bobQuote.potentialPayout].toSorted(
        (a, b) => (a ?? -1) - (b ?? -1),
      ),
    );
    expect(tickets.find((ticket) => ticket.market === "win")).toMatchObject({
      payout: 0,
      refunded: false,
    });
    expect(snapshotA.gold + snapshotB.gold).toBe(
      2400 - 500 + aliceQuote.potentialPayout! + bobQuote.potentialPayout!,
    );
  });

  it("consumes issued baseball swings once, ignores fabricated outcomes, and binds rewards to the issued bat", async () => {
    const { databasePath, first, second, alice, bob } = await setup(20);
    const miss = await first.beginBaseballAtBat({
      userId: alice.id,
      requestId: "issued-miss",
      now: OPEN,
    });
    const spoof = await second.rewardBaseballPlateAppearance({
      userId: alice.id,
      requestId: "spoof-miss",
      atBatId: miss.id,
      timingDeltaMs: 101,
      now: OPEN + 1_000,
      outcome: "home_run",
      distanceM: 999,
    });
    expect(spoof).toMatchObject({
      awardedGold: 0,
      progress: { gold: 60, totalHomers: 0, bestDistanceM: 80 },
    });
    const pitch = await first.beginBaseballAtBat({
      userId: alice.id,
      requestId: "issued-perfect",
      now: OPEN + 2_000,
    });
    expect(pitch.batId).toBe("wood");
    // Synthetic pre-upgrade loadout remains refund evidence; active enhancement changes after issuance.
    inspect(databasePath, (db) => {
      db.prepare("INSERT INTO baseball_owned_bats (user_id,bat_id) VALUES (?,?)").run(
        alice.id,
        "silver",
      );
      db.prepare(
        "UPDATE baseball_game_progress SET equipped_bat_id = 'silver' WHERE user_id = ?",
      ).run(alice.id);
      db.prepare("UPDATE baseball_bat_enhancements SET level = 20 WHERE user_id = ?").run(alice.id);
    });
    expect(pitch).toMatchObject({ enhancementLevel: 0, powerRuleVersion: "sweetspot-v1" });
    await expect(
      first.rewardBaseballPlateAppearance({
        userId: bob.id,
        requestId: "wrong-user",
        atBatId: pitch.id,
        timingDeltaMs: 0,
        now: OPEN + 3_000,
      }),
    ).rejects.toMatchObject({ code: "at_bat_unavailable" });
    const request = {
      userId: alice.id,
      requestId: "perfect-hit",
      atBatId: pitch.id,
      timingDeltaMs: 0,
      now: OPEN + 3_000,
    };
    const reward = await first.rewardBaseballPlateAppearance({
      ...request,
      outcome: "miss",
      distanceM: 999,
    });
    expect(reward).toMatchObject({
      awardedGold: 5,
      progress: {
        gold: 65,
        totalHomers: 1,
        equippedBatId: "silver",
        enhancement: { level: 20, equipped: true },
      },
    });
    expect(reward.progress.bestDistanceM).toBeGreaterThan(100);
    expect(reward.progress.bestDistanceM).toBeLessThan(150);
    expect(
      await second.rewardBaseballPlateAppearance({ ...request, outcome: "home_run", distanceM: 1 }),
    ).toEqual(reward);
    await expect(
      second.rewardBaseballPlateAppearance({ ...request, requestId: "consume-again" }),
    ).rejects.toMatchObject({ code: "at_bat_consumed" });
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    expect(await reopened.rewardBaseballPlateAppearance(request)).toEqual(reward);
    expect((await reopened.loadBaseballProgress(alice.id)).gold).toBe(65);
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM game_gold_transactions WHERE reason = 'baseball_reward' AND reference_id = 'perfect-hit'",
          )
          .get(),
      ),
    ).toEqual({ count: 1 });
  });
});
