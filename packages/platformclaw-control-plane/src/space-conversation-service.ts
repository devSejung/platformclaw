import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { BrowserGatewayEvent, BrowserGatewayRpc } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import type { SqliteSpaceStore } from "./sqlite-spaces.js";

const READ_METHODS = new Set([
  "chat.history",
  "chat.startup",
  "chat.message.get",
  "chat.toolTitles",
  "sessions.describe",
  "sessions.resolve",
  "sessions.preview",
  "sessions.search",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "sessions.branches.list",
  "sessions.compaction.list",
  "sessions.files.list",
  "sessions.files.get",
  "sessions.usage",
  "artifacts.list",
  "artifacts.download",
  "tools.effective",
]);
const HISTORY_REPLACING_METHODS = new Set([
  "sessions.create",
  "sessions.delete",
  "sessions.reset",
  "sessions.rewind",
  "sessions.branches.switch",
  "sessions.compaction.restore",
]);

export function isSpaceConversationSession(key: string): boolean {
  return /^agent:[^:]+:space-session:/iu.test(key);
}

/** Agent recall contains questions/final answers, never a tool/approval capability. */
function projectSpaceConversationMessages(
  value: unknown,
  ownerId: string,
): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new ControlPlaneStateError("Conversation history unavailable");
  }
  return value.messages.slice(-100).flatMap((message): Record<string, unknown>[] => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    const meta = isRecord(message["__openclaw"]) ? message["__openclaw"] : {};
    if (
      typeof meta.id !== "string" ||
      message.display === false ||
      message.openclawMessageToolMirror !== undefined ||
      (isRecord(message.provenance) && message.provenance.kind === "inter_session") ||
      (message.role === "user" && meta.senderProfileId !== ownerId)
    ) {
      return [];
    }
    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    const toolActivity = blocks.some((block) =>
      ["toolCall", "toolcall", "tool_use"].includes(String(block.type)),
    );
    const role = message.role;
    if (
      role === "assistant" &&
      (toolActivity ||
        // Gateway-injected stopped partials keep stopReason="stop"; the abort marker is authoritative.
        (isRecord(message.openclawAbort) && message.openclawAbort.aborted === true) ||
        (message.phase !== undefined && message.phase !== "final_answer") ||
        (message.stopReason !== undefined &&
          message.stopReason !== "stop" &&
          message.stopReason !== "length"))
    ) {
      return [];
    }
    // Text authored in this registered conversation is shared. Arbitrary prose cannot be
    // semantically scrubbed; structured reasoning, attachments and tool payloads never cross.
    const parts = blocks.flatMap((block): Array<{ text: string; phase?: string }> => {
      if (block.type !== "text" || typeof block.text !== "string") {
        return [];
      }
      if (
        role === "assistant" &&
        typeof block.textSignature === "string" &&
        block.textSignature.startsWith("{")
      ) {
        try {
          const signature: unknown = JSON.parse(block.textSignature);
          if (!isRecord(signature) || signature.v !== 1) {
            return [];
          }
          return [
            {
              text: block.text,
              ...(typeof signature.phase === "string" ? { phase: signature.phase } : {}),
            },
          ];
        } catch {
          return [];
        }
      }
      return [{ text: block.text }];
    });
    const phased = role === "assistant" && parts.some((part) => part.phase !== undefined);
    const text =
      typeof message.content === "string"
        ? message.content
        : parts
            .filter((part) => !phased || part.phase === "final_answer")
            .map((part) => part.text)
            .join("\n");
    if (!text) {
      return [];
    }
    return [
      {
        role,
        content: [{ type: "text", text: truncateUtf16Safe(text, 16000) }],
        ...(typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? { timestamp: message.timestamp }
          : {}),
        __openclaw: {
          id: meta.id,
          ...(role === "user" && typeof meta.senderProfileId === "string"
            ? {
                senderProfileId: meta.senderProfileId,
                ...(typeof meta.senderName === "string" ? { senderName: meta.senderName } : {}),
              }
            : {}),
        },
      },
    ];
  });
}

/** Registry ownership adds Space authority without changing personal runtime identity. */
export class SpaceConversationService {
  private readonly preparing = new Map<string, Promise<void>>();
  constructor(
    readonly spaces: SqliteSpaceStore,
    private readonly gateway: BrowserGatewayRpc,
    private readonly runtimeReady = true,
  ) {}

  async create(
    userId: string,
    spaceId: string,
    pageId: string,
    title: string,
    requestId: string,
    revalidate: () => Promise<void>,
  ) {
    if (!this.runtimeReady) {
      throw new ControlPlaneStateError(
        "Space conversations require the configured internal agent service; ask an administrator to enable the existing execution handoff service",
      );
    }
    const conversation = this.spaces.createConversation(userId, spaceId, {
      pageId,
      title,
      requestId,
    });
    // The registry is committed before provisioning. A retry can repair a failed creation,
    // but an arbitrary pre-existing personal session can never become shared.
    let pending = this.preparing.get(conversation.sessionKey);
    if (!pending) {
      pending = this.ensureSession(conversation).finally(() =>
        this.preparing.delete(conversation.sessionKey),
      );
      this.preparing.set(conversation.sessionKey, pending);
    }
    await pending;
    await revalidate();
    const current = this.spaces.conversation(userId, spaceId, conversation.id, true);
    return current;
  }

  private async ensureSession(conversation: {
    sessionKey: string;
    agentId: string;
    title: string;
  }) {
    const resolved = await this.gateway.request("sessions.resolve", {
      key: conversation.sessionKey,
      agentId: conversation.agentId,
      allowMissing: true,
    });
    if (
      !isRecord(resolved) ||
      typeof resolved.ok !== "boolean" ||
      (resolved.ok && resolved.key !== conversation.sessionKey)
    ) {
      throw new ControlPlaneStateError("Conversation creation unavailable; retry");
    }
    if (resolved.ok) {
      return;
    }
    const result = await this.gateway.request("sessions.create", {
      key: conversation.sessionKey,
      agentId: conversation.agentId,
      label: conversation.title,
      emitCommandHooks: false,
    });
    if (!isRecord(result) || result.ok !== true || result.key !== conversation.sessionKey) {
      throw new ControlPlaneStateError("Conversation creation unavailable; retry");
    }
  }

  async history(
    userId: string,
    spaceId: string,
    conversationId: string,
    revalidate: () => Promise<void>,
    page: { messageId?: string; offset?: number } = {},
  ) {
    const conversation = this.spaces.conversation(userId, spaceId, conversationId);
    const result = await this.gateway.request("chat.history", {
      agentId: conversation.agentId,
      sessionKey: conversation.sessionKey,
      limit: 100,
      ...page,
    });
    await revalidate();
    const current = this.spaces.conversation(userId, spaceId, conversationId);
    if (
      isRecord(result) &&
      result.sessionKey !== undefined &&
      result.sessionKey !== conversation.sessionKey
    ) {
      throw new ControlPlaneStateError("Conversation history ownership mismatch");
    }
    if (!isRecord(result) || !Array.isArray(result.messages)) {
      throw new ControlPlaneStateError("Conversation history unavailable");
    }
    return {
      conversation: current,
      sessionKey: conversation.sessionKey,
      messages: result.messages,
      ...(typeof result.sessionId === "string" ? { sessionId: result.sessionId } : {}),
      ...(typeof result.offset === "number" ? { offset: result.offset } : {}),
      ...(typeof result.hasMore === "boolean" ? { hasMore: result.hasMore } : {}),
      ...(typeof result.nextOffset === "number" ? { nextOffset: result.nextOffset } : {}),
      ...(typeof result.totalMessages === "number" ? { totalMessages: result.totalMessages } : {}),
    };
  }

  async sharedHistory(
    userId: string,
    spaceId: string,
    conversationId: string,
    revalidate: () => Promise<void>,
    messageId?: string,
  ) {
    const conversation = this.spaces.sharedConversation(userId, spaceId, conversationId);
    const raw = await this.gateway.request("chat.history", {
      agentId: conversation.agentId,
      sessionKey: conversation.sessionKey,
      limit: 100,
      maxChars: 16000,
      ...(messageId ? { messageId } : {}),
    });
    await revalidate();
    this.spaces.sharedConversation(userId, spaceId, conversationId);
    if (
      isRecord(raw) &&
      raw.sessionKey !== undefined &&
      raw.sessionKey !== conversation.sessionKey
    ) {
      throw new ControlPlaneStateError("Conversation history ownership mismatch");
    }
    return { messages: projectSpaceConversationMessages(raw, conversation.ownerId) };
  }

  async search(
    userId: string,
    spaceId: string,
    query: string,
    revalidate: () => Promise<void>,
    budget: { remaining: number },
  ) {
    const space = this.spaces.access(userId, spaceId);
    const conversations = this.spaces.sharedConversations(userId, spaceId);
    const byKey = new Map(
      conversations.map((conversation) => [conversation.sessionKey, conversation]),
    );
    const byAgent = new Map<string, string[]>();
    for (const conversation of conversations) {
      const keys = byAgent.get(conversation.agentId) ?? [];
      keys.push(conversation.sessionKey);
      byAgent.set(conversation.agentId, keys);
    }
    const results: Array<Record<string, unknown>> = [];
    const queryTerms = query.toLowerCase().trim().split(/\s+/u);
    let indexing = false;
    for (const [agentId, sessionKeys] of byAgent) {
      if (budget.remaining <= 0) {
        return { results, indexing, windowLimited: true };
      }
      budget.remaining--;
      const raw = await this.gateway.request("sessions.search", {
        agentId,
        sessionKeys,
        query,
        // Native search caps its candidate window at 25. Over-fetch before the
        // final-Q&A projection so commentary does not consume the visible result limit.
        limit: 25,
      });
      await revalidate();
      this.spaces.access(userId, spaceId);
      if (!isRecord(raw) || !Array.isArray(raw.results)) {
        throw new ControlPlaneStateError("Space search unavailable; retry");
      }
      indexing ||= raw.indexing === true;
      for (const hit of raw.results) {
        if (
          !isRecord(hit) ||
          typeof hit.sessionKey !== "string" ||
          typeof hit.messageId !== "string"
        ) {
          continue;
        }
        const conversation = byKey.get(hit.sessionKey);
        if (!conversation || conversation.agentId !== agentId) {
          continue;
        }
        if (budget.remaining <= 0) {
          return { results, indexing, windowLimited: true };
        }
        budget.remaining--;
        // Search indexes may contain tools/commentary. Use the hit only as an anchor;
        // build evidence from the same final-Q&A projection used by direct agent recall.
        const history = await this.sharedHistory(
          userId,
          spaceId,
          conversation.id,
          revalidate,
          hit.messageId,
        );
        const message = history.messages.find(
          (entry) => isRecord(entry["__openclaw"]) && entry["__openclaw"].id === hit.messageId,
        );
        const content = message && Array.isArray(message.content) ? message.content[0] : undefined;
        if (!isRecord(content) || typeof content.text !== "string") {
          continue;
        }
        // An indexed message can mix commentary and final text. Every query term
        // must occur in shareable Q&A; even a hit's presence must not reveal commentary.
        const normalizedText = content.text.toLowerCase();
        if (!queryTerms.every((term) => normalizedText.includes(term))) {
          continue;
        }
        const page = this.spaces.page(userId, spaceId, conversation.pageId);
        const match = normalizedText.indexOf(queryTerms[0]!);
        const start = Math.max(0, match - 120);
        results.push({
          spaceId,
          spaceName: space.name,
          pageId: page.id,
          pageTitle: page.title,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          ownerId: conversation.ownerId,
          ownerName: conversation.ownerName,
          messageId: hit.messageId,
          snippet: content.text.slice(start, start + 1200),
          // Peer sessions are agent-readable evidence, not human navigation targets.
          link: `/platformclaw/app/spaces?space=${encodeURIComponent(spaceId)}&page=${encodeURIComponent(page.id)}`,
        });
        if (results.length >= 10) {
          return { results, indexing, windowLimited: true };
        }
      }
    }
    // Completeness must not reveal whether a guessed term matched excluded
    // commentary. Peer recall always describes a bounded, non-exhaustive window.
    return { results, indexing, windowLimited: true };
  }

  canAccessNative(userId: string, sessionKey: string, write = false): boolean {
    const registered = this.spaces.registeredConversation(sessionKey);
    if (!registered) {
      return !isSpaceConversationSession(sessionKey);
    }
    if (registered.ownerId !== userId) {
      return false;
    }
    try {
      this.spaces.conversationForSession(userId, sessionKey, write);
      return true;
    } catch {
      return false;
    }
  }

  assertNativeRequest(userId: string, method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }
    const keys = [
      params.key,
      params.sessionKey,
      params.parentSessionKey,
      ...(Array.isArray(params.keys) ? params.keys : []),
      ...(Array.isArray(params.sessionKeys) ? params.sessionKeys : []),
      ...(Array.isArray(params.refreshSessionKeys) ? params.refreshSessionKeys : []),
    ];
    for (const key of keys) {
      if (typeof key !== "string") {
        continue;
      }
      const normalized = key.trim();
      const registered = this.spaces.registeredConversation(normalized);
      if (method === "sessions.messages.unsubscribe" && registered?.ownerId === userId) {
        continue;
      }
      const write =
        !READ_METHODS.has(method) ||
        (method === "sessions.messages.subscribe" && params.includeApprovals === true);
      if (!this.canAccessNative(userId, normalized, write)) {
        throw new ControlPlaneAuthorizationError("Space conversation unavailable");
      }
      if (registered && HISTORY_REPLACING_METHODS.has(method)) {
        throw new ControlPlaneStateError(
          "Shared conversation history is retained; create a new conversation instead",
        );
      }
    }
  }

  async guardNativeRequest<T>(
    userId: string,
    method: string,
    params: unknown,
    revalidate: () => Promise<void>,
    run: (validateAdmission: () => void) => Promise<T>,
  ): Promise<T> {
    this.assertNativeRequest(userId, method, params);
    const request = isRecord(params) ? params : {};
    const admissionKey =
      method === "chat.send"
        ? request.sessionKey
        : method === "sessions.steer"
          ? request.key
          : undefined;
    const admission =
      typeof admissionKey === "string"
        ? this.spaces.registeredConversation(admissionKey)
        : undefined;
    const revision = admission
      ? this.spaces.access(userId, admission.spaceId, "editor").revision
      : undefined;
    let revisionChanged = false;
    let returnedRunId: string | undefined;
    const validateAdmission = () => {
      this.assertNativeRequest(userId, method, params);
      if (
        admission &&
        this.spaces.access(userId, admission.spaceId, "editor").revision !== revision
      ) {
        revisionChanged = true;
        throw new ControlPlaneStateError(
          "Space membership changed during admission; reload and retry this message",
        );
      }
    };
    try {
      const result = await run(validateAdmission);
      returnedRunId =
        isRecord(result) && typeof result.runId === "string" ? result.runId : undefined;
      await revalidate();
      validateAdmission();
      if (!method.startsWith("platformclaw.") && isRecord(result)) {
        // Resolve-by-id/label has no request key. Recheck the authoritative result too.
        this.assertNativeRequest(userId, "sessions.resolve", {
          key: result.key,
          sessionKey: result.sessionKey,
        });
      }
      return result;
    } catch (error) {
      if (
        admission &&
        (revisionChanged || !this.canAccessNative(userId, admission.sessionKey, true))
      ) {
        const runId =
          method === "chat.send" && typeof request.idempotencyKey === "string"
            ? request.idempotencyKey
            : returnedRunId;
        try {
          if (runId) {
            // chat.send's client run id is its idempotency key. Stop the old admission,
            // not a newer turn admitted after the employee was reauthorized.
            const stopped = await this.gateway.request("chat.abort", {
              sessionKey: admission.sessionKey,
              agentId: admission.agentId,
              runId,
            });
            if (!isRecord(stopped) || stopped.ok !== true || typeof stopped.aborted !== "boolean") {
              throw new ControlPlaneStateError("Conversation cancellation outcome unavailable");
            }
          } else {
            // A steer may fail before returning its run id; full-session cancellation
            // is intentionally conservative when the native owner supplies no exact identity.
            await this.abort(admission);
          }
        } catch {
          throw new ControlPlaneStateError(
            "Space membership changed during admission; stopping this request could not be confirmed. Reload before retrying",
          );
        }
      }
      throw error;
    }
  }

  event(userId: string, event: BrowserGatewayEvent): BrowserGatewayEvent | null | undefined {
    if (!isRecord(event.payload)) {
      return undefined;
    }
    const key =
      typeof event.payload.sessionKey === "string"
        ? event.payload.sessionKey
        : typeof event.payload.key === "string"
          ? event.payload.key
          : undefined;
    if (!key) {
      return undefined;
    }
    const registered = this.spaces.registeredConversation(key);
    if (!registered) {
      return isSpaceConversationSession(key) ? null : undefined;
    }
    // Human access is owner-only. Membership grants agent recall, not peer UI/events.
    return this.canAccessNative(userId, key) ? undefined : null;
  }

  async cancelRevoked(spaceId: string, userId: string): Promise<void> {
    const results = await Promise.allSettled(
      this.spaces
        .ownedConversations(spaceId, userId)
        .map((conversation) => this.abort(conversation)),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new ControlPlaneStateError(
        "Access removed; some running conversations could not be stopped. Retry removal.",
      );
    }
  }

  private async abort(conversation: { agentId: string; sessionKey: string }) {
    const result = await this.gateway.request("sessions.abort", {
      key: conversation.sessionKey,
      agentId: conversation.agentId,
      clearQueued: true,
    });
    if (
      !isRecord(result) ||
      result.ok !== true ||
      !["aborted", "no-active-run"].includes(String(result.status))
    ) {
      throw new ControlPlaneStateError("Conversation cancellation outcome unavailable");
    }
  }
}
