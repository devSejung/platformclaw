import type { HorseRacingSnapshot } from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";

export type RacingWinReaction = { payout: number; profit: number };

/** A mounted account must have observed this live race before its settlement to react. */
export class HorseRacingCelebration {
  private watchedRace: string | null = null;
  private readonly seen = new Set<string>();

  reset(): void {
    this.watchedRace = null;
    this.seen.clear();
  }

  observe(snapshot: HorseRacingSnapshot, historical: boolean): RacingWinReaction | null {
    const race = snapshot.race;
    if (historical || !race) {
      this.watchedRace = null;
      return null;
    }
    if (race.status !== "settled" && race.status !== "cancelled") {
      this.watchedRace = race.id;
      return null;
    }
    const watched = this.watchedRace === race.id;
    this.watchedRace = null;
    if (!watched || race.status !== "settled" || this.seen.has(race.id)) {
      return null;
    }
    this.seen.add(race.id);
    if (this.seen.size > 64) {
      this.seen.delete(this.seen.values().next().value!);
    }
    const active = race.myBets.filter((bet) => !bet.refunded && bet.cancelledAt === null);
    const payout = active.reduce((sum, bet) => sum + (bet.payout ?? 0), 0);
    if (payout === 0) {
      return null;
    }
    return { payout, profit: payout - active.reduce((sum, bet) => sum + bet.amount, 0) };
  }
}
