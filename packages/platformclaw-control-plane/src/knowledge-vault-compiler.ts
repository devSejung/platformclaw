import path from "node:path";
import { buildCodeSpanIndex } from "@openclaw/markdown-core/code-spans";
import { ControlPlaneStateError } from "./contracts.js";

export type KnowledgeVaultDerived = { chunks: string[]; links: string[] };

export function knowledgeVaultPath(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    value
      .split("")
      .some(
        (character) => character.charCodeAt(0) < 32 || character === "\\" || character === ":",
      ) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ControlPlaneStateError("Vault path must be a relative path without traversal");
  }
  return value;
}

/** Derived-only compiler: source text is never normalized or rewritten. */
export function compileKnowledgeVaultDocument(
  content: string,
  logicalPath: string,
): KnowledgeVaultDerived {
  const chunks: string[] = [];
  for (let offset = 0; offset < content.length; offset += 1080) {
    chunks.push(content.slice(offset, offset + 1200));
  }
  if (!chunks.length) {
    chunks.push("");
  }
  const links = new Set<string>();
  const codeSpans = buildCodeSpanIndex(content);
  const matches = content.matchAll(/\[\[([^\]\n|#]+)(?:[^\]\n]*)\]\]|\[[^\]\n]*\]\(([^)\s]+)\)/gu);
  for (const match of matches) {
    if (codeSpans.isInside(match.index)) {
      continue;
    }
    const raw = match[1] ?? match[2]!;
    if (raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
      continue;
    }
    try {
      const decoded = decodeURIComponent(raw.split("#")[0]!);
      const target = match[1] ? decoded : path.posix.join(path.posix.dirname(logicalPath), decoded);
      links.add(knowledgeVaultPath(target));
    } catch {
      /* Malformed or external links do not prevent indexing the original text. */
    }
  }
  return { chunks, links: [...links].toSorted() };
}
