import type { RouteLocation } from "@openclaw/uirouter";
import type { ApplicationContext } from "../app/context.ts";
import { sessionNavigationTarget } from "./sessions/route-navigation.ts";

export type SessionSearchTarget = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  query: string;
};

// Keep the excerpt query in the fragment: navigation needs it for highlighting,
// but HTTP requests and reverse-proxy access logs do not.
export function sessionSearchTargetFromLocation(
  location: Pick<RouteLocation, "hash">,
  sessionKey: string,
): SessionSearchTarget | undefined {
  const params = new URLSearchParams(location.hash?.replace(/^#/, ""));
  const sessionId = params.get("transcript");
  const messageId = params.get("message");
  const query = params.get("find") ?? "";
  return sessionId && messageId && sessionId.length <= 512 && messageId.length <= 512
    ? { sessionKey, sessionId, messageId, query: query.slice(0, 4096) }
    : undefined;
}

export function navigateToSessionSearchHit<TRouteId extends string>(
  context: ApplicationContext<TRouteId>,
  target: SessionSearchTarget,
): void {
  const navigation = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: target.sessionKey,
  });
  const hash = new URLSearchParams({
    transcript: target.sessionId,
    message: target.messageId,
    find: target.query.slice(0, 4096),
  });
  const fragment = `#${hash}`;
  if (
    globalThis.location?.pathname === navigation.options.pathname &&
    globalThis.location?.search === (navigation.options.search ?? "") &&
    globalThis.location?.hash === fragment
  ) {
    // Selecting the same result again must replay its message reveal even
    // though the router's location and cached loader match have not changed.
    void context.revalidate("chat" as TRouteId);
    return;
  }
  context.navigate("chat" as TRouteId, { ...navigation.options, hash: fragment });
}
