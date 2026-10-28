export class SkillsChangedRefreshQueue {
  private pending = false;
  private running: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly canRefresh: () => boolean,
    private readonly refresh: () => Promise<void>,
  ) {}

  invalidate(active: boolean): void {
    if (!active) {
      return;
    }
    this.pending = true;
    this.drain();
  }

  drain(): void {
    if (!this.pending || this.running || !this.canRefresh()) {
      return;
    }
    this.pending = false;
    const generation = this.generation;
    const running = this.refresh().finally(() => {
      if (this.generation !== generation || this.running !== running) {
        return;
      }
      this.running = null;
      this.drain();
    });
    this.running = running;
  }

  reset(): void {
    this.generation += 1;
    this.pending = false;
    this.running = null;
  }
}
