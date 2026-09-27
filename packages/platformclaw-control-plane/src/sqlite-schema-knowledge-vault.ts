import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeVaultRole } from "./knowledge-vault-contracts.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

export const KNOWLEDGE_VAULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_vaults (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS knowledge_vault_members (
  vault_id TEXT NOT NULL REFERENCES knowledge_vaults(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader','editor','owner')),
  can_export INTEGER NOT NULL CHECK (can_export IN (0,1)),
  PRIMARY KEY (vault_id,user_id)
) STRICT;
CREATE INDEX IF NOT EXISTS knowledge_vault_members_user ON knowledge_vault_members(user_id);
CREATE TABLE IF NOT EXISTS knowledge_vault_connections (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL, PRIMARY KEY (user_id,vault_id)
) STRICT;
CREATE TABLE IF NOT EXISTS knowledge_vault_selections (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS knowledge_vault_documents (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES knowledge_vaults(id) ON DELETE CASCADE,
  title TEXT NOT NULL, logical_path TEXT NOT NULL, content TEXT NOT NULL,
  revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  compile_status TEXT NOT NULL CHECK (compile_status IN ('pending','ready','failed')),
  indexed_revision INTEGER, compile_error TEXT, compile_attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER, UNIQUE (vault_id,logical_path)
) STRICT;
CREATE TABLE IF NOT EXISTS knowledge_vault_chunks (
  document_id TEXT NOT NULL REFERENCES knowledge_vault_documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, content TEXT NOT NULL, title TEXT NOT NULL,
  revision INTEGER NOT NULL, PRIMARY KEY (document_id,ordinal)
) STRICT;
CREATE TABLE IF NOT EXISTS knowledge_vault_links (
  document_id TEXT NOT NULL REFERENCES knowledge_vault_documents(id) ON DELETE CASCADE,
  target_path TEXT NOT NULL, target_document_id TEXT REFERENCES knowledge_vault_documents(id),
  PRIMARY KEY (document_id,target_path)
) STRICT;
CREATE INDEX IF NOT EXISTS knowledge_vault_links_target ON knowledge_vault_links(target_document_id);
CREATE TABLE IF NOT EXISTS knowledge_vault_attachments (
  vault_id TEXT NOT NULL REFERENCES knowledge_vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL, media_type TEXT NOT NULL, content BLOB NOT NULL,
  revision INTEGER NOT NULL, PRIMARY KEY (vault_id,path)
) STRICT;
`;

/** Additive state in the control-plane database; older readers keep working. */
export function ensureKnowledgeVaultSchema(db: DatabaseSync): void {
  db.exec(KNOWLEDGE_VAULT_SCHEMA);
}

export type KnowledgeVaultDocumentRow = {
  id: string;
  vault_id: string;
  title: string;
  logical_path: string;
  content: string;
  revision: number;
  updated_at: number;
  compile_status: "pending" | "ready" | "failed";
  indexed_revision: number | null;
  compile_error: string | null;
  compile_attempts: number;
  retry_at: number | null;
};
export type KnowledgeVaultDatabase = Pick<
  ControlPlaneDatabase,
  "platform_users" | "agent_bindings"
> & {
  knowledge_vaults: {
    id: string;
    name: string;
    description: string;
    created_at: number;
    updated_at: number;
  };
  knowledge_vault_members: {
    vault_id: string;
    user_id: string;
    role: KnowledgeVaultRole;
    can_export: number;
  };
  knowledge_vault_connections: { user_id: string; vault_id: string };
  knowledge_vault_selections: { user_id: string; revision: number };
  knowledge_vault_documents: KnowledgeVaultDocumentRow;
  knowledge_vault_chunks: {
    document_id: string;
    ordinal: number;
    content: string;
    title: string;
    revision: number;
  };
  knowledge_vault_links: {
    document_id: string;
    target_path: string;
    target_document_id: string | null;
  };
  knowledge_vault_attachments: {
    vault_id: string;
    path: string;
    media_type: string;
    content: Uint8Array;
    revision: number;
  };
};
