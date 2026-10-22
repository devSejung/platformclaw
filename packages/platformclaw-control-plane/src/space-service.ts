import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { BrowserGatewayRpc, BrowserGatewayEvent } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { revalidateKnoxSpaceRun } from "./knox-self-in-space-service.js";
import { spaceContentLink } from "./space-content-contracts.js";
import { mutateSpaceContent } from "./space-content-service.js";
import { isSpaceConversationSession, type Space, type SpacePage } from "./space-contracts.js";
import { SpaceConversationService } from "./space-conversation-service.js";
import { SpaceLifecycleService } from "./space-lifecycle-service.js";
import {
  SpaceNativeSessionGuard,
  type SpaceNativeSessionRequest,
} from "./space-native-session-guard.js";
import {
  projectSpaceMessages,
  projectSpacePage,
  projectSpaceRecallResult,
  validateSpaceRecallWindow,
  type SpaceRecallWindow,
} from "./space-recall-projection.js";
import { spaceText, type SqliteSpaceStore } from "./sqlite-spaces.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

// One agent query shares this work budget across Spaces and both transcript paths.
// Bounded output alone would still permit thousands of sequential history reads.
const SPACE_SEARCH_LOOKUP_LIMIT = 40;
function normalizeSpaceSearchQuery(query: unknown): string {
  return spaceText(query, "query", 1000).trim().replace(/\s+/gu, " ");
}

type SpaceAgentReadParams = SpaceRecallWindow &
  Partial<Omit<SpaceNativeSessionRequest, "agentId" | "sessionKey">> & {
    agentId: string;
    query?: string;
    authorName?: string;
    authorId?: string;
    spaceId?: string;
    pageId?: string;
    sessionKey?: string;
    runId?: string;
    bodyOffset?: number;
    pageRevision?: number;
    conversationId?: string;
    view?: "page" | "qa";
    postId?: string;
    qaCursor?: string;
  };

export type { SpaceMessage } from "./space-recall-projection.js";

/** Space is the authority; Gateway sessions own transcript storage and run scheduling. */
export class SpaceService {
  readonly spaces: SqliteSpaceStore;
  readonly conversations: SpaceConversationService;
  private readonly nativeSessions: SpaceNativeSessionGuard;
  private readonly listeners = new Set<() => void>();
  readonly lifecycle: SpaceLifecycleService;
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
    this.lifecycle = new SpaceLifecycleService(
      this.spaces,
      gateway,
      this.conversations,
      () => this.changed(),
      (space, userId) => this.cancelRevoked(space, userId),
    );
  }
  private key(agentId: string, pageId: string) {
    return `agent:${agentId}:space:${pageId}`;
  }
  async agentMutation(input: Parameters<typeof mutateSpaceContent>[2]) {
    const result = await mutateSpaceContent(this.store, this.gateway, input);
    this.changed();
    return result;
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
    userId?: string,
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
      snippet: truncateUtf16Safe(snippet, 1200),
      ...(messageId ? { messageId } : {}),
      link: `/platformclaw/app/spaces?space=${encodeURIComponent(space.id)}&page=${encodeURIComponent(page.id)}${messageId ? `&message=${encodeURIComponent(messageId)}` : ""}`,
    });
    // Notes have no transcript until the first send. Search both owned sources for every caller.
    const terms = query
      .split(" ")
      .map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
    const notes = pages.flatMap((page) => {
      // Match on original text: case folding can change UTF-16 length and corrupt read offsets.
      // Every keyword must occur in the note, matching the transcript search's AND semantics.
      const matches = terms.map((term) => term.exec(page.body)?.index ?? -1);
      if (!terms.every((term, index) => matches[index]! >= 0 || term.test(page.title))) {
        return [];
      }
      const match = Math.min(...matches.filter((index) => index >= 0));
      const hasBodyMatch = Number.isFinite(match);
      const bodyOffset = hasBodyMatch
        ? truncateUtf16Safe(page.body, Math.max(0, match - 120)).length
        : 0;
      const snippet = hasBodyMatch ? page.body.slice(bodyOffset) : page.title;
      return [
        {
          ...source(page, snippet),
          kind: "notes" as const,
          link: spaceContentLink(space.id, page.id),
          bodyOffset,
          pageRevision: page.revision,
        },
      ];
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
    // The shared budget limits Gateway history lookups. Local posts, like
    // Notes, stay within the bounded Space scope without spending that budget.
    const posts = userId ? this.spaces.content.searchQa(userId, space.id, query) : [];
    const results = [...notes, ...posts, ...conversations];
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
    const normalizedQuery = normalizeSpaceSearchQuery(query);
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
          normalizedQuery,
          async () => {
            await revalidate();
            this.spaces.access(userId, space.id);
          },
          budget,
          userId,
        ),
      );
      if (includePersonalConversations) {
        const personal = await this.conversations.search(
          userId,
          space.id,
          normalizedQuery,
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
    const knoxAuthorization = revalidateKnoxSpaceRun(this.store, params);
    if (knoxAuthorization) {
      await knoxAuthorization;
    }
    if (params.operation === "native") {
      if (typeof params.nativeTool !== "string" || typeof params.broad !== "boolean") {
        throw new ControlPlaneStateError("Invalid native session authorization request");
      }
      const result = await this.nativeSessions.authorize({
        ...params,
        nativeTool: params.nativeTool,
        broad: params.broad,
      });
      const refreshedAuthorization = revalidateKnoxSpaceRun(this.store, params);
      if (refreshedAuthorization) {
        await refreshedAuthorization;
      }
      return result;
    }
    validateSpaceRecallWindow(params);
    if (params.authorName !== undefined || params.authorId !== undefined) {
      if (
        params.operation !== "search" ||
        (params.authorName !== undefined && params.authorId !== undefined)
      ) {
        throw new ControlPlaneStateError("Use one authorName or authorId filter for Space search");
      }
      if (params.authorName !== undefined) {
        spaceText(params.authorName, "author name", 240);
      }
      if (params.authorId !== undefined) {
        spaceText(params.authorId, "author id", 128);
      }
    }
    const result = await this.readAgentScope(params);
    return params.operation === "get" &&
      params.view === "qa" &&
      (("post" in result && isRecord(result.post)) ||
        ("posts" in result && Array.isArray(result.posts)))
      ? result
      : projectSpaceRecallResult(result, params);
  }

  private async searchAuthor(
    userId: string,
    params: SpaceAgentReadParams,
    spaceId: string | undefined,
    revalidate: () => Promise<void>,
  ) {
    const query = params.query === undefined ? undefined : normalizeSpaceSearchQuery(params.query);
    const scope = spaceId
      ? { spaces: [this.spaces.access(userId, spaceId)], hasMore: false }
      : this.spaces.recallScope(userId);
    if (scope.hasMore && params.authorName !== undefined) {
      throw new ControlPlaneStateError(
        "Author name search spans more than 100 Spaces; provide a spaceId to resolve the author safely",
      );
    }
    const { spaces } = scope;
    const authors = new Map<
      string,
      { authorId: string; authorName: string; spaceName: string; conversationTitle: string }
    >();
    const name = params.authorName?.trim().toLowerCase();
    const authorSpaces = new Map<string, Set<string>>();
    const rememberSpace = (authorId: string, matchingSpaceId: string) => {
      const matches = authorSpaces.get(authorId) ?? new Set<string>();
      matches.add(matchingSpaceId);
      authorSpaces.set(authorId, matches);
    };
    for (const space of spaces) {
      for (const conversation of this.spaces.sharedConversations(userId, space.id)) {
        if (
          params.authorId !== undefined
            ? conversation.ownerId === params.authorId.trim()
            : conversation.ownerName.toLowerCase().includes(name!)
        ) {
          rememberSpace(conversation.ownerId, space.id);
          if (!authors.has(conversation.ownerId)) {
            authors.set(conversation.ownerId, {
              authorId: conversation.ownerId,
              authorName: conversation.ownerName,
              spaceName: space.name,
              conversationTitle: conversation.title,
            });
          }
        }
      }
      const postAuthors = this.spaces.content.qaAuthors(userId, space.id, params.authorId?.trim());
      if (params.authorName !== undefined && postAuthors.length > 200) {
        throw new ControlPlaneStateError(
          "Shared Q&A author names exceed the discovery window; use an exact returned authorId",
        );
      }
      for (const author of postAuthors) {
        if (
          params.authorId !== undefined
            ? author.id === params.authorId.trim()
            : author.name.toLowerCase().includes(name!)
        ) {
          rememberSpace(author.id, space.id);
          if (!authors.has(author.id)) {
            authors.set(author.id, {
              authorId: author.id,
              authorName: author.name,
              spaceName: space.name,
              conversationTitle: "Shared Q&A",
            });
          }
        }
      }
    }
    // Resolve identity across the whole authorized scope before reading any transcript.
    // Identical display names never silently select the first person's conversation.
    await revalidate();
    for (const space of spaces) {
      this.spaces.access(userId, space.id);
    }
    if (authors.size > 1) {
      return {
        results: [],
        indexing: false,
        ambiguousAuthor: true,
        authors: [...authors.values()],
      };
    }
    const author = authors.values().next().value;
    if (!author) {
      return { results: [], indexing: false, windowLimited: scope.hasMore };
    }
    const results: Array<Record<string, unknown>> = [];
    const budget = { remaining: SPACE_SEARCH_LOOKUP_LIMIT };
    let indexing = false;
    let windowLimited = scope.hasMore;
    for (const space of spaces) {
      // Identity discovery already located this author's sources. Empty Spaces
      // must not consume the provider work budget or hide a later source.
      if (!authorSpaces.get(author.authorId)?.has(space.id)) {
        continue;
      }
      if (budget.remaining <= 0) {
        windowLimited = true;
        break;
      }
      results.push(
        ...this.spaces.content
          .searchQa(userId, space.id, query ?? "", author.authorId)
          .slice(0, 21 - results.length),
      );
      if (results.length >= 21) {
        break;
      }
      if (query === undefined) {
        // Identity resolution above scans the whole scope; source expansion only
        // needs the candidate window plus one sentinel to report truncation.
        results.push(
          ...this.conversations.sources(userId, space.id, author.authorId, 21 - results.length),
        );
        if (results.length >= 21) {
          break;
        }
      } else {
        const match = await this.conversations.search(
          userId,
          space.id,
          query,
          revalidate,
          budget,
          author.authorId,
        );
        results.push(...match.results);
        indexing ||= match.indexing;
        windowLimited ||= match.windowLimited;
      }
    }
    await revalidate();
    for (const space of spaces) {
      this.spaces.access(userId, space.id);
    }
    return {
      results: results.slice(0, 20),
      indexing,
      windowLimited: windowLimited || results.length > 20,
      ...(query === undefined && !results.some((item) => item.kind === "qa-post")
        ? { discoveryOnly: true }
        : {}),
    };
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
        const authorization = revalidateKnoxSpaceRun(this.store, params);
        if (authorization) {
          await authorization;
        }
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
          sharedQaRevision: this.spaces.content.qaRevision(userId, space.id, registered.pageId),
        };
      }
      if (params.operation === "search") {
        if (params.authorName !== undefined || params.authorId !== undefined) {
          return this.searchAuthor(
            userId,
            params,
            registered?.spaceId ?? params.spaceId,
            revalidate,
          );
        }
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
      const sharedQaRevision = this.spaces.content.qaRevision(userId, spaceId, pageId);
      if (params.view === "qa") {
        return params.postId
          ? {
              revision: sharedQaRevision,
              post: this.spaces.content.getQa(
                userId,
                spaceId,
                pageId,
                params.postId,
                params.bodyOffset,
                params.bodyLimitBytes,
              ),
            }
          : this.spaces.content.listQa(
              userId,
              spaceId,
              pageId,
              params.qaCursor,
              params.limit ?? 5,
              (params.limit ?? 5) > 5 ? 16 * 1024 : 8 * 1024,
            );
      }
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
          sharedQaRevision,
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
        sharedQaRevision,
        messages: history.messages,
      };
    }
    if (params.authorName !== undefined || params.authorId !== undefined) {
      throw new ControlPlaneStateError(
        "Author search requires a personal agent; search issue keywords here",
      );
    }
    if (params.spaceId && params.spaceId !== sharedId) {
      throw new ControlPlaneAuthorizationError("Space unavailable");
    }
    if (params.view === "qa") {
      throw new ControlPlaneStateError("Saved Q&A post reads require a personal agent");
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
    const query = normalizeSpaceSearchQuery(params.query);
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
    this.store.knoxSpaces.acknowledgeSpaceCancellation(spaceId, removedUserId);
  }
}
