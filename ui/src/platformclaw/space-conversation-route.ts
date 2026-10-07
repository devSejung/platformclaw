import { notFound, redirect, type RouteLocation } from "@openclaw/uirouter";
import {
  isSpaceConversationSession,
  type SpaceConversationRoute,
  type SpaceConversation,
  type SpacePage,
} from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import { INTERNAL_SESSION_PATH_PARAM, pathForRoute } from "../app-route-paths.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { waitForGatewayClient } from "../app/gateway-readiness.ts";
import type { BoardFace } from "../lib/board/settings.ts";
import { SESSION_NAVIGATION_KEY_PARAM } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { sessionKeyUuid, type ChatRouteContext } from "../pages/chat/route-loader-short-cache.ts";
import { requestSpaceGateway } from "./space-gateway-request.ts";

/** Released chat links resolve through the owning Space, never through native chat rendering. */
export async function loadPlatformClawChatRoute(
  context: ChatRouteContext,
  location: RouteLocation,
  face: BoardFace,
  signal: AbortSignal,
) {
  const search = new URLSearchParams(location.search);
  const pathname = search.get(INTERNAL_SESSION_PATH_PARAM) ?? location.pathname;
  const target = sessionRefFromPath(pathname, context.basePath);
  const carriedKey = search.get(SESSION_NAVIGATION_KEY_PARAM);
  const hintedKey =
    target?.kind === "short" &&
    carriedKey &&
    parseAgentSessionKey(carriedKey)?.agentId === target.agentId &&
    sessionKeyUuid(carriedKey)?.startsWith(target.shortId)
      ? carriedKey
      : null;
  const key =
    target?.kind === "literal"
      ? target.sessionKey
      : target?.kind === "short"
        ? hintedKey
        : pathname === pathForRoute(face, context.basePath)
          ? search.get("session")
          : null;
  const exactKey = key && isSpaceConversationSession(key) ? key : null;
  const { loadChatRoute } = await import("../pages/chat/route-loader.ts");
  const lookup = exactKey
    ? { sessionKey: exactKey }
    : target?.kind === "short"
      ? { agentId: target.agentId, shortId: target.shortId }
      : null;
  if (!lookup || (target && target.namespace !== face)) {
    return loadChatRoute(context, location, face, signal);
  }
  await waitForGatewayClient(context.gateway, signal);
  signal.throwIfAborted();
  const [conversation, ordinary] = await Promise.all([
    requestSpaceGateway<SpaceConversationRoute | null>(
      () => context,
      "conversation.resolve",
      lookup,
    ),
    exactKey ? Promise.resolve(null) : loadChatRoute(context, location, face, signal),
  ]);
  signal.throwIfAborted();
  if (!conversation) {
    return ordinary ?? notFound({ routeId: face });
  }
  // A short prefix shared with an ordinary session is ambiguous. Never let
  // removal from sessions.list turn that link into a different conversation.
  if (ordinary && !("type" in ordinary && ordinary.type === "notFound")) {
    return notFound({ routeId: face });
  }
  return redirect({
    pathname: pathForRoute("spaces", context.basePath),
    search: `?${new URLSearchParams({
      space: conversation.spaceId,
      page: conversation.pageId,
      conversation: conversation.conversationId,
    })}`,
    hash: "",
  });
}

type SpaceSelectionTarget =
  | { spaceId: string | null }
  | { page: SpacePage; conversation: SpaceConversation | null; messageId: string }
  | { conversation: SpaceConversation | null };

/** Parent changes retire descendant selections; same-Space refreshes preserve their deep link. */
export function spaceSelectionUrl(target: SpaceSelectionTarget): URL {
  const url = new URL(location.href);
  const search = url.searchParams;
  if ("spaceId" in target) {
    if (target.spaceId === null || search.get("space") !== target.spaceId) {
      for (const key of ["space", "page", "conversation", "message"]) {
        search.delete(key);
      }
    }
    if (target.spaceId !== null) {
      search.set("space", target.spaceId);
    }
  } else {
    if ("page" in target) {
      search.set("space", target.page.spaceId);
      search.set("page", target.page.id);
    }
    search.set("conversation", target.conversation?.id ?? "shared");
    if ("messageId" in target && target.messageId) {
      search.set("message", target.messageId);
    } else {
      search.delete("message");
    }
  }
  return url;
}

export function replaceSpaceSelection(
  context: Pick<ApplicationContext<"spaces">, "replace">,
  url: URL,
): void {
  if (url.search !== location.search || url.hash !== location.hash) {
    context.replace("spaces", { search: url.search, hash: url.hash });
  }
}

export function spaceRouteMatchesSelection(
  search: string | undefined,
  spaceId: string | undefined,
  pageId: string | undefined,
  conversationId: string | undefined,
  messageId: string,
): boolean {
  if (search === undefined) {
    return true;
  }
  const route = new URLSearchParams(search);
  return (
    route.get("space") === (spaceId ?? null) &&
    route.get("page") === (pageId ?? null) &&
    (route.get("conversation") ?? "shared") === (conversationId ?? "shared") &&
    (route.get("message") ?? "") === messageId
  );
}
