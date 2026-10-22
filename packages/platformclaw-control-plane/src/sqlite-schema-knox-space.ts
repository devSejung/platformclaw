export const KNOX_SPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS knox_space_bindings (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, room_id TEXT NOT NULL,
 space_id TEXT NOT NULL, page_id TEXT NOT NULL, generation INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','disabled')),
 UNIQUE(account_id,room_id)
) STRICT;
CREATE TABLE IF NOT EXISTS knox_space_admissions (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_id TEXT NOT NULL,
 room_id TEXT NOT NULL, knox_user_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 binding_id TEXT, user_id TEXT, space_id TEXT, session_key TEXT,
 result_json TEXT NOT NULL, target_json TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','denied','revoked','finished','failed')),
 abort_pending INTEGER NOT NULL DEFAULT 0 CHECK(abort_pending IN (0,1)),
 created_at INTEGER NOT NULL, UNIQUE(account_id,request_id)
) STRICT;
CREATE INDEX IF NOT EXISTS knox_space_admissions_owner
 ON knox_space_admissions(space_id,user_id,state);
CREATE INDEX IF NOT EXISTS knox_space_admissions_binding
 ON knox_space_admissions(binding_id,state);
`;

export type KnoxSpaceBindingRow = {
  id: string;
  account_id: string;
  room_id: string;
  space_id: string;
  page_id: string;
  generation: number;
  state: "active" | "disabled";
};

export type KnoxSpaceAdmissionRow = {
  id: string;
  account_id: string;
  request_id: string;
  room_id: string;
  knox_user_id: string;
  fingerprint: string;
  binding_id: string | null;
  user_id: string | null;
  space_id: string | null;
  session_key: string | null;
  result_json: string;
  target_json: string | null;
  state: "pending" | "denied" | "revoked" | "finished" | "failed";
  abort_pending: number;
  created_at: number;
};
