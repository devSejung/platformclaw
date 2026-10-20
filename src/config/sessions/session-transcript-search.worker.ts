import type { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "../../state/openclaw-agent-db-schema-helpers.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  querySessionTranscriptSubstrings,
  type SessionTranscriptSubstringParams,
} from "./session-transcript-search.js";

parentPort?.on("message", (message: { id: number; params: SessionTranscriptSubstringParams }) => {
  let response;
  let db: DatabaseSync | undefined;
  try {
    const { params } = message;
    const pathname = params.storePath
      ? resolveSqliteTargetFromSessionStorePath(params.storePath, { agentId: params.agentId }).path
      : resolveOpenClawAgentSqlitePath({
          agentId: params.agentId,
          ...(params.env ? { env: params.env } : {}),
        });
    db = openNodeSqliteDatabase(pathname, { readOnly: true });
    assertSupportedAgentSchemaVersion(db, pathname);
    assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), params.agentId, pathname);
    const result = querySessionTranscriptSubstrings(params, db);
    response = { id: message.id, result };
  } catch (error) {
    response = {
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Close before replying so session deletion never races a completed search.
    // Read-only handles avoid creating registry rows or migrating runtime state.
    db?.close();
  }
  // Node MessagePort.postMessage has a transfer list, not the browser targetOrigin contract.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort?.postMessage(response);
});
