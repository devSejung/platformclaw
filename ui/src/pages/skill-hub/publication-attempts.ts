type PublicationAttempt<Draft> = {
  operationId: string;
  intent: string;
  draft: Draft;
  file?: File;
  generation: number;
  unconfirmed: boolean;
};

/** Page-lifetime draft recovery only; the server owns publication state. */
export class SkillHubPublicationAttempts<Draft> {
  private readonly attempts = new Map<string, PublicationAttempt<Draft>>();
  private generation = 0;

  get items(): PublicationAttempt<Draft>[] {
    return [...this.attempts.values()];
  }

  begin(operationId: string, intent: string, draft: Draft, file?: File): PublicationAttempt<Draft> {
    // File metadata cannot establish byte identity. Keep the original File reference.
    return (
      this.items.find((attempt) => attempt.intent === intent && attempt.file === file) ?? {
        operationId,
        intent,
        draft,
        file,
        generation: this.generation,
        unconfirmed: false,
      }
    );
  }

  remember(attempt: PublicationAttempt<Draft>, unconfirmed = false): void {
    if (attempt.generation === this.generation) {
      this.attempts.set(attempt.operationId, {
        ...attempt,
        unconfirmed: attempt.unconfirmed || unconfirmed,
      });
    }
  }

  hasUnconfirmedFileConflict(intent: string, file: File): boolean {
    return this.items.some(
      (attempt) => attempt.unconfirmed && attempt.intent === intent && attempt.file !== file,
    );
  }

  forget(operationId: string): void {
    this.attempts.delete(operationId);
  }

  clear(): void {
    this.generation += 1;
    this.attempts.clear();
  }
}
