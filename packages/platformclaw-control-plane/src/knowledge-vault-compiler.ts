import {
  normalizeWikiDocumentTarget,
  parseMemoryWikiReferenceSpans,
} from "@openclaw/markdown-core";
import { ControlPlaneStateError } from "./contracts.js";

type KnowledgeVaultDerived = { chunks: string[]; links: string[] };

type LinkDocument = { id: string; logical_path: string; title: string };
const comparableTarget = normalizeWikiDocumentTarget;

/** A concrete path wins over a coincidentally equal title; ambiguous shorthand never guesses. */
export function createKnowledgeVaultLinkResolver(documents: readonly LinkDocument[]) {
  const exact = new Map<string, LinkDocument[]>();
  const paths = new Map<string, LinkDocument[]>();
  const ids = new Map<string, LinkDocument[]>();
  const titles = new Map<string, LinkDocument[]>();
  const add = (map: Map<string, LinkDocument[]>, key: string, document: LinkDocument) => {
    map.set(key, [...(map.get(key) ?? []), document]);
  };
  for (const document of documents) {
    add(exact, document.logical_path, document);
    add(paths, comparableTarget(document.logical_path), document);
    add(ids, comparableTarget(document.id), document);
    add(titles, comparableTarget(document.title), document);
  }
  return (target: string): readonly LinkDocument[] =>
    exact.get(target) ??
    paths.get(comparableTarget(target)) ??
    ids.get(comparableTarget(target)) ??
    titles.get(comparableTarget(target)) ??
    [];
}

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
  for (const { target } of parseMemoryWikiReferenceSpans(
    content,
    logicalPath,
    Number.POSITIVE_INFINITY,
    { purpose: "graph" },
  )) {
    try {
      links.add(knowledgeVaultPath(target));
    } catch {
      /* Non-document or outside-Wiki references never prevent text indexing. */
    }
  }
  return { chunks, links: [...links].toSorted() };
}
