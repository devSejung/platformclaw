import type { ReactiveController, ReactiveControllerHost } from "lit";

export const BASEBALL_CELEBRATION_MS = 900;

/** One small celebration per confirmed receipt, independent of gameplay timing. */
export class BaseballCelebration implements ReactiveController {
  visible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly seen = new Set<string>();

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  confirm(requestId: string, bonusGold: number | undefined, canDisplay: boolean): void {
    if (bonusGold !== 5 || this.seen.has(requestId)) {
      return;
    }
    this.seen.add(requestId);
    if (!canDisplay) {
      return;
    }
    this.hide();
    this.visible = true;
    this.host.requestUpdate();
    this.timer = setTimeout(() => this.hide(), BASEBALL_CELEBRATION_MS);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.visible) {
      this.visible = false;
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
