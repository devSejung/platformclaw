import { describe, expect, it } from "vitest";
import {
  HORSE_RACING_ANIMATION_VERSION,
  type RacingHorse,
  type HorseRacePosition,
} from "./horse-racing-contracts.js";
import { HORSE_RACE_DURATION_MS } from "./horse-racing-engine.js";
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
describe("SQLite horse racing betting policy", () => {
  it("replays a real four-second stumble across restart and still pays the accepted finish order", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const order = finishOrder(databasePath, race.id);
    const receipt = first.racing.placeBet(
      alice.id,
      bet(race.id, "stumble-winner", 50, [order[0]!]),
      OPEN,
    ).receipt;
    second.racing.placeBet(bob.id, bet(race.id, "stumble-second", 50, [order[1]!]), OPEN);
    expect(
      first.racing
        .snapshot(alice.id, START + 19_999, race.id)
        .race!.positions.every((entry) => !("motion" in entry)),
    ).toBe(true);
    let observed: { elapsed: number; position: HorseRacePosition } | undefined;
    for (let elapsed = 20_000; elapsed <= 113_000; elapsed += 1_000) {
      const position = first.racing
        .snapshot(alice.id, START + elapsed, race.id)
        .race!.positions.find((entry) => entry.motion === "fallen");
      if (position) {
        observed = { elapsed, position };
        break;
      }
    }
    if (!observed) {
      throw new Error("The live snapshot never reported its committed stumble");
    }
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    const fall = observed;
    const positionAt = (elapsed: number) =>
      reopened.racing
        .snapshot(alice.id, START + fall.elapsed + elapsed, race.id)
        .race!.positions.find((entry) => entry.horseId === fall.position.horseId)!;
    expect(positionAt(1_000)).toEqual(observed.position);
    expect(positionAt(3_000)).toEqual({ ...observed.position, motion: "recovering" });
    expect(positionAt(5_000).motion).toBeUndefined();
    expect(positionAt(5_000).position).toBeGreaterThan(observed.position.position);
    const settled = reopened.racing.snapshot(alice.id, START + HORSE_RACE_DURATION_MS, race.id);
    expect(settled.race!.finishOrder).toEqual(order);
    expect(settled.race!.myBets[0]).toMatchObject({
      potentialPayout: receipt.potentialPayout,
      payout: receipt.potentialPayout,
    });
    expect(
      settled.race!.positions.every((entry) => entry.position === 100 && !("motion" in entry)),
    ).toBe(true);
    expect(settled.gold).toBe(1200 - 50 + receipt.potentialPayout!);
    closeStore(reopened);
    inspect(databasePath, (db) =>
      db
        .prepare("UPDATE horse_races SET animation_version = 'seeded-pace-v1' WHERE id = ?")
        .run(race.id),
    );
    const history = createStore(databasePath).racing.snapshot(
      alice.id,
      START + HORSE_RACE_DURATION_MS + 1,
      race.id,
    );
    expect(history.race!.animationVersion).toBe("seeded-pace-v1");
    expect(history.race!.positions).toEqual(settled.race!.positions);
    expect(history.race!.finishOrder).toEqual(order);
    expect(history.race!.myBets).toEqual(settled.race!.myBets);
    expect(history.gold).toBe(settled.gold);
  });

  it("refreshes untouched future presentation versions while refunding accepted old-animation tickets once", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    first.racing.placeBet(alice.id, bet(race.id, "old-animation-a", 50, ["1"]), OPEN);
    second.racing.placeBet(bob.id, bet(race.id, "old-animation-b", 50, ["2"]), OPEN);
    const futureStart = START + 30 * 60_000;
    const futureId = `race-${futureStart}`;
    const unknownId = `race-${START + 60 * 60_000}`;
    const committed = inspect(databasePath, (db) => {
      db.prepare(
        "UPDATE horse_races SET animation_version = 'seeded-pace-v1' WHERE status IN ('scheduled','betting')",
      ).run();
      db.prepare(
        "UPDATE horse_races SET animation_version = 'unknown-future-animation' WHERE id = ?",
      ).run(unknownId);
      return db
        .prepare("SELECT seed, horses_json, commitment FROM horse_races WHERE id = ?")
        .get(futureId);
    });
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    expect(reopened.racing.snapshot(alice.id, OPEN, race.id)).toMatchObject({
      gold: 1200,
      race: {
        status: "cancelled",
        cancellationReason: "engine_changed",
        animationVersion: "seeded-pace-v1",
      },
    });
    expect(reopened.racing.snapshot(alice.id, OPEN, futureId).race).toMatchObject({
      status: "scheduled",
      animationVersion: HORSE_RACING_ANIMATION_VERSION,
    });
    expect(reopened.racing.snapshot(alice.id, OPEN, unknownId).race).toMatchObject({
      status: "scheduled",
      animationVersion: "unknown-future-animation",
    });
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare("SELECT seed, horses_json, commitment FROM horse_races WHERE id = ?")
          .get(futureId),
      ),
    ).toEqual(committed);
    const futureOpensAt = START + HORSE_RACE_DURATION_MS + 10_000;
    expect(reopened.racing.snapshot(alice.id, futureOpensAt).race).toMatchObject({
      id: futureId,
      status: "betting",
      animationVersion: HORSE_RACING_ANIMATION_VERSION,
    });
    reopened.racing.placeBet(alice.id, bet(futureId, "new-animation-a", 50, ["1"]), futureOpensAt);
    reopened.racing.placeBet(bob.id, bet(futureId, "new-animation-b", 50, ["2"]), futureOpensAt);
    expect(reopened.racing.snapshot(alice.id, futureStart).race!.status).toBe("racing");
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT count(*) AS count FROM game_gold_transactions WHERE reason = 'horse_refund'",
          )
          .get(),
      ),
    ).toEqual({ count: 2 });
  });

  it("enforces 50–1,000G before debit and quotes the net three-percent payout", async () => {
    const { first, alice, race } = await setup();
    for (const amount of [0, 49, 1_001, 50.5, Number.NaN]) {
      expect(() =>
        first.racing.placeBet(alice.id, bet(race.id, `invalid-${amount}`, amount, ["1"]), OPEN),
      ).toThrow(/50~1,000G/);
    }
    expect(first.racing.snapshot(alice.id, OPEN).gold).toBe(1200);
    const minimum = first.racing.placeBet(alice.id, bet(race.id, "minimum", 50, ["1"]), OPEN);
    expect(minimum.receipt).toMatchObject({ quotedOdds: 3.03125, potentialPayout: 151 });
    const maximum = first.racing.placeBet(alice.id, bet(race.id, "maximum", 1000, ["1"]), OPEN);
    expect(maximum.receipt.potentialPayout).toBe(3031);
    expect(maximum.snapshot.gold).toBe(150);
    expect(race.quotes).toHaveLength(36);
    expect(race.pricingVersion).toBe("probability-net-3pct-v2");
  });

  it("opens the next half-hour race ten seconds after the preceding three-minute race ends", async () => {
    const { first, second, alice, bob, race } = await setup();
    first.racing.placeBet(alice.id, bet(race.id, "open-a", 50, ["1"]), OPEN);
    second.racing.placeBet(bob.id, bet(race.id, "open-b", 50, ["2"]), OPEN);
    const nextStartsAt = START + 30 * 60_000;
    const nextId = `race-${nextStartsAt}`;
    const nextOpensAt = START + HORSE_RACE_DURATION_MS + 10_000;
    expect(first.racing.snapshot(alice.id, nextOpensAt - 1).race?.id).toBe(race.id);
    expect(() =>
      first.racing.placeBet(alice.id, bet(nextId, "not-yet", 50, ["1"]), nextOpensAt - 1),
    ).toThrow(/접수 시간/);
    const opened = first.racing.snapshot(alice.id, nextOpensAt).race!;
    expect(opened).toMatchObject({
      id: nextId,
      status: "betting",
      opensAt: nextOpensAt,
      closesAt: nextStartsAt - 60_000,
    });
    first.racing.placeBet(alice.id, bet(nextId, "next-open", 50, ["1"]), nextOpensAt);
    second.racing.placeBet(bob.id, bet(nextId, "next-second", 50, ["2"]), nextOpensAt);
    expect(first.racing.snapshot(alice.id, nextStartsAt - 60_000).race?.status).toBe("locked");
  });

  it("fills the expanded timetable on restart without replacing accepted whole-hour draws or payouts", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const winner = finishOrder(databasePath, race.id)[0]!;
    const receipt = first.racing.placeBet(
      alice.id,
      bet(race.id, "persisted-hour", 50, [winner]),
      OPEN,
    ).receipt;
    second.racing.placeBet(bob.id, bet(race.id, "persisted-second", 50, [winner]), OPEN);
    inspect(databasePath, (db) => {
      // Recreate the former 11:00–17:00 hourly inventory while retaining its accepted tickets.
      db.prepare(
        "DELETE FROM horse_races WHERE starts_at < ? OR starts_at > ? OR (starts_at - ?) % 3600000 != 0",
      ).run(START, START + 6 * 3_600_000, START);
    });
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    const restored = reopened.racing.snapshot(alice.id, START);
    expect(restored.race).toMatchObject({
      id: race.id,
      status: "racing",
      commitment: race.commitment,
    });
    expect(restored.race!.myBets).toEqual([receipt]);
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT count(*) AS count, min(starts_at) AS first, max(starts_at) AS last FROM horse_races",
          )
          .get(),
      ),
    ).toEqual({
      count: 23,
      first: START - 2 * 3_600_000,
      last: START + 9 * 3_600_000,
    });
    const end = START + HORSE_RACE_DURATION_MS;
    const settled = reopened.racing.snapshot(alice.id, end, race.id);
    expect(settled.race!.myBets[0]).toMatchObject({
      potentialPayout: receipt.potentialPayout,
      payout: receipt.potentialPayout,
    });
    expect(settled.gold).toBe(1200 - 50 + receipt.potentialPayout!);
    reopened.racing.advance(end + 10_000);
    expect(reopened.racing.snapshot(alice.id, end + 10_000, race.id).gold).toBe(settled.gold);
    expect(reopened.racing.snapshot(alice.id, START + 6 * 3_600_000).recentRaces).toHaveLength(7);
  });

  it("keeps an accepted ticket cancellable when the expanded schedule moves its opening later", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const receipt = first.racing.placeBet(
      alice.id,
      bet(race.id, "before-schedule-update", 50, ["1"]),
      OPEN,
    ).receipt;
    const futureStart = START + 3_600_000;
    const futureId = `race-${futureStart}`;
    inspect(databasePath, (db) => {
      // The prior timetable had already opened 12:00 at 11:03:10; the new one opens it at 11:33:10.
      db.prepare("UPDATE horse_bets SET race_id = ? WHERE id = ?").run(futureId, receipt.id);
      db.prepare("UPDATE horse_races SET status = 'betting' WHERE id = ?").run(futureId);
    });
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    const now = START + 5 * 60_000;
    const current = reopened.racing.snapshot(alice.id, now);
    expect(current.race?.id).toBe(`race-${START + 30 * 60_000}`);
    expect(current.recentRaces).toHaveLength(6);
    expect(current.recentRaces.some((entry) => entry.id === futureId)).toBe(true);
    expect(
      reopened.racing.snapshot(bob.id, now).recentRaces.some((entry) => entry.id === futureId),
    ).toBe(false);
    const upcoming = reopened.racing.snapshot(alice.id, now, futureId);
    expect(upcoming.race!.myBets).toEqual([{ ...receipt, raceId: futureId }]);
    expect(reopened.racing.snapshot(bob.id, now, futureId).race!.myBets).toEqual([]);
    expect(() =>
      reopened.racing.placeBet(alice.id, bet(futureId, "not-yet-open", 50, ["1"]), now),
    ).toThrow(/접수 시간/);
    const cancelled = reopened.racing.cancelBet(alice.id, receipt.id, now);
    expect(cancelled.receipt).toMatchObject({
      raceId: futureId,
      amount: 50,
      payout: 50,
      quotedOdds: receipt.quotedOdds,
      potentialPayout: receipt.potentialPayout,
      refunded: true,
      cancelledAt: now,
    });
    expect(cancelled.snapshot.gold).toBe(1200);
    expect(
      reopened.racing.snapshot(alice.id, now).recentRaces.some((entry) => entry.id === futureId),
    ).toBe(false);
    expect(reopened.racing.cancelBet(alice.id, receipt.id, futureStart).snapshot.gold).toBe(1200);
    expect(
      inspect(databasePath, (db) =>
        db
          .prepare(
            "SELECT count(*) AS count FROM game_gold_transactions WHERE reason = 'horse_refund' AND reference_id = ?",
          )
          .get(receipt.id),
      ),
    ).toEqual({ count: 1 });
  });

  it("settles all three unordered top-three pairs and preserves accepted pre-fee quotes across restart", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const order = finishOrder(databasePath, race.id);
    const pairs = [
      [order[0]!, order[1]!],
      [order[0]!, order[2]!],
      [order[1]!, order[2]!],
    ];
    const accepted = pairs.map(
      (selection, index) =>
        first.racing.placeBet(
          alice.id,
          bet(race.id, `top-three-${index}`, 50, selection.toReversed(), "quinella-place"),
          OPEN,
        ).receipt,
    );
    const loser = second.racing.placeBet(
      bob.id,
      bet(race.id, "outside-top-three", 50, [order[1]!, order[3]!], "quinella-place"),
      OPEN,
    ).receipt;
    const previousQuote = first.racing.placeBet(
      alice.id,
      bet(race.id, "accepted-before-fee", 50, [order[0]!]),
      OPEN,
    ).receipt;
    // Recreate an accepted one-G gross ticket from the earlier preview, including its atomic wallet debit.
    const previousOdds = (previousQuote.quotedOdds! * 100) / 97;
    const previousPayout = Math.floor(previousOdds);
    inspect(databasePath, (db) => {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE horse_bets SET amount = 1 WHERE id = ?").run(previousQuote.id);
      db.prepare("UPDATE baseball_game_progress SET gold = gold + 49 WHERE user_id = ?").run(
        alice.id,
      );
      db.prepare(
        "UPDATE game_gold_transactions SET delta = -1, balance_after = balance_after + 49 WHERE reason = 'horse_bet' AND reference_id = ?",
      ).run(previousQuote.id);
      db.prepare("UPDATE horse_bet_quotes SET odds = ?, potential_payout = ? WHERE bet_id = ?").run(
        previousOdds,
        previousPayout,
        previousQuote.id,
      );
      db.exec("COMMIT");
    });
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    const replay = reopened.racing.placeBet(
      alice.id,
      bet(race.id, "accepted-before-fee", 1, [order[0]!]),
      START,
    );
    expect(replay.receipt).toMatchObject({
      quotedOdds: previousOdds,
      potentialPayout: previousPayout,
    });
    const end = START + HORSE_RACE_DURATION_MS;
    const settled = reopened.racing.snapshot(alice.id, end, race.id);
    for (const receipt of accepted) {
      expect(settled.race!.myBets.find((ticket) => ticket.id === receipt.id)).toMatchObject({
        payout: receipt.potentialPayout,
        refunded: false,
      });
    }
    expect(settled.race!.myBets.find((ticket) => ticket.id === previousQuote.id)?.payout).toBe(
      previousPayout,
    );
    expect(reopened.racing.snapshot(bob.id, end, race.id).race!.myBets).toEqual([
      expect.objectContaining({ id: loser.id, payout: 0, refunded: false }),
    ]);
    expect(settled.gold).toBe(
      1200 -
        151 +
        previousPayout +
        accepted.reduce((sum, ticket) => sum + ticket.potentialPayout!, 0),
    );
    expect(reopened.racing.snapshot(alice.id, end + 1, race.id).gold).toBe(settled.gold);
  });

  it("keeps settled pre-quote records and their actual payouts when the additive tables are first ensured", async () => {
    const { databasePath, first, second, alice, bob, race } = await setup();
    const legacyStart = START - 24 * 3_600_000;
    const legacyId = `race-${legacyStart}`;
    inspect(databasePath, (db) => {
      const privateRoster = JSON.parse(
        (
          db.prepare("SELECT horses_json FROM horse_races WHERE id = ?").get(race.id) as {
            horses_json: string;
          }
        ).horses_json,
      ) as RacingHorse[];
      const oldRoster = privateRoster.map(({ rumor: _rumor, ...horse }) => horse);
      db.prepare(
        "INSERT INTO horse_races (id, starts_at, status, horses_json, seed, commitment, algorithm_version, pricing_version, animation_version, finish_order_json, cancellation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run(
        legacyId,
        legacyStart,
        "settled",
        JSON.stringify(oldRoster),
        "legacy-seed",
        "legacy-commitment",
        "sha256-weighted-order-v1",
        "pool-v1",
        "seeded-pace-v1",
        JSON.stringify(["1", "2", "3", "4", "5", "6"]),
      );
      const insert = db.prepare(
        "INSERT INTO horse_bets (id, user_id, request_id, race_id, market, selection, amount, payout, refunded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      );
      insert.run("legacy-alice", alice.id, "legacy-a", legacyId, "win", "1", 11, 21);
      insert.run("legacy-bob", bob.id, "legacy-b", legacyId, "win", "2", 10, 0);
      db.exec(
        "DROP TABLE horse_bet_activity; DROP TABLE horse_bet_cancellations; DROP TABLE horse_bet_quotes;",
      );
    });
    closeStore(first);
    closeStore(second);
    const reopened = createStore(databasePath);
    const history = reopened.racing.snapshot(alice.id, OPEN, legacyId);
    expect(history.gold).toBe(1200);
    expect(history.race).toMatchObject({
      status: "settled",
      pricingVersion: "pool-v1",
      quotes: [],
      finishOrder: ["1", "2", "3", "4", "5", "6"],
    });
    expect(history.race!.myBets).toEqual([
      expect.objectContaining({
        id: "legacy-alice",
        payout: 21,
        quotedOdds: null,
        potentialPayout: null,
        cancelledAt: null,
      }),
    ]);
    expect(history.race!.liveBets).toEqual([]);
    const recentHistory = reopened.racing.snapshot(alice.id, legacyStart + 60_001, legacyId).race!;
    expect(recentHistory.endsAt).toBe(legacyStart + 60_000);
    expect(recentHistory.positions).toEqual(
      ["1", "2", "3", "4", "5", "6"].map((horseId, index) => ({
        horseId,
        position: 100,
        finishPlace: index + 1,
      })),
    );
    expect(
      reopened.racing.snapshot(alice.id, START + HORSE_RACE_DURATION_MS, legacyId).race!.myBets[0]!
        .payout,
    ).toBe(21);
    expect((await reopened.loadBaseballProgress(bob.id)).gold).toBe(1200);
  });
});
