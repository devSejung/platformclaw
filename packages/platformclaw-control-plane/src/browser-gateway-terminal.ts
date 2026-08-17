import type {
  BrowserGatewayAccess,
  BrowserGatewayEvent,
  BrowserGatewayProxyOptions,
  BrowserGatewayRequestContext,
} from "./browser-gateway-contracts.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";

const TERMINAL_DETACH_GRACE_MS = 300_000;
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

/** Owns the one personal VM terminal projected across the shared Gateway connection. */
export class BrowserGatewayTerminalController {
  private readonly byOwner = new Map<string, TerminalRecord>();
  private readonly bySession = new Map<string, TerminalRecord>();
  private readonly pendingOwners = new Set<string>();
  private readonly connections = new Map<string, ConnectionAccess>();
  private readonly now: () => number;

  constructor(private readonly options: BrowserGatewayProxyOptions) {
    this.now = options.now ?? Date.now;
  }

  handles(method: string): boolean {
    return TERMINAL_METHODS.has(method);
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
    this.refreshConnection(connectionId, params.access);
    const key = ownerKey(params.access.user.id, params.access.binding.agentId);
    if (params.method === "terminal.open") {
      if (this.byOwner.has(key) || this.pendingOwners.has(key)) {
        throw new BrowserGatewayProxyError(
          "method-not-allowed",
          "This Agent already has an open terminal.",
        );
      }
      const profile = await this.options.store.getPersonalExecutionProfile(
        params.access.binding.agentId,
      );
      if (profile?.activeTarget !== "assigned_vm" || !profile.activeAllocationId) {
        throw new BrowserGatewayProxyError(
          "method-not-allowed",
          "Switch this Agent to My development VM before opening a terminal.",
        );
      }
      this.pendingOwners.add(key);
      try {
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
          if (sessionId) {
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
        };
        this.byOwner.set(key, record);
        this.bySession.set(sessionId, record);
        try {
          const attached = object(
            await this.options.gateway.request("terminal.attach", { sessionId }),
            "terminal.attach result",
          );
          if (
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
          return {
            ...raw,
            buffer: attached.buffer,
            ...(typeof attached.seq === "number" ? { seq: attached.seq } : {}),
          };
        } catch (error) {
          this.bySession.delete(record.sessionId);
          this.byOwner.delete(key);
          await this.options.gateway
            .request("terminal.close", { sessionId: record.sessionId })
            .catch(() => undefined);
          throw error;
        }
      } finally {
        this.pendingOwners.delete(key);
      }
    }

    if (params.method === "terminal.list") {
      const record = this.byOwner.get(key);
      if (!record) {
        return { sessions: [] };
      }
      const raw = object(
        await this.options.gateway.request("terminal.list"),
        "terminal.list result",
      );
      const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
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
        return { sessions: [] };
      }
      return {
        sessions: [
          {
            ...(owned as Record<string, unknown>),
            owner: "conn",
            attached: record.attachedConnectionId === connectionId,
          },
        ],
      };
    }

    const sessionId =
      typeof params.request.sessionId === "string" ? params.request.sessionId.trim() : "";
    const record = sessionId ? this.bySession.get(sessionId) : undefined;
    if (!record || ownerKey(record.userId, record.agentId) !== key) {
      throw new BrowserGatewayProxyError("cross-agent-denied", "Terminal session is not owned.");
    }
    if (params.method === "terminal.attach") {
      const result = object(
        await this.options.gateway.request("terminal.attach", { sessionId }),
        "terminal.attach result",
      );
      if (result.agentId !== record.agentId || result.confined !== true) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned an invalid personal VM terminal attachment.",
        );
      }
      this.attach(record, connectionId);
      return result;
    }
    if (params.method === "terminal.close") {
      const result = await this.options.gateway.request("terminal.close", { sessionId });
      await this.remove(record, "closed");
      return result;
    }
    if (record.attachedConnectionId !== connectionId) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Reattach this terminal before interacting with it.",
      );
    }
    return await this.options.gateway.request(params.method, params.request);
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
      if (record && access?.expiresAt !== undefined && access.expiresAt <= this.now()) {
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
    await Promise.all(
      [...this.bySession.values()]
        .filter((record) => record.agentId === agentId)
        .map(async (record) => await this.closeRecord(record, reason)),
    );
  }

  handleGatewayDisconnect(): void {
    for (const record of this.bySession.values()) {
      if (record.reaper) {
        clearTimeout(record.reaper);
      }
    }
    this.byOwner.clear();
    this.bySession.clear();
    this.pendingOwners.clear();
  }

  private attach(record: TerminalRecord, connectionId: string): void {
    if (record.reaper) {
      clearTimeout(record.reaper);
      record.reaper = null;
    }
    record.attachedConnectionId = connectionId;
  }

  private async closeRecord(record: TerminalRecord, reason: string): Promise<void> {
    await this.options.gateway
      .request("terminal.close", { sessionId: record.sessionId })
      .catch(() => undefined);
    await this.remove(record, reason);
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
    this.byOwner.delete(ownerKey(record.userId, record.agentId));
    await this.audit(record, "browser.terminal.closed", reason);
  }

  private async audit(record: TerminalRecord, eventType: string, outcome: string): Promise<void> {
    await this.options.auditWriter.recordAuditEvent({
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
    });
  }
}
