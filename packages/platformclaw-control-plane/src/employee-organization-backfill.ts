import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type {
  EmployeeDirectoryBackfillOutcome,
  EmployeeDirectoryUser,
} from "./employee-directory.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

const PAGE_SIZE = 100;
const CONCURRENCY = 4;
const MAX_PREPARED_TASKS = 64;

export type EmployeeOrganizationBackfillSummary = {
  found: number;
  synced: number;
  skipped: number;
  failed: number;
  limited: boolean;
};

type BackfillStore = Pick<
  SqliteControlPlaneStore,
  | "listDirectoryOrganizationBackfillUsers"
  | "getEmployeeDirectorySnapshot"
  | "syncDirectoryOrganization"
  | "getEmployeeDirectoryAuthDecision"
  | "getEmployeeDirectoryBackfillAttempt"
  | "recordEmployeeDirectoryBackfillAttempt"
>;

type Options = { store: BackfillStore; signal?: AbortSignal; now?: () => number };

/** Replays recorded authentication facts; never discovers organization from another service. */
export class EmployeeOrganizationBackfill {
  private readonly generation = randomUUID();
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly tasks = new Map<string, Promise<EmployeeDirectoryBackfillOutcome>>();
  private scan: Promise<EmployeeOrganizationBackfillSummary> | undefined;

  constructor(private readonly options: Options) {
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.abort.signal])
      : this.abort.signal;
  }

  start(): Promise<EmployeeOrganizationBackfillSummary> {
    this.scan ??= this.scanUsers();
    return this.scan;
  }

  prepareUser(user: EmployeeDirectoryUser): Promise<EmployeeDirectoryBackfillOutcome> {
    if (this.signal.aborted) {
      return Promise.resolve({ status: "pending", reason: "backfill-stopped" });
    }
    const existing = this.tasks.get(user.id);
    if (existing) {
      return existing;
    }
    if (this.tasks.size >= MAX_PREPARED_TASKS) {
      return Promise.race(this.tasks.values()).then(() => this.prepareUser(user));
    }
    const task = this.prepare(user);
    this.tasks.set(user.id, task);
    const cleanup = () => {
      if (this.tasks.get(user.id) === task) {
        this.tasks.delete(user.id);
      }
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([...this.tasks.values(), ...(this.scan ? [this.scan] : [])]);
  }

  private async record(user: EmployeeDirectoryUser, outcome: EmployeeDirectoryBackfillOutcome) {
    if (this.signal.aborted || user.lastLoginAt === undefined) {
      return false;
    }
    return this.options.store.recordEmployeeDirectoryBackfillAttempt({
      userId: user.id,
      generation: this.generation,
      lastLoginAt: user.lastLoginAt,
      outcome,
      attemptedAt: (this.options.now ?? Date.now)(),
    });
  }

  private async prepare(user: EmployeeDirectoryUser): Promise<EmployeeDirectoryBackfillOutcome> {
    try {
      if (user.lastLoginAt === undefined) {
        return { status: "skipped", reason: "no-authentication" };
      }
      const attempt = await this.options.store.getEmployeeDirectoryBackfillAttempt({
        userId: user.id,
        generation: this.generation,
        lastLoginAt: user.lastLoginAt,
      });
      if (attempt && attempt.status !== "pending") {
        return attempt;
      }
      this.signal.throwIfAborted();
      if (!(await this.record(user, { status: "pending" }))) {
        return { status: "skipped", reason: "stale-authentication" };
      }
      const decision = await this.options.store.getEmployeeDirectoryAuthDecision(
        user.id,
        user.lastLoginAt,
      );
      // Only a positive decision from this authentication can authorize replay.
      // Missing decisions include pending provisioning and failed decision writes.
      let outcome: EmployeeDirectoryBackfillOutcome;
      if (decision !== "eligible") {
        outcome = { status: "skipped", reason: decision ?? "requires-authenticated-org" };
      } else {
        const snapshot = await this.options.store.getEmployeeDirectorySnapshot(user.id);
        this.signal.throwIfAborted();
        if (!snapshot) {
          outcome = { status: "skipped", reason: "requires-authenticated-org" };
        } else {
          const result = await this.options.store.syncDirectoryOrganization({
            userId: user.id,
            ...snapshot,
            syncedAt: (this.options.now ?? Date.now)(),
            expectedLastLoginAt: user.lastLoginAt,
          });
          outcome =
            result.status === "synced"
              ? { status: "synced" }
              : { status: "skipped", reason: result.reason };
        }
      }
      await this.record(user, outcome);
      return outcome;
    } catch {
      const outcome = { status: "failed", reason: "directory-unavailable" } as const;
      if (!this.signal.aborted) {
        await this.record(user, outcome).catch(() => false);
        console.warn("directory_organization_backfill_failed", { userId: user.id });
      }
      return outcome;
    }
  }

  private async scanUsers(): Promise<EmployeeOrganizationBackfillSummary> {
    const summary = { found: 0, synced: 0, skipped: 0, failed: 0, limited: false };
    let afterUserId: string | undefined;
    try {
      while (!this.signal.aborted) {
        const users = await this.options.store.listDirectoryOrganizationBackfillUsers({
          afterUserId,
          limit: PAGE_SIZE,
        });
        if (!users.length) {
          break;
        }
        summary.found += users.length;
        afterUserId = users.at(-1)!.id;
        for (let offset = 0; offset < users.length && !this.signal.aborted; offset += CONCURRENCY) {
          const outcomes = await Promise.all(
            users.slice(offset, offset + CONCURRENCY).map((user) => this.prepareUser(user)),
          );
          for (const outcome of outcomes) {
            if (outcome.status !== "pending") {
              summary[outcome.status] += 1;
            }
          }
        }
        // SQLite tasks resolve in microtasks; yield so recovery cannot starve listener I/O.
        await setImmediate(undefined, { signal: this.signal });
      }
    } catch {
      if (!this.signal.aborted) {
        summary.failed += 1;
        console.warn("directory_organization_backfill_unavailable");
      }
    }
    summary.limited = this.signal.aborted;
    return summary;
  }
}
