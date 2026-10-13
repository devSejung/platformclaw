import { createHash } from "node:crypto";
import { ControlPlaneStateError } from "./contracts.js";

type SpaceContentRequest = {
  spaceId?: string;
  pageId?: string;
  expectedRevision: number;
  requestId: string;
};

export type SpaceContentMutation = SpaceContentRequest &
  (
    | { operation: "qa.append"; body: string }
    | { operation: "note.append"; text: string }
    | { operation: "note.replace"; oldText: string; newText: string }
  );

/** Only the Gateway proof verifier supplies this context; it is never a tool argument. */
export type SpaceContentRunContext = {
  agentId: string;
  sessionKey: string;
  runtimeRunId: string;
  admissionRunId: string;
};

export type SpaceContentMutationResult = {
  operation: SpaceContentMutation["operation"];
  spaceId: string;
  pageId: string;
  revision: number;
  postId?: string;
  requestId: string;
  receiptId: string;
  link: string;
};

export type SpaceQaPost = {
  id: string;
  spaceId: string;
  pageId: string;
  revision: number;
  body: string;
  authorId: string;
  authorName: string;
  agentId: string;
  createdAt: number;
  bodyOffset: number;
  nextBodyOffset: number | null;
  truncated: boolean;
};

export type SpaceQaList = {
  posts: SpaceQaPost[];
  revision: number;
  nextCursor: string | null;
  hasMore: boolean;
};

export type SpaceQaSearchHit = {
  kind: "qa-post";
  spaceId: string;
  spaceName: string;
  pageId: string;
  pageTitle: string;
  postId: string;
  authorId: string;
  authorName: string;
  snippet: string;
  bodyOffset: number;
  link: string;
};

export function spaceContentFields(mutation: SpaceContentMutation): string[] {
  switch (mutation.operation) {
    case "qa.append":
      return [mutation.body];
    case "note.append":
      return [mutation.text];
    case "note.replace":
      return [mutation.oldText, mutation.newText];
    default:
      throw new ControlPlaneStateError("Invalid shared Space mutation");
  }
}

/** Fixed-order protocol shared with the plugin; proof binds exact unnormalized arguments. */
export function spaceContentProofPayloadHash(mutation: SpaceContentMutation): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        mutation.operation,
        mutation.spaceId ?? null,
        mutation.pageId ?? null,
        mutation.expectedRevision,
        mutation.requestId,
        spaceContentFields(mutation),
      ]),
      "utf8",
    )
    .digest("hex");
}

export function spaceContentLink(spaceId: string, pageId: string, postId?: string): string {
  const target = postId ? `qa&post=${encodeURIComponent(postId)}` : "notes";
  return `/platformclaw/app/spaces?space=${encodeURIComponent(spaceId)}&page=${encodeURIComponent(pageId)}&tab=${target}`;
}
