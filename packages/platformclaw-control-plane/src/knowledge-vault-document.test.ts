import { describe, expect, it } from "vitest";
import { resolveKnowledgeVaultDocumentMetadata } from "./knowledge-vault-document.js";

describe("Shared Markdown metadata", () => {
  it.each([
    ["---\ntitle: Frontmatter title\n---\n# Heading", "Frontmatter title"],
    ["---\ntitle: [not, text]\n---\n# Heading", "Heading"],
    ["---\ntitle: 27\n---\n# Heading", "Heading"],
    ["---\ntitle: [broken\n---\n# Heading", "Heading"],
    ["```md\n# Example\n```\n# Real **heading**", "Real heading"],
    ["Setext title\n============\nBody", "Setext title"],
    ["    # Indented code\n\n# Real heading", "Real heading"],
    ["Plain text without Wiki fields", "source"],
    ["", "source"],
  ])("suggests metadata without changing %j", (content, title) => {
    const input = { userId: "user", vaultId: "vault", filename: "source.markdown", content };
    expect(resolveKnowledgeVaultDocumentMetadata(input)).toEqual({
      title,
      logicalPath: "source.md",
    });
    expect(input.content).toBe(content);
  });

  it("keeps explicit metadata and prior edit metadata ahead of suggestions", () => {
    const input = { userId: "user", vaultId: "vault", content: "# New heading" };
    expect(
      resolveKnowledgeVaultDocumentMetadata({
        ...input,
        title: "Chosen",
        logicalPath: "chosen.md",
      }),
    ).toEqual({ title: "Chosen", logicalPath: "chosen.md" });
    expect(
      resolveKnowledgeVaultDocumentMetadata(input, { title: "Saved", logical_path: "saved.md" }),
    ).toEqual({ title: "Saved", logicalPath: "saved.md" });
  });
});
