/** Process-local ACP runtime handle cache with idle eviction and reuse checks. */
import {
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import { getAcpProcessTransportSessionLimit } from "../runtime/process-transport.js";
import type { ActiveTurnState, SessionAcpMeta } from "./manager.types.js";
import { DEFAULT_ACP_RUNTIME_IDLE_TTL_MS, normalizeActorKey } from "./manager.utils.js";
import { RuntimeCache, type CachedRuntimeState } from "./runtime-cache.js";
import { normalizeText } from "./runtime-options.js";
import type { SessionActorQueue } from "./session-actor-queue.js";

/** Process-local cache of live ACP runtime handles keyed by canonical session actor. */
export class ManagerRuntimeHandleCache {
  private readonly runtimeCache = new RuntimeCache();
  private evictedRuntimeCount = 0;
  private lastEvictedAt: number | undefined;
  private readonly admissionQueue = new KeyedAsyncQueue();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private maintenance: (() => Promise<void>) | undefined;
  private maintenanceTask: Promise<void> | undefined;

  startMaintenance(maintenance: () => Promise<void>): void {
    this.maintenance = maintenance;
    this.armMaintenance();
  }

  stopMaintenance(): Promise<void> {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.maintenance = undefined;
    return this.maintenanceTask ?? Promise.resolve();
  }

  private armMaintenance(): void {
    if (this.idleTimer || !this.maintenance || this.size() === 0) {
      return;
    }
    const oldest = Math.min(...this.runtimeCache.snapshot().map((entry) => entry.lastTouchedAt));
    // Expired busy entries are revisited without a hot timer loop; completion touches their clock.
    const delay = Math.max(60_000, oldest + DEFAULT_ACP_RUNTIME_IDLE_TTL_MS - Date.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.maintenanceTask = this.maintenance?.()
        .catch((error) => {
          logVerbose(`acp-manager: idle maintenance failed: ${String(error)}`);
        })
        .finally(() => {
          this.maintenanceTask = undefined;
          this.armMaintenance();
        });
    }, delay);
    this.idleTimer.unref?.();
  }

  size(): number {
    return this.runtimeCache.size();
  }

  has(sessionKey: string): boolean {
    return this.runtimeCache.has(normalizeActorKey(sessionKey));
  }

  get(sessionKey: string): CachedRuntimeState | null {
    return this.runtimeCache.get(normalizeActorKey(sessionKey));
  }

  set(sessionKey: string, state: CachedRuntimeState): void {
    this.runtimeCache.set(normalizeActorKey(sessionKey), state);
    this.armMaintenance();
  }

  clear(sessionKey: string): void {
    this.runtimeCache.clear(normalizeActorKey(sessionKey));
    if (this.size() === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Admission is serialized across harnesses; victim locks are never acquired behind user work. */
  async withCapacity<T>(
    params: {
      sessionKey: string;
      agent: string;
      executionOwnerAgentId?: string;
      actorQueue: SessionActorQueue;
      activeTurnBySession: Map<string, ActiveTurnState>;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!params.executionOwnerAgentId) {
      return await operation();
    }
    const owner = params.executionOwnerAgentId.trim().toLowerCase();
    const limit = getAcpProcessTransportSessionLimit({
      executionOwnerAgentId: owner,
      agent: params.agent,
    });
    if (limit === undefined) {
      return await operation();
    }
    return await this.admissionQueue.enqueue(owner, async () => {
      if (!this.has(params.sessionKey)) {
        const ownerEntries = () =>
          this.runtimeCache
            .snapshot()
            .filter((entry) => entry.state.executionOwnerAgentId === owner);
        for (const candidate of ownerEntries().toSorted(
          (a, b) => a.lastTouchedAt - b.lastTouchedAt || a.actorKey.localeCompare(b.actorKey),
        )) {
          if (ownerEntries().length < limit) {
            break;
          }
          await this.reclaim(candidate.actorKey, params, "capacity-reclaimed", 0);
        }
        if (ownerEntries().length >= limit) {
          throw new AcpRuntimeError(
            "ACP_SESSION_INIT_FAILED",
            `ACP capacity reached (${limit}). No reclaimable idle runtime is available; wait for work to finish or explicitly close an unused session and retry.`,
          );
        }
      }
      return await operation();
    });
  }

  private async reclaim(
    actorKey: string,
    params: {
      actorQueue: SessionActorQueue;
      activeTurnBySession: Map<string, ActiveTurnState>;
    },
    reason: string,
    minimumIdleMs: number,
  ): Promise<void> {
    if (
      params.activeTurnBySession.has(actorKey) ||
      params.actorQueue.getPendingCount(actorKey) > 0
    ) {
      return;
    }
    await params.actorQueue.run(actorKey, async () => {
      // Count includes this maintenance operation. A newly queued user operation wins over eviction.
      if (
        params.activeTurnBySession.has(actorKey) ||
        params.actorQueue.getPendingCount(actorKey) > 1
      ) {
        return;
      }
      const cached = this.runtimeCache.peek(actorKey);
      const touchedAt = this.runtimeCache.getLastTouchedAt(actorKey);
      if (
        !cached ||
        touchedAt === null ||
        Date.now() - touchedAt < minimumIdleMs ||
        cached.mode !== "persistent" ||
        !(cached.handle.backendSessionId || cached.handle.agentSessionId)
      ) {
        return;
      }
      // Keep failed closes manager-owned; only a successful release frees admission capacity.
      if (
        await this.close({
          sessionKey: actorKey,
          reason,
          expectedHandle: cached.handle,
          throwOnError: true,
        }).catch(() => false)
      ) {
        this.evictedRuntimeCount += 1;
        this.lastEvictedAt = Date.now();
      }
    });
  }

  /** Returns cache counters used by ACP manager observability snapshots. */
  getObservabilitySnapshot() {
    return {
      activeSessions: this.runtimeCache.size(),
      idleTtlMs: DEFAULT_ACP_RUNTIME_IDLE_TTL_MS,
      evictedTotal: this.evictedRuntimeCount,
      ...(this.lastEvictedAt ? { lastEvictedAt: this.lastEvictedAt } : {}),
    };
  }

  /**
   * Closes one cached runtime without resolving or launching a cold session.
   * An exact-handle guard keeps lifecycle rollback from closing a replacement.
   */
  async close(params: {
    sessionKey: string;
    reason: string;
    discardPersistentState?: boolean;
    expectedHandle?: AcpRuntimeHandle;
    throwOnError?: boolean;
  }): Promise<boolean> {
    const cached = this.get(params.sessionKey);
    if (!cached) {
      return false;
    }
    if (params.expectedHandle && !this.runtimeHandlesMatch(cached.handle, params.expectedHandle)) {
      return false;
    }
    let closed = false;
    try {
      await cached.runtime.close({
        handle: cached.handle,
        reason: params.reason,
        ...(params.discardPersistentState ? { discardPersistentState: true } : {}),
      });
      closed = true;
      return true;
    } catch (error) {
      logVerbose(
        `acp-manager: cached runtime close failed for ${params.sessionKey}: ${String(error)}`,
      );
      if (params.throwOnError) {
        throw error;
      }
      return false;
    } finally {
      // Lifecycle callers keep a failed exact handle for deterministic recovery;
      // existing best-effort callers retain their historical eviction behavior.
      if (closed || !params.throwOnError) {
        this.clearIfHandleMatches({ sessionKey: params.sessionKey, handle: cached.handle });
      }
    }
  }

  /** Clears a cached handle only when the caller still owns the same runtime identifiers. */
  clearIfHandleMatches(params: { sessionKey: string; handle: AcpRuntimeHandle }): void {
    const cached = this.get(params.sessionKey);
    if (!cached || !this.runtimeHandlesMatch(cached.handle, params.handle)) {
      return;
    }
    this.clear(params.sessionKey);
  }

  /** Closes handles that exceeded the configured idle TTL without racing active turns. */
  async evictIdle(params: {
    actorQueue: SessionActorQueue;
    activeTurnBySession: Map<string, ActiveTurnState>;
  }): Promise<void> {
    const idleTtlMs = DEFAULT_ACP_RUNTIME_IDLE_TTL_MS;
    if (idleTtlMs <= 0 || this.runtimeCache.size() === 0) {
      return;
    }
    const now = Date.now();
    const candidates = this.runtimeCache.collectIdleCandidates({
      maxIdleMs: idleTtlMs,
      now,
    });
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      await this.reclaim(candidate.actorKey, params, "idle-evicted", idleTtlMs);
    }
  }

  /** Checks whether a cached runtime handle is still healthy enough to reuse. */
  async isReusable(params: {
    sessionKey: string;
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }): Promise<boolean> {
    if (!params.runtime.getStatus) {
      return true;
    }
    try {
      const status = await params.runtime.getStatus({
        handle: params.handle,
      });
      if (isRuntimeStatusUnavailable(status)) {
        this.clear(params.sessionKey);
        logVerbose(
          `acp-manager: evicting cached runtime handle for ${params.sessionKey} after unhealthy status probe: ${status.summary ?? "status unavailable"}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.clear(params.sessionKey);
      logVerbose(
        `acp-manager: evicting cached runtime handle for ${params.sessionKey} after status probe failed: ${String(error)}`,
      );
      return false;
    }
  }

  handleMatchesMeta(params: { handle: AcpRuntimeHandle; meta: SessionAcpMeta }): boolean {
    const identity = resolveSessionIdentityFromMeta(params.meta);
    const expectedHandleIds = resolveRuntimeHandleIdentifiersFromIdentity(identity);
    if ((params.handle.backendSessionId ?? "") !== (expectedHandleIds.backendSessionId ?? "")) {
      return false;
    }
    if ((params.handle.agentSessionId ?? "") !== (expectedHandleIds.agentSessionId ?? "")) {
      return false;
    }

    const expectedAcpxRecordId = identity?.acpxRecordId ?? "";
    const actualAcpxRecordId =
      normalizeText((params.handle as { acpxRecordId?: unknown }).acpxRecordId) ?? "";
    return actualAcpxRecordId === expectedAcpxRecordId;
  }

  private runtimeHandlesMatch(a: AcpRuntimeHandle, b: AcpRuntimeHandle): boolean {
    return (
      a.sessionKey === b.sessionKey &&
      a.backend === b.backend &&
      a.runtimeSessionName === b.runtimeSessionName &&
      (a.cwd ?? "") === (b.cwd ?? "") &&
      (a.acpxRecordId ?? "") === (b.acpxRecordId ?? "") &&
      (a.backendSessionId ?? "") === (b.backendSessionId ?? "") &&
      (a.agentSessionId ?? "") === (b.agentSessionId ?? "")
    );
  }
}

function isRuntimeStatusUnavailable(status: AcpRuntimeStatus | undefined): boolean {
  if (!status) {
    return false;
  }
  const detailsStatus = normalizeLowercaseStringOrEmpty(status.details?.status);
  if (detailsStatus === "dead" || detailsStatus === "no-session") {
    return true;
  }
  const summaryMatch = status.summary?.match(/\bstatus=([^\s]+)/i);
  const summaryStatus = normalizeLowercaseStringOrEmpty(summaryMatch?.[1]);
  return summaryStatus === "dead" || summaryStatus === "no-session";
}
