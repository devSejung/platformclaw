import type { ReactiveController, ReactiveControllerHost } from "lit";

export const BASEBALL_CELEBRATION_MS = 900;
export type BaseballBonus = { total: number; streak: number };

/** One small celebration per confirmed receipt, independent of gameplay timing. */
export class BaseballCelebration implements ReactiveController {
  bonus: BaseballBonus | null = null;
  get visible(): boolean {
    return this.bonus !== null;
  }
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly seen = new Set<string>();

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  confirm(
    requestId: string,
    totalGold: number | undefined,
    streakGold: number | undefined,
    canDisplay: boolean,
  ): void {
    if (!((totalGold ?? 0) > 0 || (streakGold ?? 0) > 0) || this.seen.has(requestId)) {
      return;
    }
    this.seen.add(requestId);
    if (!canDisplay) {
      return;
    }
    this.hide();
    this.bonus = { total: totalGold ?? 0, streak: streakGold ?? 0 };
    this.host.requestUpdate();
    this.timer = setTimeout(() => this.hide(), BASEBALL_CELEBRATION_MS);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.visible) {
      this.bonus = null;
      this.host.requestUpdate();
    }
  }

  reset(): void {
    this.hide();
    this.seen.clear();
  }

  hostDisconnected(): void {
    this.reset();
  }
}
