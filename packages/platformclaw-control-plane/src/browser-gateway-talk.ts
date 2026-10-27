import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createBrowserSenderAttribution } from "./browser-gateway-access.js";
import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
  type BrowserGatewayEvent,
  type BrowserGatewayProxyOptions,
  type BrowserGatewayRequestContext,
} from "./browser-gateway-contracts.js";
import {
  cleanupBrowserTalkLease,
  recordBrowserTalkCleanup,
} from "./browser-gateway-talk-cleanup.js";
import {
  PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
  PLATFORMCLAW_TALK_OFFER_PREFIX,
  PLATFORMCLAW_WEB_TALK_METHODS,
} from "./browser-gateway-talk-policy.js";
import {
  browserTalkObject,
  projectBrowserTalkCatalog,
  projectBrowserTalkClientSession,
  projectBrowserTalkConfig,
  projectBrowserTalkEventPayload,
  projectBrowserTalkFields,
  projectBrowserTalkRelaySession,
} from "./browser-gateway-talk-projections.js";

type JsonObject = Record<string, unknown>;
type TalkKind = "client" | "realtime" | "transcription";
type Connection = {
  access: BrowserGatewayAccess;
  expiresAt: number;
  expiry: ReturnType<typeof setTimeout>;
};
type TalkLease = {
  id: string;
  kind: TalkKind;
  connectionId: string;
  userId: string;
  bindingId: string;
  agentId: string;
  sessionKey: string;
  expiresAt: number;
  drain?: { acknowledged: boolean; expiry?: ReturnType<typeof setTimeout> };
  offer?: { ticket: string; path: string; secret: string; claimed: boolean; expiresAt: number };
};
type TalkRun = { lease: TalkLease; runId: string };
type BrowserTalkOptions = Pick<
  BrowserGatewayProxyOptions,
  "gateway" | "auditWriter" | "resolveAgentIdFromSessionKey" | "now" | "talkOfferRelayAvailable"
>;

const TALK_METHODS = new Set<string>(PLATFORMCLAW_WEB_TALK_METHODS);
const MAX_TALK_SESSIONS = 64;
const MAX_CONNECTION_TALK_SESSIONS = 2;
const MAX_TALK_RUNS = 256;
const MAX_TALK_LIFETIME_MS = 30 * 60_000;
// Core retains provider finals for 5s; composer-dictation.finish listens for at
// most 10s. Keep the event lease through that same bounded delivery window.
const TRANSCRIPTION_DRAIN_EVENT_WINDOW_MS = 10_000;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserGatewayProxyError("invalid-params", `${field} is required`);
  }
  return value.trim();
}

/** Keeps browser Talk ownership distinct from the private, multiplexed Gateway connection. */
export class BrowserGatewayTalkController {
  private readonly connections = new Map<string, Connection>();
  private readonly sessions = new Map<string, TalkLease>();
  private readonly runs = new Map<string, TalkRun>();
  private readonly pending = new Map<string, number>();
  private readonly resuming = new Set<TalkLease>();
  private readonly now: () => number;

  constructor(private readonly options: BrowserTalkOptions) {
    this.now = options.now ?? Date.now;
  }

  handles(method: string): boolean {
    return TALK_METHODS.has(method);
  }

  registerConnection(connectionId: string, access?: BrowserGatewayAccess): void {
    if (!access || this.connections.has(connectionId)) {
      return;
    }
    this.setConnection(connectionId, access);
  }

  refreshConnection(connectionId: string, access: BrowserGatewayAccess): void {
    const previous = this.connections.get(connectionId);
    if (!previous) {
      return;
    }
    if (
      previous.access.user.id !== access.user.id ||
      previous.access.binding.id !== access.binding.id ||
      previous.access.session?.id !== access.session?.id ||
      previous.expiresAt <= this.now()
    ) {
      void this.releaseConnection(connectionId);
      return;
    }
    clearTimeout(previous.expiry);
    this.setConnection(connectionId, access);
  }

  private setConnection(connectionId: string, access: BrowserGatewayAccess): void {
    const expiresAt = access.session
      ? Math.min(access.session.idleExpiresAt, access.session.absoluteExpiresAt)
      : this.now();
    const connection: Connection = {
      access,
      expiresAt,
      expiry: setTimeout(
        () => {
          if (this.connections.get(connectionId) === connection) {
            void this.releaseConnection(connectionId);
          }
        },
        Math.max(0, expiresAt - this.now()),
      ),
    };
    connection.expiry.unref?.();
    this.connections.set(connectionId, connection);
  }

  async request(params: {
    access: BrowserGatewayAccess;
    method: string;
    request: JsonObject;
    context?: BrowserGatewayRequestContext;
    revalidate: () => Promise<BrowserGatewayAccess>;
  }): Promise<unknown> {
    const { method } = params;
    if (method === "talk.catalog" || method === "talk.config") {
      const raw = await this.options.gateway.request(
        method,
        method === "talk.catalog" ? { sessionKey: params.access.mainSessionKey } : {},
      );
      await params.revalidate();
      return method === "talk.catalog"
        ? projectBrowserTalkCatalog(raw)
        : projectBrowserTalkConfig(raw);
    }
    const connectionId = params.context?.connectionId;
    if (!connectionId) {
      throw new BrowserGatewayProxyError(
        "invalid-params",
        `${method} requires a browser connection`,
      );
    }
    this.refreshConnection(connectionId, params.access);
    const request = { ...params.request };
    if (method === "talk.client.create" || method === "talk.session.create") {
      return await this.create(params, connectionId, request);
    }
    if (method === "agent.wait") {
      const runId = requiredString(request.runId, "runId");
      if (!this.ownsRun(params.access, runId, params.context)) {
        throw new BrowserGatewayProxyError(
          "cross-agent-denied",
          "Only this browser's Talk runs can be awaited",
        );
      }
      const access = await params.revalidate();
      if (!this.ownsRun(access, runId, params.context)) {
        throw new BrowserGatewayProxyError(
          "cross-agent-denied",
          "Talk run is no longer owned by this browser",
        );
      }
      const raw = browserTalkObject(
        await this.options.gateway.request(method, request),
        "Talk run status",
      );
      const current = await params.revalidate();
      if (!this.ownsRun(current, runId, params.context)) {
        throw new BrowserGatewayProxyError(
          "cross-agent-denied",
          "Talk run is no longer owned by this browser",
        );
      }
      return projectBrowserTalkFields(raw, [
        "status",
        "error",
        "stopReason",
        "endedAt",
        "pendingError",
        "timeoutPhase",
        "providerStarted",
        "aborted",
        "livenessState",
        "yielded",
      ]);
    }
    const lease = this.resolveRequestLease(params.access, method, request, connectionId);
    this.assertSessionKey(lease.agentId, request.sessionKey ?? lease.sessionKey);
    if (request.sessionKey !== undefined && request.sessionKey !== lease.sessionKey) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        "Talk session key does not match its browser owner",
      );
    }
    // Core's compatibility lookup can create a voice record. Never use it at the
    // browser boundary: every operation must reference an already admitted lease.
    if (method === "talk.client.toolCall") {
      request.voiceSessionId = lease.id;
      if (lease.kind !== "client") {
        request.relaySessionId = lease.id;
      }
      if (this.runs.size >= MAX_TALK_RUNS) {
        throw new BrowserGatewayProxyError(
          "method-not-allowed",
          "Too many active Talk runs; close this voice session and try again",
        );
      }
    }
    const access = await params.revalidate();
    this.assertLease(lease, access, connectionId);
    if (method === "talk.client.toolCall") {
      // The shared operator connection authorizes forwarding, never the human's
      // command or model-tool privileges at the downstream chat boundary.
      request.senderAttribution = createBrowserSenderAttribution(access);
    }
    const draining = method === "talk.session.close" && lease.kind === "transcription";
    if (draining) {
      lease.drain = { acknowledged: false };
    }
    let raw: JsonObject;
    try {
      raw = browserTalkObject(
        await this.options.gateway.request(method, request),
        `${method} result`,
      );
    } catch (error) {
      if (draining) {
        lease.drain = undefined;
      }
      throw error;
    }
    if (method === "talk.client.toolCall") {
      const runId = requiredString(raw.runId, "Talk runId");
      this.assertLease(lease, await params.revalidate(), connectionId);
      this.runs.set(runId, { lease, runId });
      return projectBrowserTalkFields(raw, ["runId", "idempotencyKey"]);
    }
    if (draining && raw.ok === true && this.sessions.get(lease.id) === lease && lease.drain) {
      lease.drain.acknowledged = true;
      lease.drain.expiry = setTimeout(() => {
        if (this.sessions.get(lease.id) === lease) {
          this.forget(lease);
          void recordBrowserTalkCleanup(
            this.options,
            lease,
            "transcription_drain_timeout",
            "terminal_event_missing",
          );
        }
      }, TRANSCRIPTION_DRAIN_EVENT_WINDOW_MS);
      lease.drain.expiry.unref?.();
    } else if (draining) {
      lease.drain = undefined;
    } else if (method === "talk.session.close" || method === "talk.client.close") {
      this.forget(lease);
    }
    if (method === "talk.session.steer" || method === "talk.client.steer") {
      this.assertSessionKey(lease.agentId, raw.sessionKey);
      return projectBrowserTalkFields(raw, [
        "ok",
        "mode",
        "sessionKey",
        "active",
        "queued",
        "aborted",
        "target",
        "reason",
        "message",
        "speak",
        "show",
        "suppress",
        "providerResult",
        "enqueuedAtMs",
        "deliveredAtMs",
      ]);
    }
    return { ok: raw.ok === true };
  }

  ownsRun(
    access: BrowserGatewayAccess,
    runId: string,
    context?: BrowserGatewayRequestContext,
  ): boolean {
    const run = this.runs.get(runId);
    return Boolean(run && context && this.matches(run.lease, access, context.connectionId));
  }

  filterEvent(
    access: BrowserGatewayAccess,
    event: BrowserGatewayEvent,
    context?: BrowserGatewayRequestContext,
  ): BrowserGatewayEvent | null | undefined {
    if (event.event !== "talk.event") {
      return undefined;
    }
    if (!context || !isRecord(event.payload)) {
      return null;
    }
    const id = event.payload.relaySessionId ?? event.payload.transcriptionSessionId;
    const lease = typeof id === "string" ? this.sessions.get(id) : undefined;
    const closing = event.payload.type === "close";
    if (
      !lease ||
      !this.matches(lease, access, context.connectionId, closing || Boolean(lease.drain))
    ) {
      return null;
    }
    const projected = { ...event, payload: projectBrowserTalkEventPayload(event.payload) };
    if (closing) {
      this.forget(lease);
    }
    return projected;
  }

  claimOffer(access: BrowserGatewayAccess, ticket: string): { path: string; secret: string } {
    const lease = [...this.sessions.values()].find((entry) => entry.offer?.ticket === ticket);
    if (
      !lease ||
      !this.matches(lease, access, lease.connectionId) ||
      !lease.offer ||
      lease.offer.claimed ||
      lease.offer.expiresAt <= this.now()
    ) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        "Talk connection offer is unavailable; start a new voice session",
      );
    }
    lease.offer.claimed = true;
    return { path: lease.offer.path, secret: lease.offer.secret };
  }

  assertOfferActive(access: BrowserGatewayAccess, ticket: string): void {
    const lease = [...this.sessions.values()].find((entry) => entry.offer?.ticket === ticket);
    if (!lease || !this.matches(lease, access, lease.connectionId) || !lease.offer?.claimed) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        "Talk browser connection is no longer active",
      );
    }
  }

  async releaseConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      clearTimeout(connection.expiry);
      this.connections.delete(connectionId);
    }
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((lease) => lease.connectionId === connectionId)
        .map(async (lease) => await this.close(lease, "browser_disconnected")),
    );
  }

  async closeForAgent(agentId: string, reason: string): Promise<void> {
    // Membership is the admission owner. Remove it before awaited provider
    // cleanup so pending creates cannot restore a revoked browser connection.
    for (const [connectionId, connection] of this.connections) {
      if (connection.access.binding.agentId === agentId) {
        clearTimeout(connection.expiry);
        this.connections.delete(connectionId);
      }
    }
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((lease) => lease.agentId === agentId)
        .map(async (lease) => await this.close(lease, reason)),
    );
  }

  handleGatewayDisconnect(): void {
    for (const lease of this.sessions.values()) {
      this.forget(lease);
    }
  }

  private async create(
    params: Parameters<BrowserGatewayTalkController["request"]>[0],
    connectionId: string,
    request: JsonObject,
  ): Promise<unknown> {
    const clientOwned = params.method === "talk.client.create";
    const mode = clientOwned ? "realtime" : request.mode;
    if (mode !== "realtime" && mode !== "transcription") {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Browser Talk supports realtime conversation and dictation",
      );
    }
    const brain = mode === "transcription" ? "none" : "agent-consult";
    if (
      (clientOwned && request.mode !== undefined && request.mode !== "realtime") ||
      (request.brain !== undefined && request.brain !== brain) ||
      (!clientOwned && request.transport !== undefined && request.transport !== "gateway-relay")
    ) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Browser Talk cannot create managed rooms or direct tool sessions",
      );
    }
    const sessionKey = request.sessionKey ?? params.access.mainSessionKey;
    this.assertSessionKey(params.access.binding.agentId, sessionKey);
    request.sessionKey = sessionKey;
    let resumed: TalkLease | undefined;
    if (request.voiceSessionId !== undefined) {
      resumed = this.sessions.get(requiredString(request.voiceSessionId, "voiceSessionId"));
      if (!resumed || resumed.kind !== "client" || resumed.sessionKey !== sessionKey) {
        throw new BrowserGatewayProxyError(
          "cross-agent-denied",
          "Talk resume requires this browser's active voice session",
        );
      }
      this.assertLease(resumed, params.access, connectionId);
    }
    if (!clientOwned) {
      request.clientOwnerId = connectionId;
      request.transport = "gateway-relay";
      request.brain = brain;
    }
    // The Gateway owns relay TTL teardown and emits the terminal event. Reclaim
    // missed terminal bookkeeping before admission without racing that event.
    for (const entry of this.sessions.values()) {
      if (entry.expiresAt <= this.now() && !entry.drain) {
        void this.close(entry, "voice_expired");
      }
    }
    const access = await params.revalidate();
    this.assertConnection(access, connectionId);
    request.senderAttribution = createBrowserSenderAttribution(access);
    if (resumed) {
      this.assertLease(resumed, access, connectionId);
    }
    const ownedCount = [...this.sessions.values()].filter(
      (entry) => entry.connectionId === connectionId,
    ).length;
    const pending = this.pending.get(connectionId) ?? 0;
    if (resumed && this.resuming.has(resumed)) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "This voice session is already reconnecting; wait for it to finish",
      );
    }
    if (
      !resumed &&
      (ownedCount + pending >= MAX_CONNECTION_TALK_SESSIONS ||
        this.sessions.size + [...this.pending.values()].reduce((sum, count) => sum + count, 0) >=
          MAX_TALK_SESSIONS)
    ) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Too many active voice sessions; close a voice session and try again",
      );
    }
    this.pending.set(connectionId, pending + 1);
    if (resumed) {
      this.resuming.add(resumed);
    }
    let raw: JsonObject | undefined;
    let lease: TalkLease | undefined;
    try {
      raw = browserTalkObject(
        await this.options.gateway.request(params.method, request),
        "Talk creation result",
      );
      const projected = clientOwned
        ? projectBrowserTalkClientSession(raw)
        : projectBrowserTalkRelaySession(raw);
      const id = requiredString(
        clientOwned ? projected.voiceSessionId : projected.sessionId,
        "Talk session id",
      );
      if (resumed && id !== resumed.id) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway changed the resumed Talk session",
        );
      }
      if (this.sessions.has(id) && this.sessions.get(id) !== resumed) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned a Talk session owned by another browser",
        );
      }
      const current = await params.revalidate();
      this.assertConnection(current, connectionId);
      if (resumed) {
        this.assertLease(resumed, current, connectionId);
      }
      // Gateway relay results use Unix seconds; native client credentials use ms.
      const rawExpiresAt =
        typeof projected.expiresAt === "number"
          ? projected.expiresAt * (clientOwned ? 1 : 1000)
          : this.now() + MAX_TALK_LIFETIME_MS;
      if (!Number.isFinite(rawExpiresAt) || rawExpiresAt <= this.now()) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Talk session expired during startup; try again",
        );
      }
      // Client expiresAt describes the one-shot startup credential, not the call.
      // Native transports live with their browser connection; the provider owns
      // its native call duration. Relay leases retain the Gateway's actual TTL.
      const expiresAt = clientOwned
        ? Number.POSITIVE_INFINITY
        : Math.min(rawExpiresAt, this.now() + MAX_TALK_LIFETIME_MS);
      lease = resumed ?? {
        id,
        kind: clientOwned ? "client" : mode,
        connectionId,
        userId: access.user.id,
        bindingId: access.binding.id,
        agentId: access.binding.agentId,
        sessionKey: sessionKey as string,
        expiresAt,
      };
      lease.offer = undefined;
      lease.expiresAt = expiresAt;
      this.sessions.set(id, lease);
      if (
        clientOwned &&
        typeof projected.offerUrl === "string" &&
        projected.offerUrl.startsWith("/")
      ) {
        if (!this.options.talkOfferRelayAvailable) {
          throw new BrowserGatewayProxyError(
            "upstream-result-denied",
            "Local Talk offer relay is unavailable; configure the private Gateway media relay and try again",
          );
        }
        if (projected.offerUrl !== PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH) {
          throw new BrowserGatewayProxyError(
            "upstream-result-denied",
            "Gateway returned an unsupported local Talk offer path",
          );
        }
        const ticket = randomUUID();
        lease.offer = {
          ticket,
          path: projected.offerUrl,
          secret: requiredString(projected.clientSecret, "Talk client credential"),
          claimed: false,
          expiresAt: rawExpiresAt,
        };
        projected.offerUrl = `${PLATFORMCLAW_TALK_OFFER_PREFIX}${ticket}`;
      }
      return projected;
    } catch (error) {
      if (lease) {
        await this.close(lease, "startup_rejected");
      } else if (raw) {
        const id = clientOwned ? raw.voiceSessionId : raw.sessionId;
        if (typeof id === "string" && !this.sessions.has(id)) {
          await cleanupBrowserTalkLease(
            this.options,
            {
              id,
              kind: clientOwned ? "client" : mode,
              sessionKey: sessionKey as string,
              userId: access.user.id,
              bindingId: access.binding.id,
              agentId: access.binding.agentId,
            },
            "startup_rejected",
          );
        }
      }
      throw error;
    } finally {
      if (resumed) {
        this.resuming.delete(resumed);
      }
      const remaining = (this.pending.get(connectionId) ?? 1) - 1;
      if (remaining > 0) {
        this.pending.set(connectionId, remaining);
      } else {
        this.pending.delete(connectionId);
      }
    }
  }

  private resolveRequestLease(
    access: BrowserGatewayAccess,
    method: string,
    request: JsonObject,
    connectionId: string,
  ): TalkLease {
    const id = method.startsWith("talk.session.")
      ? request.sessionId
      : (request.voiceSessionId ?? request.relaySessionId);
    const lease =
      typeof id === "string"
        ? this.sessions.get(id)
        : method === "talk.client.steer"
          ? [...this.sessions.values()].find(
              (entry) =>
                entry.kind === "client" &&
                entry.connectionId === connectionId &&
                entry.sessionKey === request.sessionKey,
            )
          : undefined;
    if (!lease) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        "Talk operation requires this browser's active voice session",
      );
    }
    this.assertLease(lease, access, connectionId);
    if (method.startsWith("talk.session.") && lease.kind === "client") {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Client-owned voice sessions use talk.client methods",
      );
    }
    return lease;
  }

  private assertSessionKey(agentId: string, value: unknown): void {
    if (typeof value !== "string" || this.options.resolveAgentIdFromSessionKey(value) !== agentId) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        "Talk session is outside the personal Agent binding",
      );
    }
  }

  private assertConnection(access: BrowserGatewayAccess, connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (
      !connection ||
      connection.expiresAt <= this.now() ||
      connection.access.user.id !== access.user.id ||
      connection.access.binding.id !== access.binding.id ||
      connection.access.session?.id !== access.session?.id
    ) {
      throw new BrowserGatewayProxyError(
        "unauthenticated",
        "Talk browser connection is no longer active",
      );
    }
  }

  private matches(
    lease: TalkLease,
    access: BrowserGatewayAccess,
    connectionId: string,
    allowExpired = false,
  ): boolean {
    const connection = this.connections.get(connectionId);
    return (
      this.sessions.get(lease.id) === lease &&
      lease.connectionId === connectionId &&
      (allowExpired || lease.expiresAt > this.now()) &&
      lease.userId === access.user.id &&
      lease.bindingId === access.binding.id &&
      lease.agentId === access.binding.agentId &&
      connection?.access.session?.id === access.session?.id &&
      (connection?.expiresAt ?? 0) > this.now()
    );
  }

  private assertLease(lease: TalkLease, access: BrowserGatewayAccess, connectionId: string): void {
    this.assertConnection(access, connectionId);
    if (lease.drain) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Dictation is finishing; wait for its final transcript",
      );
    }
    if (!this.matches(lease, access, connectionId)) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        "Talk session is no longer owned by this browser",
      );
    }
  }

  private forget(lease: TalkLease): void {
    if (this.sessions.get(lease.id) !== lease) {
      return;
    }
    clearTimeout(lease.drain?.expiry);
    this.sessions.delete(lease.id);
    for (const [id, run] of this.runs) {
      if (run.lease === lease) {
        this.runs.delete(id);
      }
    }
  }

  private async close(lease: TalkLease, reason: string): Promise<void> {
    if (this.sessions.get(lease.id) !== lease) {
      return;
    }
    this.forget(lease);
    await cleanupBrowserTalkLease(this.options, lease, reason);
  }
}
