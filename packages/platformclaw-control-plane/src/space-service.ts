import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserGatewayRpc, BrowserGatewayEvent } from "./browser-gateway-contracts.js";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { SpacePage } from "./space-contracts.js";
import { spaceText, type SqliteSpaceStore } from "./sqlite-spaces.js";
import type { SqliteControlPlaneStore } from "./sqlite-store.js";

export type SpaceMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number | null;
  authorId: string | null;
  authorName: string | null;
};
export function projectSpaceMessages(value: unknown): SpaceMessage[] {
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
        text: text.slice(0, 16000),
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

function toolSourceMessages(messages: SpaceMessage[], messageId?: string) {
  const index = messageId ? messages.findIndex((message) => message.id === messageId) : -1;
  if (messageId && index < 0) {
    throw new ControlPlaneStateError(
      "Requested source message is unavailable; open the shared issue",
    );
  }
  const window = messageId ? messages.slice(Math.max(0, index - 3), index + 5) : messages.slice(-8);
  return window.map((message) =>
    Object.assign({}, message, {
      text: message.text.slice(0, 1200),
      truncated: message.text.length > 1200,
    }),
  );
}

/** Space is the authority; Gateway sessions own transcript storage and run scheduling. */
export class SpaceService {
  readonly spaces: SqliteSpaceStore;
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
  private readonly preparing = new Map<string, Promise<void>>();
  constructor(
    readonly store: SqliteControlPlaneStore,
    private readonly gateway: BrowserGatewayRpc,
    private readonly admin: GatewayAdminRpc,
    private readonly runtimeReady = true,
  ) {
    this.spaces = store.spaces;
  }
  private key(agentId: string, pageId: string) {
    return `agent:${agentId}:space:${pageId}`;
  }
  private async ensureAgent(agentId: string) {
    let pending = this.preparing.get(agentId);
    if (!pending) {
      pending = this.admin
        .call("platformclaw.space.ensureAgent", { agentId })
        .then((result) => {
          if (!isRecord(result) || result.agentId !== agentId || result.ready !== true) {
            throw new ControlPlaneStateError("Space agent provisioning unavailable; retry");
          }
        })
        .finally(() => this.preparing.delete(agentId));
      this.preparing.set(agentId, pending);
    }
    await pending;
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
  async send(
    userId: string,
    spaceId: string,
    pageId: string,
    message: string,
    requestId: string,
    model: string | undefined,
    revalidate: () => Promise<void>,
  ) {
    if (!this.runtimeReady) {
      throw new ControlPlaneStateError(
        "Space conversations require the configured internal agent service; ask an administrator to enable the existing execution handoff service",
      );
    }
    spaceText(message, "message", 16000);
    spaceText(requestId, "request id", 128);
    const space = this.spaces.access(userId, spaceId, "editor");
    const page = this.spaces.page(userId, spaceId, pageId, "editor");
    await this.ensureAgent(space.agentId);
    await revalidate();
    this.spaces.access(userId, spaceId, "editor");
    if (model !== undefined) {
      spaceText(model, "model", 256);
      const raw = await this.gateway.request("models.list", { view: "configured" });
      if (
        !isRecord(raw) ||
        !Array.isArray(raw.models) ||
        !raw.models.some(
          (item) =>
            isRecord(item) &&
            typeof item.id === "string" &&
            ((typeof item.provider === "string" && `${item.provider}/${item.id}` === model) ||
              item.id === model),
        )
      ) {
        throw new ControlPlaneStateError("Choose a configured model");
      }
    }
    await revalidate();
    this.spaces.page(userId, spaceId, pageId, "editor");
    const user = await this.store.getUserById(userId);
    if (!user || user.status !== "active") {
      throw new ControlPlaneAuthorizationError("Space unavailable");
    }
    // Model selection belongs to this shared session; no personal provider account is imported.
    const key = this.key(space.agentId, pageId);
    await this.gateway.request("sessions.resolve", { key, agentId: space.agentId });
    if (model) {
      await this.gateway.request("sessions.patch", { key, agentId: space.agentId, model });
    }
    await revalidate();
    this.spaces.page(userId, spaceId, pageId, "editor");
    const runId = `space:${page.id}:${userId}:${requestId}`;
    if (this.spaces.beginRun(userId, spaceId, pageId, runId, message)) {
      return { status: "ok", replayed: true };
    }
    let result: unknown;
    try {
      result = await this.gateway.request("chat.send", {
        agentId: space.agentId,
        sessionKey: key,
        message,
        deliver: false,
        suppressCommandInterpretation: true,
        queueMode: "followup",
        idempotencyKey: runId,
        senderAttribution: {
          id: user.accountId,
          name: user.displayName ?? user.accountId,
          profileId: user.id,
          agentId: space.agentId,
        },
      });
    } catch (error) {
      // An interrupted response can follow admission. Fence tool reads first, then cancel the
      // known native run identity; rejected sends must not exhaust the active-run quota.
      this.spaces.failRun(runId);
      await this.gateway
        .request("chat.abort", { agentId: space.agentId, sessionKey: key, runId })
        .catch(() => undefined);
      throw error;
    }
    try {
      await revalidate();
      this.spaces.access(userId, spaceId, "editor");
    } catch (error) {
      await this.gateway
        .request("chat.abort", { agentId: space.agentId, sessionKey: key, runId })
        .catch(() => undefined);
      throw error;
    }
    if (!isRecord(result)) {
      throw new ControlPlaneStateError("Conversation send outcome unavailable");
    }
    if (result.status === "ok" || result.status === "error") {
      this.spaces.finishRun(runId);
    }
    return { status: typeof result.status === "string" ? result.status : "accepted" };
  }
  async search(
    userId: string,
    query: string,
    spaceId: string | undefined,
    revalidate: () => Promise<void>,
  ) {
    spaceText(query, "query", 1000);
    const spaces = spaceId ? [this.spaces.access(userId, spaceId)] : this.spaces.list(userId);
    let indexing = false;
    const results: Array<{
      spaceId: string;
      spaceName: string;
      pageId: string;
      pageTitle: string;
      messageId?: string;
      snippet: string;
      link: string;
    }> = [];
    for (const space of spaces) {
      const pages = this.spaces.pages(userId, space.id);
      if (!pages.length) {
        continue;
      }
      const keys = new Map(
        pages
          .filter((page) => this.spaces.hasConversation(page.id))
          .map((page) => [this.key(space.agentId, page.id), page]),
      );
      const raw = keys.size
        ? await this.gateway.request("sessions.search", {
            agentId: space.agentId,
            sessionKeys: [...keys.keys()],
            query,
            limit: 10,
          })
        : { results: [] };
      await revalidate();
      this.spaces.access(userId, space.id);
      const add = (page: SpacePage, snippet: string, messageId?: string) =>
        results.push({
          spaceId: space.id,
          spaceName: space.name,
          pageId: page.id,
          pageTitle: page.title,
          snippet: snippet.slice(0, 1200),
          ...(messageId ? { messageId } : {}),
          link: `/platformclaw/app/spaces?space=${encodeURIComponent(space.id)}&page=${encodeURIComponent(page.id)}${messageId ? `&message=${encodeURIComponent(messageId)}` : ""}`,
        });
      for (const page of pages) {
        if (`${page.title}\n${page.body}`.toLowerCase().includes(query.toLowerCase())) {
          add(page, page.body);
        }
      }
      if (!isRecord(raw) || !Array.isArray(raw.results)) {
        throw new ControlPlaneStateError("Space search unavailable; retry");
      }
      indexing ||= raw.indexing === true;
      for (const hit of raw.results) {
        if (
          !isRecord(hit) ||
          typeof hit.sessionKey !== "string" ||
          typeof hit.snippet !== "string"
        ) {
          continue;
        }
        const page = keys.get(hit.sessionKey);
        if (page) {
          add(page, hit.snippet, typeof hit.messageId === "string" ? hit.messageId : undefined);
        }
      }
    }
    await revalidate();
    for (const space of spaces) {
      this.spaces.access(userId, space.id);
    }
    return { results: results.slice(0, 20), indexing };
  }
  observe(event: BrowserGatewayEvent) {
    if (
      event.event !== "chat" ||
      !isRecord(event.payload) ||
      !["final", "aborted", "error"].includes(String(event.payload.state)) ||
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
  async agentRead(params: {
    agentId: string;
    operation: string;
    query?: string;
    spaceId?: string;
    pageId?: string;
    sessionKey?: string;
    runId?: string;
    messageId?: string;
  }) {
    const sharedId = this.spaces.spaceForAgent(params.agentId);
    if (!sharedId) {
      const userId = this.spaces.userForAgent(params.agentId);
      if (params.operation === "search") {
        return await this.search(
          userId,
          spaceText(params.query, "query", 1000),
          params.spaceId,
          async () => {
            this.spaces.userForAgent(params.agentId);
          },
        );
      }
      const spaceId = spaceText(params.spaceId, "space id", 128);
      const pageId = spaceText(params.pageId, "page id", 128);
      const page = this.spaces.page(userId, spaceId, pageId);
      const history = await this.history(
        userId,
        spaceId,
        pageId,
        async () => {
          this.spaces.userForAgent(params.agentId);
        },
        params.messageId,
      );
      return {
        page: { ...page, body: page.body.slice(0, 8000), truncated: page.body.length > 8000 },
        messages: toolSourceMessages(history.messages, params.messageId),
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
        return {
          spaceName: scope.space.name,
          page: {
            id: page.id,
            title: page.title,
            body: page.body.slice(0, 8000),
            revision: page.revision,
            truncated: page.body.length > 8000,
          },
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
        page: { ...page, body: page.body.slice(0, 8000), truncated: page.body.length > 8000 },
        messages: toolSourceMessages(projectSpaceMessages(raw), params.messageId),
      };
    }
    const query = spaceText(params.query, "query", 1000);
    if (!scope.pages.length) {
      return { results: [] };
    }
    const keys = new Map(scope.pages.map((page) => [this.key(params.agentId, page.id), page]));
    const raw = await this.gateway.request("sessions.search", {
      agentId: params.agentId,
      sessionKeys: [...keys.keys()],
      query,
      limit: 10,
    });
    if (!isRecord(raw) || !Array.isArray(raw.results)) {
      throw new ControlPlaneStateError("Space search unavailable");
    }
    this.spaces.assertRun(params.agentId, params.runId);
    this.spaces.agentScope(params.agentId);
    const results = raw.results.flatMap((hit) => {
      if (!isRecord(hit) || typeof hit.sessionKey !== "string" || typeof hit.snippet !== "string") {
        return [];
      }
      const page = keys.get(hit.sessionKey);
      return page
        ? [
            {
              spaceId: sharedId,
              spaceName: scope.space.name,
              pageId: page.id,
              pageTitle: page.title,
              snippet: hit.snippet.slice(0, 1200),
              messageId: typeof hit.messageId === "string" ? hit.messageId : null,
              link: `/platformclaw/app/spaces?space=${sharedId}&page=${page.id}${typeof hit.messageId === "string" ? `&message=${encodeURIComponent(hit.messageId)}` : ""}`,
            },
          ]
        : [];
    });
    return { results, indexing: raw.indexing === true };
  }
  async cancelRevoked(space: { id: string; agentId: string }, removedUserId: string) {
    // The membership writer captured this identity while the actor was still an Owner.
    // Self-removal must not require the removed person to retain authority afterward.
    const spaceId = space.id;
    const results = await Promise.allSettled(
      this.spaces.revokedRuns(spaceId, removedUserId).map((row) =>
        this.gateway.request("chat.abort", {
          agentId: space.agentId,
          sessionKey: this.key(space.agentId, row.page_id),
          runId: row.run_id,
        }),
      ),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new ControlPlaneStateError(
        "Access removed; some running requests could not be stopped. Retry removal to stop remaining work.",
      );
    }
  }
}
