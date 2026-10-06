import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
} from "./browser-gateway-contracts.js";
import { SPACE_RPC_PARAMS, type SpaceRole } from "./space-contracts.js";
import type { SpaceService } from "./space-service.js";
import { spaceText } from "./sqlite-spaces.js";
async function requestBrowserSpace(params: {
  service?: SpaceService;
  access: BrowserGatewayAccess;
  method: string;
  request: Record<string, unknown>;
  revalidate: () => Promise<void>;
}) {
  if (!Object.hasOwn(SPACE_RPC_PARAMS, params.method)) {
    return { handled: false } as const;
  }
  if (!params.service) {
    throw new BrowserGatewayProxyError("method-not-allowed", "Spaces unavailable");
  }
  const { service, access, request, method, revalidate } = params;
  const store = service.spaces;
  const userId = access.user.id;
  const field = (key: string, max = 128, empty = false) => spaceText(request[key], key, max, empty);
  const revision = () => {
    const value = request.expectedRevision;
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new BrowserGatewayProxyError("invalid-params", "Reload before changing this item");
    }
    return value as number;
  };
  let result: unknown;
  if (method === "platformclaw.spaces.list") {
    result = store.list(userId);
  } else if (method === "platformclaw.spaces.create") {
    result = store.create(userId, field("name", 160), field("requestId"));
    service.changed();
  } else {
    const spaceId = field("spaceId");
    if (method === "platformclaw.spaces.get") {
      result = {
        space: store.access(userId, spaceId),
        members: store.members(userId, spaceId),
        pages: store.pages(userId, spaceId),
        conversations: store.conversations(userId, spaceId),
        currentUserId: userId,
      };
    } else if (method === "platformclaw.spaces.people") {
      result = store.people(userId, spaceId, field("query", 160));
    } else if (
      method === "platformclaw.spaces.member.set" ||
      method === "platformclaw.spaces.member.remove"
    ) {
      const authorizedSpace = store.access(userId, spaceId, "owner");
      result = store.setMember(
        userId,
        spaceId,
        field("userId"),
        method.endsWith(".remove") ? null : (field("role") as SpaceRole),
        revision(),
      );
      service.changed();
      if (method.endsWith(".remove") || request.role === "viewer") {
        await service.cancelRevoked(authorizedSpace, field("userId"));
      }
    } else if (method === "platformclaw.spaces.page.create") {
      result = store.createPage(userId, spaceId, {
        title: field("title", 240),
        body: field("body", 32000, true),
        requestId: field("requestId"),
        ...(request.parentId ? { parentId: field("parentId") } : {}),
      });
      service.changed();
    } else if (method === "platformclaw.spaces.page.save") {
      result = store.savePage(
        userId,
        spaceId,
        field("pageId"),
        field("title", 240),
        field("body", 32000, true),
        revision(),
      );
      service.changed();
    } else if (method === "platformclaw.spaces.conversation.create") {
      result = await service.conversations.create(
        userId,
        spaceId,
        field("pageId"),
        field("title", 240),
        field("requestId"),
        revalidate,
      );
    } else if (method === "platformclaw.spaces.conversation.history") {
      const offset = request.offset;
      if (
        offset !== undefined &&
        (!Number.isSafeInteger(offset) || (offset as number) < 0 || request.messageId !== undefined)
      ) {
        throw new BrowserGatewayProxyError("invalid-params", "Invalid conversation history offset");
      }
      result = await service.conversations.history(
        userId,
        spaceId,
        field("conversationId"),
        revalidate,
        {
          ...(request.messageId === undefined ? {} : { messageId: field("messageId", 256) }),
          ...(offset === undefined ? {} : { offset: offset as number }),
        },
      );
    } else if (method === "platformclaw.spaces.chat.history") {
      result = await service.history(
        userId,
        spaceId,
        field("pageId"),
        revalidate,
        request.messageId === undefined ? undefined : field("messageId", 256),
      );
    } else if (method === "platformclaw.spaces.chat.send") {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Create your own conversation tab to ask your personal agent",
      );
    } else if (method === "platformclaw.spaces.search") {
      result = await service.search(userId, field("query", 1000), spaceId, revalidate);
    }
  }
  await revalidate();
  if (typeof request.spaceId === "string" && !method.endsWith("member.remove")) {
    store.access(userId, request.spaceId, method.endsWith(".people") ? "owner" : "viewer");
  }
  return { handled: true, result } as const;
}

/** Browser-local authority/lifecycle owner for the Space RPC surface. */
export class BrowserSpaceGateway {
  constructor(
    private readonly service: SpaceService | undefined,
    private readonly resolve: (token: string) => Promise<BrowserGatewayAccess>,
  ) {}
  request(
    token: string,
    access: BrowserGatewayAccess,
    method: string,
    request: Record<string, unknown>,
    context?: { isConnected?: () => boolean },
  ) {
    return requestBrowserSpace({
      service: this.service,
      access,
      method,
      request,
      revalidate: async () => {
        const current = await this.resolve(token);
        if (current.user.id !== access.user.id || context?.isConnected?.() === false) {
          throw new BrowserGatewayProxyError("unauthenticated", "Browser session changed");
        }
      },
    });
  }
  subscribe(
    terminal: () => void,
    listener: (event: import("./browser-gateway-contracts.js").BrowserGatewayEvent) => void,
  ) {
    const space = this.service?.subscribe(() =>
      listener({ event: "platformclaw.spaces.invalidated", payload: {} }),
    );
    return () => {
      terminal();
      space?.();
    };
  }
}
