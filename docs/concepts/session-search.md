---
summary: "Search past session transcripts and reopen the matching context"
title: "Session search"
read_when:
  - You need to find something discussed in an earlier session
  - You want to understand session search privacy or indexing
---

# Session search

`sessions_search` searches the user and assistant text in your own past sessions. Each result
includes a `sessionKey`, timestamp, role, and a short matching excerpt. Pass the returned
`sessionKey` to `sessions_history` when you need the surrounding conversation.

## Find conversations in the Control UI

Use the existing magnifying glass or **Ctrl+K** (**Cmd+K** on macOS) to search
conversation titles and message text. The search dialog opens on demand and
does not add a permanent sidebar panel. Results include archived conversations
within your selected Agent scope. Selecting a message opens its surrounding
conversation in chat, even when that thread normally opens as a dashboard.

Inside a conversation, **Ctrl+F** (**Cmd+F** on macOS) searches the stored user
and assistant messages, including older messages that have not been loaded on
screen. **Enter** moves to the next matching message; **Shift+Enter** moves to
the previous one. The counter counts matching messages. **Escape** closes find
and restores the previous input focus without changing your draft.

Both UI searches match literal text fragments, including two-character Korean
queries such as `배포`. Surrounding messages remain visible and matching text is
highlighted. Tool results, reasoning, and image contents are outside this search.
Indexing notices indicate incomplete results; a failed request offers a retry.
The agent-facing `sessions_search` tool retains its exact-token search behavior.

## Visibility and output

Search uses the same session visibility rules as `sessions_history`. Results outside the caller's
visible session tree are removed before result limits are applied. Sandboxed agents remain limited
to sessions they spawned when spawned-session visibility is enabled.

Excerpts are redacted before they return to the model. Results are also bounded by count, excerpt
length, and total response size.

## Index lifecycle

OpenClaw stores a full-text index next to the transcript rows in each agent's SQLite database.
New user and assistant messages are indexed in the same transaction that persists them, so the
index never lags live conversations; tool results, reasoning blocks, and images are excluded.
Only the transcript's active branch is searchable.

Transcripts that predate the index (for example, sessions imported by `openclaw doctor`) and
sessions whose active branch was rewound are reindexed by a background reconciliation that starts
with the next search. A response with `indexing: true` can therefore be incomplete; retry after
indexing finishes. Deleting a session removes its index entries in the same transaction.

The agent-facing search uses SQLite's Unicode word tokenizer with diacritic removal.
Control UI literal searches read the same stored text through a separate read-only worker;
they do not require an external search service or a second transcript store.

## Session search vs. memory search

Use `sessions_search` for exact words or phrases from raw session transcripts. Use
[`memory_search`](/concepts/memory-search) for durable memory files and semantic recall. The
experimental session-memory corpus is the semantic complement to this exact transcript search.
