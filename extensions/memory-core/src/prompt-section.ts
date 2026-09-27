// Memory Core plugin module implements prompt section behavior.
import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasMemoryWrite = availableTools.has("memory_write");

  if (!hasMemorySearch && !hasMemoryGet && !hasMemoryWrite) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search with a few distinctive keywords and omit vault/corpus selectors for the server-selected knowledge scope; then use memory_get with the exact returned path to pull only needed lines. Use indexed session transcripts only for explicit transcript recall. If low confidence after search, say you checked.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search with a few distinctive keywords and omit vault/corpus selectors for the server-selected knowledge scope; answer from matching results. Use indexed session transcripts only for explicit transcript recall. If low confidence after search, say you checked.";
  } else if (hasMemoryGet) {
    toolGuidance =
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
  } else {
    toolGuidance = "Durable memory recall is unavailable in this run.";
  }

  const lines = ["## Memory Recall", toolGuidance];
  if (hasMemoryWrite) {
    lines.push(
      "When saving a durable fact, preference, decision, or todo, use memory_write. General read/write/edit tools address the active workspace and are not the Agent memory store.",
    );
  }
  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};
