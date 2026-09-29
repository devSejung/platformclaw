import type { TSchema } from "typebox";

// The lightweight entrypoint and lazy runtime share the exact model-facing contract.
export const MemorySearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description:
        "Short distinctive keywords from the source. Lexical corpora do not invent synonyms.",
    },
    vaultId: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Exact vaultId from a result, only when the user explicitly selects that vault. Do not combine with vaultName.",
    },
    vaultName: {
      type: "string",
      minLength: 1,
      maxLength: 240,
      description:
        "Exact Shared vault name explicitly selected by the user. Ambiguous names return choices; ask the user, never guess. Do not combine with vaultId.",
    },
    maxResults: { type: "integer", minimum: 1, maximum: 50 },
    minScore: { type: "number" },
    corpus: {
      type: "string",
      enum: ["memory", "wiki", "all", "sessions"],
      description:
        "Omit for ordinary recall. memory limits to Personal memory; sessions is explicit transcript recall; wiki limits to document corpora; all includes all configured corpora within the selected vault scope.",
    },
  },
  required: ["query"],
  not: { required: ["vaultId", "vaultName"] },
  additionalProperties: false,
} as const satisfies TSchema;

export const MemoryGetSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      minLength: 1,
      description:
        "Copy the exact path returned by search. The server routes it to its authorized owner.",
    },
    from: { type: "integer", minimum: 1 },
    lines: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Number of lines to read, from 1 to 200.",
    },
    corpus: {
      type: "string",
      enum: ["memory", "wiki", "all"],
      description:
        "Usually omit. Set only for an explicit Personal-memory-only or document-only request.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const satisfies TSchema;

export const MEMORY_SEARCH_DESCRIPTION =
  "Search accessible knowledge before answering about prior work, decisions, dates, people, preferences, todos, or workplace knowledge. Omit vaultId, vaultName, and corpus for the server-selected scope. Restrict a vault only when explicitly selected by the user; use its returned vaultId or exact Shared vaultName. Results include vault, document, path, and source version. Report warnings and follow action guidance; unavailable is not no knowledge.";
export const MEMORY_GET_DESCRIPTION =
  "Read a bounded excerpt using the exact path returned by search. The server selects the authorized source, including Personal and Shared knowledge; no corpus choice is needed. Optional from/lines select a line range; request another range when needed.";
