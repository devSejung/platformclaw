import type {
  BrowserGatewayAccess,
  BrowserGatewayEvent,
  BrowserGatewayProxyOptions,
  BrowserGatewayRequestContext,
} from "./browser-gateway-contracts.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";

const TERMINAL_DETACH_GRACE_MS = 300_000;
const MAX_PERSONAL_TERMINALS = 8;
const TERMINAL_METHODS = new Set([
  "terminal.open",
  "terminal.input",
  "terminal.resize",
  "terminal.close",
  "terminal.attach",
  "terminal.list",
]);

type TerminalRecord = {
  sessionId: string;
  userId: string;
  accountId: string;
  bindingId: string;
  agentId: string;
  allocationId: string;
  targetRevision: number;
  attachedConnectionId: string | null;
  createdAt: number;
  reaper: ReturnType<typeof setTimeout> | null;
  operations: Promise<void>;
  opening: boolean;
};

type ConnectionAccess = {
  userId: string;
  agentId: string;
  expiresAt: number;
  expiryReaper: ReturnType<typeof setTimeout> | null;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserGatewayProxyError("upstream-result-denied", `${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function ownerKey(userId: string, agentId: string): string {
  return `${userId}\u0000${agentId}`;
}

/** Owns personal VM terminals projected across the shared Gateway connection. */
export class BrowserGatewayTerminalController {
  private readonly byOwner = new Map<string, Map<string, TerminalRecord>>();
  private readonly bySession = new Map<string, TerminalRecord>();
  private readonly pendingOwners = new Map<string, number>();
  private readonly listeners = new Map<string, Set<(event: BrowserGatewayEvent) => void>>();
  private readonly connections = new Map<string, ConnectionAccess>();
  private readonly agentEpochs = new Map<string, number>();
  private gatewayEpoch = 0;
  private readonly now: () => number;

  constructor(private readonly options: BrowserGatewayProxyOptions) {
    this.now = options.now ?? Date.now;
  }

  handles(method: string): boolean {
    return TERMINAL_METHODS.has(method);
  }

  subscribeConnectionEvents(
    connectionId: string,
    listener: (event: BrowserGatewayEvent) => void,
  ): () => void {
    const listeners = this.listeners.get(connectionId) ?? new Set();
    this.listeners.set(connectionId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(connectionId);
      }
    };
  }

  registerConnection(connectionId: string, access: BrowserGatewayAccess): void {
    this.refreshConnection(connectionId, access);
  }

  refreshConnection(connectionId: string, access: BrowserGatewayAccess): void {
    const previous = this.connections.get(connectionId);
    if (previous?.expiryReaper) {
      clearTimeout(previous.expiryReaper);
    }
    const connection: ConnectionAccess = {
      userId: access.user.id,
      agentId: access.binding.agentId,
      expiresAt: access.session
        ? Math.min(access.session.idleExpiresAt, access.session.absoluteExpiresAt)
        : this.now(),
      expiryReaper: null,
    };
    const delay = Math.max(0, connection.expiresAt - this.now());
    connection.expiryReaper = setTimeout(() => {
      if (this.connections.get(connectionId) !== connection) {
        return;
      }
      this.connections.delete(connectionId);
      for (const record of this.bySession.values()) {
        if (record.attachedConnectionId === connectionId) {
          void this.closeRecord(record, "session_expired");
        }
      }
    }, delay);
    connection.expiryReaper.unref?.();
    this.connections.set(connectionId, connection);
  }

  async request(params: {
    access: BrowserGatewayAccess;
    method: string;
    request: Record<string, unknown>;
    context?: BrowserGatewayRequestContext;
  }): Promise<unknown> {
    const connectionId = params.context?.connectionId;
    if (!connectionId) {
      throw new BrowserGatewayProxyError(
        "invalid-params",
        `${params.method} requires a browser connection`,
      );
    }
    if (params.context?.isConnected?.() === false) {
      throw new BrowserGatewayProxyError(
        "unauthenticated",
        "Browser terminal connection is no longer active.",
      );
    }
    this.refreshConnection(connectionId, params.access);
    this.assertConnection(connectionId);
    const key = ownerKey(params.access.user.id, params.access.binding.agentId);
    if (params.method === "terminal.open") {
      const pending = this.pendingOwners.get(key) ?? 0;
      if (
        [...(this.byOwner.get(key)?.values() ?? [])].filter((record) => !record.opening).length +
          pending >=
        MAX_PERSONAL_TERMINALS
      ) {
        throw new BrowserGatewayProxyError(
          "method-not-allowed",
          "This Agent has eight open terminals. Close a terminal before opening another.",
        );
      }
      // Reserve before any await so simultaneous browsers cannot exceed the owner cap.
      this.pendingOwners.set(key, pending + 1);
      const agentEpoch = this.agentEpochs.get(params.access.binding.agentId) ?? 0;
      const gatewayEpoch = this.gatewayEpoch;
      try {
        const profile = await this.options.store.getPersonalExecutionProfile(
          params.access.binding.agentId,
        );
        if (
          profile?.activeTarget !== "assigned_vm" ||
          !profile.activeAllocationId ||
          profile.agentBindingId !== params.access.binding.id
        ) {
          throw new BrowserGatewayProxyError(
            "method-not-allowed",
            "Switch this Agent to My development VM before opening a terminal.",
          );
        }
        const raw = object(
          await this.options.gateway.request("terminal.open", {
            agentId: params.access.binding.agentId,
            cols: params.request.cols,
            rows: params.request.rows,
          }),
          "terminal.open result",
        );
        const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
        if (
          !sessionId ||
          raw.agentId !== params.access.binding.agentId ||
          raw.confined !== true ||
          this.bySession.has(sessionId)
        ) {
          if (sessionId && !this.bySession.has(sessionId)) {
            await this.options.gateway
              .request("terminal.close", { sessionId })
              .catch(() => undefined);
          }
          throw new BrowserGatewayProxyError(
            "upstream-result-denied",
            "Gateway returned an invalid personal VM terminal.",
          );
        }
        const record: TerminalRecord = {
          sessionId,
          userId: params.access.user.id,
          accountId: params.access.user.accountId,
          bindingId: params.access.binding.id,
          agentId: params.access.binding.agentId,
          allocationId: profile.activeAllocationId,
          targetRevision: profile.targetRevision,
          attachedConnectionId: connectionId,
          createdAt: this.now(),
          reaper: null,
          operations: Promise.resolve(),
          opening: true,
        };
        const owned = this.byOwner.get(key) ?? new Map<string, TerminalRecord>();
        this.byOwner.set(key, owned);
        owned.set(sessionId, record);
        this.bySession.set(sessionId, record);
        try {
          const attached = object(
            await this.options.gateway.request("terminal.attach", { sessionId }),
            "terminal.attach result",
          );
          if (
            attached.sessionId !== record.sessionId ||
            attached.agentId !== record.agentId ||
            attached.confined !== true ||
            typeof attached.buffer !== "string"
          ) {
            throw new BrowserGatewayProxyError(
              "upstream-result-denied",
              "Gateway returned an invalid personal VM terminal replay.",
            );
          }
          await this.audit(record, "browser.terminal.opened", "opened");
          this.assertConnection(connectionId);
          this.assertCurrentRecord(record);
          if (
            gatewayEpoch !== this.gatewayEpoch ||
            agentEpoch !== (this.agentEpochs.get(record.agentId) ?? 0)
          ) {
            throw new BrowserGatewayProxyError(
              "method-not-allowed",
              "Terminal assignment is no longer active.",
            );
          }
          record.opening = false;
          return {
            ...raw,
            buffer: attached.buffer,
            ...(typeof attached.seq === "number" ? { seq: attached.seq } : {}),
          };
        } catch (error) {
          await this.closeRecord(record, "open_failed");
          throw error;
        }
      } finally {
        const remaining = (this.pendingOwners.get(key) ?? 1) - 1;
        if (remaining > 0) {
          this.pendingOwners.set(key, remaining);
        } else {
          this.pendingOwners.delete(key);
        }
        if (
          ![...this.pendingOwners.keys()].some((owner) =>
            owner.endsWith(`\u0000${params.access.binding.agentId}`),
          )
        ) {
          this.agentEpochs.delete(params.access.binding.agentId);
        }
      }
    }

    if (params.method === "terminal.list") {
      const records = [...(this.byOwner.get(key)?.values() ?? [])].filter(
        (record) => !record.opening,
      );
      if (records.length === 0) {
        return { sessions: [] };
      }
      const raw = object(
        await this.options.gateway.request("terminal.list"),
        "terminal.list result",
      );
      const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
      const projected: Record<string, unknown>[] = [];
      for (const record of records) {
        if (this.bySession.get(record.sessionId) !== record) {
          continue;
        }
        const owned = sessions.find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).sessionId === record.sessionId &&
            (candidate as Record<string, unknown>).agentId === record.agentId,
        );
        if (!owned) {
          await this.remove(record, "missing");
          continue;
        }
        projected.push({
          ...(owned as Record<string, unknown>),
          owner: "conn",
          attached: record.attachedConnectionId === connectionId,
          available:
            record.attachedConnectionId === null || record.attachedConnectionId === connectionId,
        });
      }
      return { sessions: projected };
    }

    const sessionId =
      typeof params.request.sessionId === "string" ? params.request.sessionId.trim() : "";
    const record = sessionId ? this.bySession.get(sessionId) : undefined;
    if (
      !record ||
      record.opening ||
      ownerKey(record.userId, record.agentId) !== key ||
      record.accountId !== params.access.user.accountId ||
      record.bindingId !== params.access.binding.id
    ) {
      throw new BrowserGatewayProxyError("cross-agent-denied", "Terminal session is not owned.");
    }
    // A session has one mutation owner across all browsers, including takeover.
    const previous = record.operations;
    let release!: () => void;
    record.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertCurrentRecord(record);
      this.assertConnection(connectionId);
      if (params.method === "terminal.attach") {
        const result = object(
          await this.options.gateway.request("terminal.attach", { sessionId }),
          "terminal.attach result",
        );
        if (
          result.sessionId !== record.sessionId ||
          result.agentId !== record.agentId ||
          result.confined !== true ||
          typeof result.buffer !== "string"
        ) {
          throw new BrowserGatewayProxyError(
            "upstream-result-denied",
            "Gateway returned an invalid personal VM terminal attachment.",
          );
        }
        this.assertCurrentRecord(record);
        this.assertConnection(connectionId);
        this.attach(record, connectionId);
        return result;
      }
      if (record.attachedConnectionId !== connectionId) {
        throw new BrowserGatewayProxyError(
          "method-not-allowed",
          "Reattach this terminal before interacting with it.",
        );
      }
      if (params.method === "terminal.close") {
        const result = await this.options.gateway.request("terminal.close", { sessionId });
        await this.remove(record, "closed");
        return result;
      }
      return await this.options.gateway.request(params.method, params.request);
    } finally {
      release();
    }
  }

  /** Returns undefined for non-terminal events, null for denied terminal events. */
  filterConnectionEvent(
    event: BrowserGatewayEvent,
    context?: BrowserGatewayRequestContext,
  ): BrowserGatewayEvent | null | undefined {
    if (event.event !== "terminal.data" && event.event !== "terminal.exit") {
      return undefined;
    }
    const connectionId = context?.connectionId;
    const access = connectionId ? this.connections.get(connectionId) : undefined;
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const record = sessionId ? this.bySession.get(sessionId) : undefined;
    if (
      !connectionId ||
      !access ||
      access.expiresAt <= this.now() ||
      !record ||
      record.userId !== access.userId ||
      record.agentId !== access.agentId ||
      record.attachedConnectionId !== connectionId
    ) {
      if (
        record &&
        connectionId &&
        record.attachedConnectionId === connectionId &&
        access?.expiresAt !== undefined &&
        access.expiresAt <= this.now()
      ) {
        void this.closeRecord(record, "expired");
      }
      return null;
    }
    if (event.event === "terminal.exit") {
      void this.remove(record, "process_exit");
    }
    return event;
  }

  releaseConnection(connectionId: string): void {
    this.listeners.delete(connectionId);
    const access = this.connections.get(connectionId);
    if (access?.expiryReaper) {
      clearTimeout(access.expiryReaper);
    }
    this.connections.delete(connectionId);
    for (const record of this.bySession.values()) {
      if (record.attachedConnectionId !== connectionId) {
        continue;
      }
      record.attachedConnectionId = null;
      record.reaper = setTimeout(
        () => void this.closeRecord(record, "disconnect_timeout"),
        TERMINAL_DETACH_GRACE_MS,
      );
      record.reaper.unref?.();
    }
  }

  async closeForAgent(agentId: string, reason: string): Promise<void> {
    if ([...this.pendingOwners.keys()].some((owner) => owner.endsWith(`\u0000${agentId}`))) {
      this.agentEpochs.set(agentId, (this.agentEpochs.get(agentId) ?? 0) + 1);
    }
    await Promise.all(
      [...this.bySession.values()]
        .filter((record) => record.agentId === agentId)
        .map(async (record) => await this.closeRecord(record, reason)),
    );
  }

  handleGatewayDisconnect(): void {
    this.gatewayEpoch += 1;
    for (const record of this.bySession.values()) {
      if (record.reaper) {
        clearTimeout(record.reaper);
      }
    }
    this.byOwner.clear();
    this.bySession.clear();
  }

  private attach(record: TerminalRecord, connectionId: string): void {
    if (record.reaper) {
      clearTimeout(record.reaper);
      record.reaper = null;
    }
    const previous = record.attachedConnectionId;
    record.attachedConnectionId = connectionId;
    // The private Gateway sees one connection; browser takeover belongs to this owner boundary.
    if (previous && previous !== connectionId) {
      for (const listener of this.listeners.get(previous) ?? []) {
        listener({
          event: "terminal.exit",
          payload: { sessionId: record.sessionId, reason: "detached", exitCode: null },
        });
      }
    }
  }

  private assertCurrentRecord(record: TerminalRecord): void {
    // VM/credential retirement revokes this record through closeForAgent.
    // BFF authority comes from that owner revocation, not a mutable work-location profile.
    if (this.bySession.get(record.sessionId) !== record) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "This terminal's VM assignment changed. Open a new terminal.",
      );
    }
  }

  private assertConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.expiresAt <= this.now()) {
      throw new BrowserGatewayProxyError(
        "unauthenticated",
        "Browser terminal connection is no longer active.",
      );
    }
  }

  private async closeRecord(record: TerminalRecord, reason: string): Promise<void> {
    if (this.bySession.get(record.sessionId) !== record) {
      return;
    }
    // Revoke projection ownership before upstream I/O so an in-flight attach
    // cannot revive a terminal whose assignment or grace period expired.
    const removed = this.remove(record, reason);
    await this.options.gateway
      .request("terminal.close", { sessionId: record.sessionId })
      .catch(() => undefined);
    await removed;
  }

  private async remove(record: TerminalRecord, reason: string): Promise<void> {
    if (this.bySession.get(record.sessionId) !== record) {
      return;
    }
    if (record.reaper) {
      clearTimeout(record.reaper);
      record.reaper = null;
    }
    this.bySession.delete(record.sessionId);
    const key = ownerKey(record.userId, record.agentId);
    const owned = this.byOwner.get(key);
    owned?.delete(record.sessionId);
    if (owned?.size === 0) {
      this.byOwner.delete(key);
    }
    // Local ownership and remote cleanup cannot depend on durable audit availability.
    // audit() logs a redacted operator diagnostic before this cleanup handles its rejection.
    await this.audit(record, "browser.terminal.closed", reason).catch(() => undefined);
  }

  private async audit(record: TerminalRecord, eventType: string, outcome: string): Promise<void> {
    await this.options.auditWriter
      .recordAuditEvent({
        actorUserId: record.userId,
        eventType,
        targetType: "vm-allocation",
        targetId: record.allocationId,
        details: {
          accountId: record.accountId,
          agentId: record.agentId,
          bindingId: record.bindingId,
          sessionId: record.sessionId,
          targetRevision: record.targetRevision,
          outcome,
        },
        createdAt: this.now(),
      })
      .catch((error: unknown) => {
        // Database errors can include private paths or values; process logs identify
        // the failed boundary without exposing the raw error or terminal contents.
        console.error("PlatformClaw terminal audit failed", { eventType, outcome });
        throw error;
      });
  }
}
