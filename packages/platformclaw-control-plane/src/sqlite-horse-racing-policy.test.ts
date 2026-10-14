import { describe, expect, it } from "vitest";
import type { RacingHorse } from "./horse-racing-contracts.js";
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

  it("opens the next hourly race ten seconds after the preceding three-minute race ends", async () => {
    const { first, second, alice, bob, race } = await setup();
    first.racing.placeBet(alice.id, bet(race.id, "open-a", 50, ["1"]), OPEN);
    second.racing.placeBet(bob.id, bet(race.id, "open-b", 50, ["2"]), OPEN);
    const nextStartsAt = START + 3_600_000;
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
