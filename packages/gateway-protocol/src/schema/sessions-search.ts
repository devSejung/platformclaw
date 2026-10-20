// Transcript search wire shapes shared by Gateway and browser clients.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Searches one agent's indexed session transcripts, optionally within selected sessions. */
export const SessionsSearchParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKeys: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 200 })),
  scope: Type.Optional(Type.Literal("agent")),
  mode: Type.Optional(Type.Literal("substring")),
  sessionId: Type.Optional(NonEmptyString),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  excludeSessionKeyPrefixes: Type.Optional(Type.Array(NonEmptyString, { maxItems: 20 })),
  query: Type.String({ minLength: 1, maxLength: 4096 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
});

/** One full-text session transcript match with follow-up provenance. */
export const SessionsSearchHitSchema = closedObject({
  sessionKey: NonEmptyString,
  sessionId: NonEmptyString,
  messageId: NonEmptyString,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  timestamp: Type.Integer({ minimum: 0 }),
  snippet: Type.String(),
  score: Type.Number(),
  title: Type.Optional(Type.String()),
});

/** Full-text search response; indexing marks a still-running first-use reconcile. */
export const SessionsSearchResultSchema = closedObject({
  results: Type.Array(SessionsSearchHitSchema),
  indexing: Type.Optional(Type.Boolean()),
  truncated: Type.Optional(Type.Boolean()),
  totalCount: Type.Optional(Type.Integer({ minimum: 0 })),
  hasMore: Type.Optional(Type.Boolean()),
});

export type SessionsSearchParams = Static<typeof SessionsSearchParamsSchema>;
export type SessionsSearchHit = Static<typeof SessionsSearchHitSchema>;
export type SessionsSearchResult = Static<typeof SessionsSearchResultSchema>;
