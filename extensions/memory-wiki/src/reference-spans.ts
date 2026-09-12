import { createHash } from "node:crypto";
import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";

export const MAX_MEMORY_WIKI_REFERENCE_SPANS = 32;
export type MemoryWikiReferenceSpan = { start: number; end: number; target: string };
type AstNode = {
  type?: string;
  url?: string;
  identifier?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: AstNode[];
};
const RELATED_BLOCK =
  /(?:^|\r?\n)## Related[\t ]*\r?\n(?:[\t ]*\r?\n)*<!-- openclaw:wiki:related:start -->[\s\S]*?<!-- openclaw:wiki:related:end -->/g;

/** Offsets refer to the original text, including CRLF and complete private aliases. */
export function parseMemoryWikiReferenceSpans(
  markdown: string,
  sourceRelativePath = "",
  maxReferences = MAX_MEMORY_WIKI_REFERENCE_SPANS,
  options: { purpose?: "graph" | "publication" } = {},
): MemoryWikiReferenceSpan[] {
  const masked = markdown.split("");
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {
        masked[index] = " ";
      }
    }
  };
  const visit = (node: AstNode): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        mask(start, end);
      }
      return;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  const tree = fromMarkdown(markdown) as AstNode;
  visit(tree);
  if (options.purpose === "graph") {
    for (const match of markdown.matchAll(RELATED_BLOCK)) {
      mask(match.index, match.index + match[0].length);
    }
  }
  const searchable = masked.join("");
  const references: MemoryWikiReferenceSpan[] = [];
  const append = (match: RegExpMatchArray, target: string) => {
    if (references.length >= maxReferences) {
      throw new Error(`Wiki references exceed the ${maxReferences} reference limit.`);
    }
    const start =
      match.index! > 0 && searchable[match.index! - 1] === "!" ? match.index! - 1 : match.index!;
    references.push({ start, end: match.index! + match[0].length, target });
  };
  for (const match of searchable.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = match[1]?.trim();
    if (target) {
      append(match, target);
    }
  }
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: AstNode): void => {
    // Markdown rendering keeps the first definition; a later public URL must not hide a private one.
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier.toLowerCase())
    ) {
      definitions.set(node.identifier.toLowerCase(), node.url);
    }
    for (const child of node.children ?? []) {
      collectDefinitions(child);
    }
  };
  collectDefinitions(tree);
  const visitLinks = (node: AstNode): void => {
    const url =
      node.url ??
      ((node.type === "linkReference" || node.type === "imageReference") && node.identifier
        ? definitions.get(node.identifier.toLowerCase())
        : undefined);
    if (
      ["link", "image", "linkReference", "imageReference", "definition"].includes(
        node.type ?? "",
      ) &&
      url &&
      (options.purpose !== "graph" || node.type !== "definition")
    ) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      const rawTarget = url.trim();
      if (
        start !== undefined &&
        end !== undefined &&
        !references.some((reference) => start >= reference.start && start < reference.end) &&
        searchable.slice(start, end).trim() &&
        !rawTarget.startsWith("#") &&
        !rawTarget.startsWith("//") &&
        (!/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || /^(?:file|obsidian):/i.test(rawTarget))
      ) {
        const target = rawTarget.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
        if (target) {
          if (references.length >= maxReferences) {
            throw new Error(`Wiki references exceed the ${maxReferences} reference limit.`);
          }
          references.push({
            start,
            end,
            target: path.posix.normalize(
              path.posix.join(path.posix.dirname(sourceRelativePath), target),
            ),
          });
        }
      }
    }
    for (const child of node.children ?? []) {
      visitLinks(child);
    }
  };
  visitLinks(tree);
  const normalized: MemoryWikiReferenceSpan[] = [];
  for (const reference of references.toSorted(
    (left, right) => left.start - right.start || right.end - left.end,
  )) {
    const previous = normalized.at(-1);
    if (previous && reference.start < previous.end) {
      if (reference.end <= previous.end) {
        continue;
      }
      throw new Error(
        "Overlapping Wiki references require a simpler complete link before submission.",
      );
    }
    normalized.push(reference);
  }
  return normalized;
}

/** Preserve the existing complete wiki.get promotion revision algorithm. */
export function memoryWikiPromotionRevision(page: {
  claimId: string;
  content: unknown;
  totalLines: unknown;
  updatedAt?: unknown;
}): number {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        claimId: page.claimId,
        content: page.content,
        totalLines: page.totalLines,
        updatedAt: page.updatedAt,
      }),
    )
    .digest("hex");
  return Number.parseInt(digest.slice(0, 12), 16) + 1;
}

export function memoryWikiReferenceTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
