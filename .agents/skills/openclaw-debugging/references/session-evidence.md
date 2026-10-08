# Session Evidence

For a reported conversation's messages, sender attribution, or attachments,
confirm task authorization before accessing live operator state,
exporting session data, or copying attachments. Existing authorization applies;
read-only access alone does not authorize an export or upload. Keep evidence
private and redact it before sharing.

## Select the Session

Prefer the configured CLI's read paths:

```bash
openclaw sessions list --agent <agentId> --limit 25 --json
openclaw sessions tail --agent <agentId> --session-key '<session-key>' --tail 80
```

`tail` shows trajectory progress, not the full transcript. Check the bounded
list's `hasMore` and `totalCount` before concluding a session is absent.
See `docs/cli/sessions.md` and https://docs.openclaw.ai/cli/sessions.

An authorized trajectory export creates files:

```bash
openclaw sessions export-trajectory --agent <agentId> --session-key '<session-key>' --workspace <dev-workspace> --output <evidence-name> --json
```

The output stays under the selected workspace's `.openclaw/trajectory-exports/`.
Review the redacted bundle before sharing; never commit real session data.

## Inspect the Store

Identify the service account and configured state root. The default database is
`<state-dir>/agents/<agentId>/agent/openclaw-agent.sqlite`; the service user's
home may differ from the SSH user's. Do not assume root owns the running install.
Check `src/state/openclaw-agent-db.paths.ts` and
`src/state/openclaw-agent-schema.sql` against the installed version.

- `session_nodes`: `session_key`, `current_session_id`, `display_name`, `entry_json`.
  Resolve the exact key to its current session ID; do not treat a URL slug or
  short hex fragment as a complete key. Check the route contract in
  `packages/session-url-contract/src/` when resolving a browser link.
- `transcript_events`: `session_id`, `seq`, `event_json`, `created_at`.
  Read bounded pages ordered by `seq`. Events can include non-message records;
  inspect `event_json.message` only when present.
- `session_transcript_fts`: searchable text with `session_id`, `message_id`,
  `role`, and `timestamp`; retrieve matching raw events for context.

Node's built-in SQLite module supports scoped read-only queries (Bash example):

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.argv[1],{readOnly:true});
try { console.log(JSON.stringify(db.prepare(
  "SELECT seq,event_json FROM transcript_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 100"
).all(process.argv[2],Number(process.argv[3])))); } finally { db.close(); }' \
  '<db-path>' '<session-id>' -1
```

Use the last returned `seq` for the next page. Never write live Gateway state or
run maintenance to obtain evidence. Realistic-data experiments use an authorized,
consistent SQLite snapshot in an isolated dev state directory.

## Read Provenance and Media

- Message content may be text or parts. Inspect the whole stored message.
- Sender fields in `message.__openclaw` include `senderId`, `senderName`,
  `senderProfileId`, `senderUsername`, and `senderIsOwner` when supplied.
  The envelope can also exist on synthetic inputs; its presence or absence
  does not establish human authorship. Check `message.provenance.kind`
  (`external_user`, `inter_session`, `internal_system`), source fields, and the
  producing boundary. Missing provenance is inconclusive. See
  `src/sessions/input-provenance.ts` and `src/sessions/user-turn-transcript.ts`.
- Check `message.__openclaw.media[]` even when content has no image part.
  Facts can contain `path`, `url`, `contentType`, `kind`, and `fileName`.
  `media://inbound/<file>` resolves under the configured media root's `inbound/`;
  the default is `<state-dir>/media/inbound/<file>`. Resolve config overrides
  and validate containment rather than opening arbitrary message-supplied paths.
  Inspect only attachments relevant to the report. See
  `src/media/media-facts.ts`, `src/media/media-reference.ts`, and `src/media/store.ts`.
