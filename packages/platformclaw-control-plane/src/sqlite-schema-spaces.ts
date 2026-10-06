import type { DatabaseSync } from "node:sqlite";
import { runImmediateTransaction } from "./kysely-sync.js";
export const SPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS collaboration_space_deletions (
 space_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES platform_users(id),
 name TEXT NOT NULL, agent_id TEXT NOT NULL, revision INTEGER NOT NULL,
 creator_id TEXT NOT NULL REFERENCES platform_users(id), request_id TEXT NOT NULL,
 owner_ids_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('deleting','deleted')), created_at INTEGER NOT NULL,
 UNIQUE(creator_id,request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS collaboration_space_departures (
 space_id TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES platform_users(id), revision INTEGER NOT NULL,
 pending INTEGER NOT NULL CHECK(pending IN (0,1)),
 PRIMARY KEY(space_id,user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS collaboration_spaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_id TEXT NOT NULL UNIQUE,
 creator_id TEXT NOT NULL REFERENCES platform_users(id), request_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
 UNIQUE(creator_id,request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS collaboration_space_members (
 space_id TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES platform_users(id),
 role TEXT NOT NULL CHECK(role IN ('viewer','editor','owner')),
 PRIMARY KEY(space_id,user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS collaboration_space_pages (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES collaboration_space_pages(id), title TEXT NOT NULL, body TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, creator_id TEXT NOT NULL REFERENCES platform_users(id),
 request_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(creator_id,request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS collaboration_space_runs (
 run_id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL REFERENCES collaboration_space_pages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES platform_users(id), content_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','revoked','finished','failed')), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS collaboration_space_runs_actor ON collaboration_space_runs(space_id,user_id,state);
CREATE INDEX IF NOT EXISTS collaboration_space_pages_space ON collaboration_space_pages(space_id);
CREATE TABLE IF NOT EXISTS collaboration_space_conversations (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL REFERENCES collaboration_space_pages(id) ON DELETE CASCADE,
 title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES platform_users(id), owner_name TEXT NOT NULL,
 agent_id TEXT NOT NULL, session_key TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(owner_id,request_id)
) STRICT;
CREATE INDEX IF NOT EXISTS collaboration_space_conversations_space
 ON collaboration_space_conversations(space_id,created_at,id);
CREATE TABLE IF NOT EXISTS collaboration_space_conversation_titles (
 conversation_id TEXT PRIMARY KEY REFERENCES collaboration_space_conversations(id) ON DELETE CASCADE,
 requested_title TEXT NOT NULL
) STRICT;
`;
export function ensureSpaceSchema(db: DatabaseSync) {
  const ensure = () => db.exec(SPACE_SCHEMA);
  if (db.isTransaction) {
    ensure();
  } else {
    runImmediateTransaction(db, ensure);
  }
}
export type SpaceRow = {
  id: string;
  name: string;
  agent_id: string;
  creator_id: string;
  request_id: string;
  revision: number;
  created_at: number;
};
export type SpacePageRow = {
  id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  body: string;
  revision: number;
  creator_id: string;
  request_id: string;
  updated_at: number;
};
export type SpaceConversationRow = {
  id: string;
  space_id: string;
  page_id: string;
  title: string;
  owner_id: string;
  owner_name: string;
  agent_id: string;
  session_key: string;
  request_id: string;
  created_at: number;
};
