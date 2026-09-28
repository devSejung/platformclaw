import { extractFrontmatterBlock, markdownToIR } from "@openclaw/markdown-core";
import { isMap, parseDocument } from "yaml";
import { ControlPlaneStateError } from "./contracts.js";
import { knowledgeVaultPath } from "./knowledge-vault-compiler.js";
import {
  KNOWLEDGE_VAULT_LIMITS,
  type KnowledgeVaultDocumentInput,
} from "./knowledge-vault-contracts.js";
import { requireKnowledgeVaultText } from "./sqlite-knowledge-vault-core.js";

function suggestedTitle(content: string, filename?: string): string {
  const frontmatter = extractFrontmatterBlock(content);
  if (frontmatter) {
    const document = parseDocument(frontmatter.block, { schema: "core", prettyErrors: false });
    const title =
      document.errors.length === 0 && isMap(document.contents) ? document.get("title") : undefined;
    if (typeof title === "string" && title.trim()) {
      return title.trim().slice(0, 240);
    }
  }
  const markdown = markdownToIR(frontmatter?.body ?? content, { headingStyle: "rich" });
  const heading = markdown.styles.find((style) => style.style === "heading_1");
  const title = heading ? markdown.text.slice(heading.start, heading.end).trim() : "";
  return (
    title ||
    filename
      ?.split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.(?:md|markdown)$/iu, "") ||
    "Untitled document"
  ).slice(0, 240);
}

/** Suggestions are metadata only; the reviewed Markdown bytes are never rewritten. */
export function resolveKnowledgeVaultDocumentMetadata(
  params: KnowledgeVaultDocumentInput,
  prior?: { title: string; logical_path: string },
): { title: string; logicalPath: string } {
  if (Buffer.byteLength(params.content) > KNOWLEDGE_VAULT_LIMITS.documentBytes) {
    throw new ControlPlaneStateError("Document exceeds 1 MiB");
  }
  const filename =
    params.filename === undefined
      ? undefined
      : requireKnowledgeVaultText(params.filename, "Filename", 512);
  const title =
    params.title === undefined
      ? (prior?.title ?? suggestedTitle(params.content, filename))
      : requireKnowledgeVaultText(params.title, "Document title", 240);
  const stem =
    (
      filename
        ?.split(/[\\/]/u)
        .at(-1)
        ?.replace(/\.(?:md|markdown)$/iu, "") || title
    )
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[.-]+|[.-]+$/gu, "")
      .slice(0, 200) || "document";
  const logicalPath = knowledgeVaultPath(params.logicalPath ?? prior?.logical_path ?? `${stem}.md`);
  if (!/\.md$/iu.test(logicalPath)) {
    throw new ControlPlaneStateError("Document path must end with .md");
  }
  return { title, logicalPath };
}
