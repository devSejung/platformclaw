import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { BrowserGatewayRpc, BrowserGatewayEvent } from "./browser-gateway-contracts.js";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type { Space, SpacePage } from "./space-contracts.js";
import {
  SpaceConversationService,
  isSpaceConversationSession,
} from "./space-conversation-service.js";
import {
  SpaceNativeSessionGuard,
  type SpaceNativeSessionRequest,
} from "./space-native-session-guard.js";
import {
  assertSpaceTextOffset,
  projectSpaceRecallResult,
  validateSpaceRecallWindow,
  type SpaceRecallWindow,
} from "./space-recall-projection.js";
import { spaceText, type SqliteSpaceStore } from "./sqlite-spaces.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

// One agent query shares this work budget across Spaces and both transcript paths.
// Bounded output alone would still permit thousands of sequential history reads.
const SPACE_SEARCH_LOOKUP_LIMIT = 40;

type SpaceAgentReadParams = SpaceRecallWindow &
  Partial<Omit<SpaceNativeSessionRequest, "agentId" | "sessionKey">> & {
    agentId: string;
    query?: string;
    spaceId?: string;
    pageId?: string;
    sessionKey?: string;
    runId?: string;
    bodyOffset?: number;
    pageRevision?: number;
    conversationId?: string;
  };

export type SpaceMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number | null;
  authorId: string | null;
  authorName: string | null;
};
function projectSpaceMessages(value: unknown): SpaceMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new ControlPlaneStateError("Conversation history unavailable");
  }
  return value.messages.slice(-100).flatMap((message): SpaceMessage[] => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      return [];
    }
    const meta = isRecord(message["__openclaw"]) ? message["__openclaw"] : {};
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .flatMap((block) =>
                isRecord(block) && block.type === "text" && typeof block.text === "string"
                  ? [block.text]
                  : [],
              )
              .join("\n")
          : "";
    if (!text || typeof meta.id !== "string") {
      return [];
    }
    return [
      {
        id: meta.id,
        role: message.role,
        text: truncateUtf16Safe(text, 16000),
        timestamp:
          typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
            ? message.timestamp
            : null,
        authorId:
          message.role === "user" && typeof meta.senderProfileId === "string"
            ? meta.senderProfileId
            : null,
        authorName:
          message.role === "user" &&
          typeof meta.senderProfileId === "string" &&
          typeof meta.senderName === "string"
            ? meta.senderName
            : null,
      },
    ];
  });
}

function projectSpacePage(
  page: SpacePage,
  params: { bodyOffset?: number; pageRevision?: number } = {},
) {
  const bodyOffset = params.bodyOffset ?? 0;
  if (params.pageRevision !== undefined && params.pageRevision !== page.revision) {
    throw new ControlPlaneConflictError(
      "space_changed",
      "Page changed; read from bodyOffset 0 before continuing",
    );
  }
  if (bodyOffset > 0 && params.pageRevision === undefined) {
    throw new ControlPlaneStateError("A continuation requires the returned page revision");
  }
  if (!Number.isSafeInteger(bodyOffset) || bodyOffset < 0 || bodyOffset > page.body.length) {
    throw new ControlPlaneStateError("Invalid page offset; read from bodyOffset 0");
  }
  assertSpaceTextOffset(page.body, bodyOffset);
  const body = truncateUtf16Safe(page.body.slice(bodyOffset), 8000);
  const nextBodyOffset =
    bodyOffset + body.length < page.body.length ? bodyOffset + body.length : null;
  return { ...page, body, bodyOffset, nextBodyOffset, truncated: nextBodyOffset !== null };
}

/** Space is the authority; Gateway sessions own transcript storage and run scheduling. */
export class SpaceService {
  readonly spaces: SqliteSpaceStore;
  readonly conversations: SpaceConversationService;
  private readonly nativeSessions: SpaceNativeSessionGuard;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  changed() {
    for (const listener of this.listeners) {
      listener();
    }
  }
  constructor(
    readonly store: SqliteControlPlaneStore,
    private readonly gateway: BrowserGatewayRpc,
    runtimeReady = true,
  ) {
    this.spaces = store.spaces;
    this.conversations = new SpaceConversationService(this.spaces, gateway, runtimeReady);
    this.nativeSessions = new SpaceNativeSessionGuard(this.spaces, gateway);
  }
  private key(agentId: string, pageId: string) {
    return `agent:${agentId}:space:${pageId}`;
  }
  async history(
    userId: string,
    spaceId: string,
    pageId: string,
    revalidate: () => Promise<void>,
    messageId?: string,
  ) {
    const space = this.spaces.access(userId, spaceId);
    this.spaces.page(userId, spaceId, pageId);
    if (!this.spaces.hasConversation(pageId)) {
      return { messages: [] };
    }
    const raw = await this.gateway.request("chat.history", {
      agentId: space.agentId,
      sessionKey: this.key(space.agentId, pageId),
      limit: 100,
      ...(messageId ? { messageId: spaceText(messageId, "message id", 256) } : {}),
    });
    await revalidate();
    this.spaces.page(userId, spaceId, pageId);
    return { messages: projectSpaceMessages(raw) };
  }
  private async searchSpace(
    space: Pick<Space, "id" | "name" | "agentId">,
    pages: SpacePage[],
    query: string,
    revalidate: () => Promise<void>,
    budget = { remaining: SPACE_SEARCH_LOOKUP_LIMIT },
  ) {
    const keys = new Map(
      pages
        .filter((page) => this.spaces.hasConversation(page.id))
        .map((page) => [this.key(space.agentId, page.id), page]),
    );
    let raw: unknown = { results: [] };
    if (keys.size && budget.remaining > 0) {
      budget.remaining--;
      raw = await this.gateway.request("sessions.search", {
        agentId: space.agentId,
        sessionKeys: [...keys.keys()],
        query,
        limit: 10,
      });
    } else if (keys.size) {
      raw = { results: [], truncated: true };
    }
    await revalidate();
    if (!isRecord(raw) || !Array.isArray(raw.results)) {
      throw new ControlPlaneStateError("Space search unavailable; retry");
    }
    const source = (page: SpacePage, snippet: string, messageId?: string) => ({
      spaceId: space.id,
      spaceName: space.name,
      pageId: page.id,
      pageTitle: page.title,
      snippet: snippet.slice(0, 1200),
      ...(messageId ? { messageId } : {}),
      link: `/platformclaw/app/spaces?space=${encodeURIComponent(space.id)}&page=${encodeURIComponent(page.id)}${messageId ? `&message=${encodeURIComponent(messageId)}` : ""}`,
    });
    // Notes have no transcript until the first send. Search both owned sources for every caller.
    const needle = query.toLowerCase();
    const notes = pages.flatMap((page) => {
      const match = page.body.toLowerCase().indexOf(needle);
      if (match < 0 && !page.title.toLowerCase().includes(needle)) {
        return [];
      }
      const bodyOffset = truncateUtf16Safe(page.body, Math.max(0, match - 120)).length;
      const snippet = match < 0 ? page.title : truncateUtf16Safe(page.body.slice(bodyOffset), 1200);
      return [{ ...source(page, snippet), bodyOffset, pageRevision: page.revision }];
    });
    const conversations = raw.results.flatMap((hit) => {
      if (!isRecord(hit) || typeof hit.sessionKey !== "string" || typeof hit.snippet !== "string") {
        return [];
      }
      const page = keys.get(hit.sessionKey);
      return page
        ? [source(page, hit.snippet, typeof hit.messageId === "string" ? hit.messageId : undefined)]
        : [];
    });
    const results = [...notes, ...conversations];
    return {
      results: results.slice(0, 20),
      indexing: raw.indexing === true,
      ...(raw.truncated === true || results.length > 20 ? { windowLimited: true } : {}),
    };
  }
  async search(
    userId: string,
    query: string,
    spaceId: string | undefined,
    revalidate: () => Promise<void>,
    includePersonalConversations = false,
  ) {
    spaceText(query, "query", 1000);
    const spaces = spaceId ? [this.spaces.access(userId, spaceId)] : this.spaces.list(userId);
    const matches: Array<{
      results: Array<Record<string, unknown>>;
      indexing: boolean;
      windowLimited?: boolean;
    }> = [];
    const budget = { remaining: SPACE_SEARCH_LOOKUP_LIMIT };
    let windowLimited = false;
    for (const space of spaces) {
      if (budget.remaining <= 0) {
        windowLimited = true;
        break;
      }
      matches.push(
        await this.searchSpace(
          space,
          this.spaces.pages(userId, space.id),
          query,
          async () => {
            await revalidate();
            this.spaces.access(userId, space.id);
          },
          budget,
        ),
      );
      if (includePersonalConversations) {
        const personal = await this.conversations.search(
          userId,
          space.id,
          query,
          async () => {
            await revalidate();
            this.spaces.access(userId, space.id);
          },
          budget,
        );
        matches.push(personal);
      }
    }
    await revalidate();
    for (const space of spaces) {
      this.spaces.access(userId, space.id);
    }
    return {
      results: matches.flatMap((match) => match.results).slice(0, 20),
      ...(windowLimited ||
      matches.some((match) => match.windowLimited) ||
      matches.flatMap((match) => match.results).length > 20
        ? { windowLimited: true }
        : {}),
      indexing: matches.some((match) => match.indexing),
    };
  }
  observe(event: BrowserGatewayEvent) {
    if (
      event.event !== "chat" ||
      !isRecord(event.payload) ||
      !["final", "aborted", "error"].includes(String(event.payload.state)) ||
      event.payload.queuePhase === "deferred" ||
      typeof event.payload.runId !== "string" ||
      typeof event.payload.sessionKey !== "string"
    ) {
      return;
    }
    const target = /^agent:(space-[a-f0-9-]{36}):space:([a-f0-9-]{36})$/u.exec(
      event.payload.sessionKey,
    );
    if (target && this.spaces.spaceForAgent(target[1]!)) {
      this.spaces.finishRun(event.payload.runId, target[2]);
    }
  }
  event(userId: string, event: BrowserGatewayEvent): BrowserGatewayEvent | null | undefined {
    const personalEvent = this.conversations.event(userId, event);
    if (personalEvent !== undefined) {
      return personalEvent;
    }
    if (!isRecord(event.payload)) {
      return undefined;
    }
    const key =
      typeof event.payload.sessionKey === "string"
        ? event.payload.sessionKey
        : typeof event.payload.key === "string"
          ? event.payload.key
          : "";
    const match = /^agent:(space-[a-f0-9-]{36}):space:([a-f0-9-]{36})$/u.exec(key);
    if (!match) {
      return undefined;
    }
    try {
      const spaceId = this.spaces.spaceForAgent(match[1]!);
      if (!spaceId) {
        return null;
      }
      this.spaces.page(userId, spaceId, match[2]!);
      // Never forward raw tool events, reasoning, host paths, or private service identities.
      const state =
        event.event === "chat" &&
        ["delta", "final", "aborted", "error"].includes(String(event.payload.state))
          ? String(event.payload.state)
          : undefined;
      let text: string | undefined;
      if (state === "delta" && isRecord(event.payload.message)) {
        const projected = projectSpaceMessages({
          messages: [{ ...event.payload.message, role: "assistant", __openclaw: { id: "stream" } }],
        });
        text = projected[0]?.text;
      }
      return {
        event: "platformclaw.space.changed",
        payload: {
          spaceId,
          pageId: match[2],
          ...(state ? { state } : {}),
          ...(text ? { text } : {}),
        },
      };
    } catch {
      return null;
    }
  }
  async agentRead(params: SpaceAgentReadParams): Promise<Record<string, unknown>> {
    if (params.operation === "native") {
      if (typeof params.nativeTool !== "string" || typeof params.broad !== "boolean") {
        throw new ControlPlaneStateError("Invalid native session authorization request");
      }
      return await this.nativeSessions.authorize({
        ...params,
        nativeTool: params.nativeTool,
        broad: params.broad,
      });
    }
    validateSpaceRecallWindow(params);
    return projectSpaceRecallResult(await this.readAgentScope(params), params);
  }
  private async readAgentScope(params: SpaceAgentReadParams) {
    const sharedId = this.spaces.spaceForAgent(params.agentId);
    if (!sharedId) {
      const userId = this.spaces.userForAgent(params.agentId);
      const registered = params.sessionKey
        ? this.spaces.registeredConversation(params.sessionKey)
        : undefined;
      if (params.sessionKey && isSpaceConversationSession(params.sessionKey) && !registered) {
        throw new ControlPlaneAuthorizationError("Space conversation unavailable");
      }
      const revalidate = async () => {
        this.spaces.userForAgent(params.agentId);
        if (registered) {
          this.spaces.conversationForSession(userId, registered.sessionKey, true);
        }
      };
      await revalidate();
      if (registered && params.spaceId && params.spaceId !== registered.spaceId) {
        throw new ControlPlaneAuthorizationError("Space unavailable");
      }
      if (params.operation === "context") {
        if (!registered || registered.agentId !== params.agentId) {
          throw new ControlPlaneAuthorizationError("Space conversation unavailable");
        }
        const space = this.spaces.access(userId, registered.spaceId, "editor");
        return {
          spaceName: space.name,
          page: projectSpacePage(this.spaces.page(userId, space.id, registered.pageId)),
          conversation: { id: registered.id, title: registered.title },
        };
      }
      if (params.operation === "search") {
        return await this.search(
          userId,
          spaceText(params.query, "query", 1000),
          registered?.spaceId ?? params.spaceId,
          revalidate,
          true,
        );
      }
      const spaceId = spaceText(params.spaceId, "space id", 128);
      const pageId = spaceText(params.pageId, "page id", 128);
      const page = this.spaces.page(userId, spaceId, pageId);
      if (params.conversationId) {
        const conversation = this.spaces.sharedConversation(userId, spaceId, params.conversationId);
        if (conversation.pageId !== pageId) {
          throw new ControlPlaneAuthorizationError("Space conversation unavailable");
        }
        const history = await this.conversations.sharedHistory(
          userId,
          spaceId,
          conversation.id,
          revalidate,
          params.messageId,
        );
        return {
          page: projectSpacePage(page, params),
          conversation: {
            id: conversation.id,
            title: conversation.title,
            ownerId: conversation.ownerId,
            ownerName: conversation.ownerName,
          },
          messages: projectSpaceMessages(history),
        };
      }
      const history = await this.history(userId, spaceId, pageId, revalidate, params.messageId);
      return {
        page: projectSpacePage(page, params),
        messages: history.messages,
      };
    }
    if (params.spaceId && params.spaceId !== sharedId) {
      throw new ControlPlaneAuthorizationError("Space unavailable");
    }
    this.spaces.assertRun(params.agentId, params.runId);
    const scope = this.spaces.agentScope(params.agentId);
    if (params.operation === "context" || params.operation === "get") {
      const pageId =
        params.operation === "context" ? params.sessionKey?.split(":").at(-1) : params.pageId;
      const page = scope.pages.find((entry) => entry.id === pageId);
      if (
        !page ||
        (params.operation === "context" && params.sessionKey !== this.key(params.agentId, page.id))
      ) {
        throw new ControlPlaneAuthorizationError("Space Page unavailable");
      }
      if (params.operation === "context") {
        this.spaces.assertRun(params.agentId, params.runId, page.id);
        return {
          spaceName: scope.space.name,
          page: projectSpacePage(page),
        };
      }
      const raw = this.spaces.hasConversation(page.id)
        ? await this.gateway.request("chat.history", {
            agentId: params.agentId,
            sessionKey: this.key(params.agentId, page.id),
            limit: 20,
            ...(params.messageId
              ? { messageId: spaceText(params.messageId, "message id", 256) }
              : {}),
          })
        : { messages: [] };
      this.spaces.assertRun(params.agentId, params.runId);
      if (!this.spaces.agentScope(params.agentId).pages.some((entry) => entry.id === page.id)) {
        throw new ControlPlaneAuthorizationError("Space unavailable");
      }
      return {
        page: projectSpacePage(page, params),
        messages: projectSpaceMessages(raw),
      };
    }
    const query = spaceText(params.query, "query", 1000);
    return await this.searchSpace(scope.space, scope.pages, query, async () => {
      this.spaces.assertRun(params.agentId, params.runId);
      this.spaces.agentScope(params.agentId);
    });
  }
  async cancelRevoked(space: { id: string; agentId: string }, removedUserId: string) {
    // The membership writer captured this identity while the actor was still an Owner.
    // Self-removal must not require the removed person to retain authority afterward.
    const spaceId = space.id;
    let afterRunId: string | undefined;
    let incomplete = false;
    await this.conversations.cancelRevoked(spaceId, removedUserId).catch(() => {
      incomplete = true;
    });
    // Keyset paging visits new requests even when earlier failed cancellations
    // remain pending. Successful native acknowledgements retire their tombstones.
    for (;;) {
      const runs = this.spaces.revokedRuns(spaceId, removedUserId, afterRunId);
      if (!runs.length) {
        break;
      }
      const results = await Promise.allSettled(
        runs.map(async (row) => {
          const result = await this.gateway.request("chat.abort", {
            agentId: space.agentId,
            sessionKey: this.key(space.agentId, row.page_id),
            runId: row.run_id,
          });
          if (!isRecord(result) || result.ok !== true || typeof result.aborted !== "boolean") {
            throw new ControlPlaneStateError("Conversation cancellation outcome unavailable");
          }
          // aborted=false is the native owner's acknowledgement that no matching work remains.
          this.spaces.finishRun(row.run_id, row.page_id);
        }),
      );
      incomplete ||= results.some((result) => result.status === "rejected");
      afterRunId = runs.at(-1)!.run_id;
    }
    if (incomplete) {
      throw new ControlPlaneStateError(
        "Access removed; some running requests could not be stopped. Retry removal to stop remaining work.",
      );
    }
  }
}
