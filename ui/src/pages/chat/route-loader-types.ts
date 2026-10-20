import type { RouteLocation } from "@openclaw/uirouter";
import type { BoardFace } from "../../lib/board/settings.ts";
import type { SessionSearchTarget } from "../../lib/session-search-navigation.ts";

export type SessionCandidate = {
  agentId: string;
  displayName: string;
  href: string;
  idPrefix: string;
};

export type ChatRouteData =
  | {
      kind: "session";
      sessionKey: string;
      agentId?: string;
      draft?: string;
      focusComposer?: boolean;
      searchTarget?: SessionSearchTarget;
      face: BoardFace;
      shortId?: string;
      canonicalLocation?: RouteLocation;
      canonicalLocationReady?: Promise<RouteLocation | null>;
      canonicalLocationSource?: RouteLocation;
    }
  | {
      kind: "ambiguous";
      shortId: string;
      candidates: SessionCandidate[];
      truncated: boolean;
      face: BoardFace;
    };

export type SessionChatRouteData = Omit<
  Extract<ChatRouteData, { kind: "session" }>,
  "face" | "kind"
> & {
  face?: BoardFace;
  kind?: "session";
};
