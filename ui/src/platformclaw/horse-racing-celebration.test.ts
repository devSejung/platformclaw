import { describe, expect, it } from "vitest";
import { HorseRacingCelebration } from "./horse-racing-celebration.ts";
import { snapshot } from "./horse-racing.test-fixtures.ts";

describe("account-owned live settlement reaction", () => {
  const race = snapshot().race!;
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
  it("suppresses reloads, history, spectators, losing tickets, refunds and cancelled tickets", () => {
    const settled = snapshot({ race: { ...race, status: "settled", myBets: [receipt] } });
    expect(new HorseRacingCelebration().observe(settled, false)).toBeNull();
    const history = new HorseRacingCelebration();
    history.observe(snapshot(), false);
    expect(history.observe(settled, true)).toBeNull();
    for (const bets of [
      [],
      [{ ...receipt, payout: 0 }],
      [{ ...receipt, refunded: true }],
      [{ ...receipt, cancelledAt: 1 }],
    ]) {
      const tracker = new HorseRacingCelebration();
      tracker.observe(snapshot(), false);
      expect(
        tracker.observe(snapshot({ race: { ...race, status: "settled", myBets: bets } }), false),
      ).toBeNull();
    }
  });
  it("counts active ticket costs, excludes refunds, and cannot react twice to the same race", () => {
    const tracker = new HorseRacingCelebration();
    tracker.observe(snapshot(), false);
    const settled = snapshot({
      race: {
        ...race,
        status: "settled",
        myBets: [
          receipt,
          { ...receipt, id: "lose", payout: 0 },
          { ...receipt, id: "refund", refunded: true, payout: 50 },
        ],
      },
    });
    expect(tracker.observe(settled, false)).toEqual({ payout: 151, profit: 51 });
    tracker.observe(snapshot(), false);
    expect(tracker.observe(settled, false)).toBeNull();
    tracker.reset();
    expect(tracker.observe(settled, false)).toBeNull();
  });
});
