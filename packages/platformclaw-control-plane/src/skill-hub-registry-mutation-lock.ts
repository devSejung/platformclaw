export class SkillHubRegistryMutationLock {
  private readonly tails = new Map<string, Promise<void>>();

  async runMany<T>(
    coordinates: Array<{ namespace: string; slug: string }>,
    task: () => Promise<T>,
  ): Promise<T> {
    // Moves reserve both coordinates in one order so opposing moves cannot deadlock
    // or race a publication at the destination.
    const keys = [
      ...new Set(coordinates.map(({ namespace, slug }) => `${namespace}\0${slug}`)),
    ].toSorted();
    const acquire = async (index: number): Promise<T> => {
      const key = keys[index];
      if (key === undefined) {
        return await task();
      }
      const [namespace, slug] = key.split("\0");
      return await this.run(namespace!, slug!, () => acquire(index + 1));
    };
    return await acquire(0);
  }

  async run<T>(namespace: string, slug: string, task: () => Promise<T>): Promise<T> {
    const key = `${namespace}\0${slug}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
