import { createHash } from "node:crypto";
import { withTrailingNewline } from "openclaw/plugin-sdk/memory-host-markdown";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault, isGeneratedMemoryWikiPage } from "./compile.js";
import { invalidateMemoryWikiCompiledCache } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  extractGeneratedSourceContent,
  extractHumanNotes,
  hasHumanNotesRegion,
  parseWikiMarkdown,
  renderMarkdownFence,
  renderWikiMarkdown,
  replaceHumanNotes,
  stripManagedWikiMarkdown,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { readQueryableWikiPages, resolveQueryableWikiPageByLookup } from "./query.js";
import { writeGuardedVaultPage } from "./vault-page-write.js";

const MAX_EDIT_BYTES = 256 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

export type MemoryWikiEditMode = "body" | "notes";

export class MemoryWikiEditValidationError extends Error {}
export class MemoryWikiEditConflictError extends Error {}

function revision(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function assertPersonalVault(config: ResolvedMemoryWikiConfig): void {
  if (config.vault.scope !== "agent" || !config.agentId) {
    throw new MemoryWikiEditValidationError("Wiki editing requires a personal agent-scoped vault.");
  }
}

function classifyEditMode(page: Awaited<ReturnType<typeof readQueryableWikiPages>>[number]): {
  editMode: MemoryWikiEditMode | null;
  readOnlyReason?: "generated-report" | "source-managed" | "page-too-large";
} {
  if (Buffer.byteLength(page.raw, "utf8") > MAX_EDIT_BYTES) {
    return { editMode: null, readOnlyReason: "page-too-large" };
  }
  if (isGeneratedMemoryWikiPage(page.relativePath)) {
    return { editMode: null, readOnlyReason: "generated-report" };
  }
  if (page.kind === "report") {
    return hasHumanNotesRegion(page.raw)
      ? { editMode: "notes" }
      : { editMode: null, readOnlyReason: "generated-report" };
  }
  if (page.generatedSourceBody) {
    try {
      extractHumanNotes(page.raw);
      return { editMode: "notes" };
    } catch {
      return { editMode: null, readOnlyReason: "source-managed" };
    }
  }
  return { editMode: "body" };
}

function generatedSourceMarkdown(
  page: Awaited<ReturnType<typeof readQueryableWikiPages>>[number],
): string | null {
  const parsed = parseWikiMarkdown(page.raw);
  if (page.generatedSourceBody === "bridge" || page.generatedSourceBody === "unsafe-local") {
    const source = extractGeneratedSourceContent(parsed.body, page.generatedSourceBody);
    if (source) {
      const notes = extractHumanNotes(page.raw);
      const payload =
        source.language === "markdown" || source.language === "md"
          ? source.content.trim()
          : `## Content\n\n${renderMarkdownFence(source.content, source.language)}`;
      return `${payload}${notes ? `\n\n## Notes\n\n${notes}` : ""}`;
    }
  }
  return null;
}

function displayMarkdown(page: Awaited<ReturnType<typeof readQueryableWikiPages>>[number]): string {
  const parsed = parseWikiMarkdown(page.raw);
  const generatedSource = generatedSourceMarkdown(page);
  if (generatedSource !== null) {
    return generatedSource;
  }
  return stripManagedWikiMarkdown(parsed.body);
}

export async function getMemoryWikiDocument(params: {
  config: ResolvedMemoryWikiConfig;
  lookup: string;
}) {
  assertPersonalVault(params.config);
  const page = resolveQueryableWikiPageByLookup(
    await readQueryableWikiPages(params.config.vault.path),
    params.lookup,
  );
  if (!page) {
    return null;
  }
  const parsed = parseWikiMarkdown(page.raw);
  const classification = classifyEditMode(page);
  return {
    path: page.relativePath,
    title: page.title,
    kind: page.kind,
    displayContent: displayMarkdown(page),
    sourceContent: generatedSourceMarkdown(page) ?? stripManagedWikiMarkdown(parsed.body),
    editMode: classification.editMode,
    ...(classification.readOnlyReason ? { readOnlyReason: classification.readOnlyReason } : {}),
    ...(classification.editMode
      ? {
          editableContent:
            classification.editMode === "notes"
              ? extractHumanNotes(page.raw)
              : stripManagedWikiMarkdown(parsed.body),
          revision: revision(page.raw),
        }
      : {}),
    ...(page.sourceType ? { sourceType: page.sourceType } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
  };
}

export async function saveMemoryWikiDocument(params: {
  config: ResolvedMemoryWikiConfig;
  path: string;
  editMode: MemoryWikiEditMode;
  content: string;
  expectedRevision: string;
}) {
  assertPersonalVault(params.config);
  if (
    !HASH.test(params.expectedRevision) ||
    Buffer.byteLength(params.content, "utf8") > MAX_EDIT_BYTES
  ) {
    throw new MemoryWikiEditValidationError("Reload the complete Wiki document before saving.");
  }
  return await withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    const page = resolveQueryableWikiPageByLookup(
      await readQueryableWikiPages(params.config.vault.path),
      params.path,
    );
    if (!page || page.relativePath !== params.path) {
      throw new MemoryWikiEditValidationError("Wiki document not found.");
    }
    const classification = classifyEditMode(page);
    if (classification.editMode !== params.editMode) {
      throw new MemoryWikiEditValidationError("This Wiki document is not editable in that mode.");
    }
    const parsed = parseWikiMarkdown(page.raw);
    const currentEditable =
      params.editMode === "notes"
        ? extractHumanNotes(page.raw)
        : stripManagedWikiMarkdown(parsed.body);
    const currentRevision = revision(page.raw);
    if (currentRevision !== params.expectedRevision) {
      if (currentEditable === params.content) {
        await invalidateMemoryWikiCompiledCache(params.config);
        let indexesRefreshed = false;
        try {
          await compileMemoryWikiVault(params.config);
          indexesRefreshed = true;
        } catch {
          // The earlier write remains authoritative; this retry only repairs derived indexes.
        }
        const vault = await fsRoot(params.config.vault.path);
        return {
          saved: false,
          path: page.relativePath,
          revision: revision(await vault.readText(page.relativePath)),
          indexesRefreshed,
        };
      }
      throw new MemoryWikiEditConflictError("Wiki document changed. Reload it before saving.");
    }
    const now = new Date().toISOString();
    const notesUpdated =
      params.editMode === "notes"
        ? parseWikiMarkdown(replaceHumanNotes(page.raw, params.content))
        : null;
    const rendered = renderWikiMarkdown({
      frontmatter: { ...(notesUpdated?.frontmatter ?? parsed.frontmatter), updatedAt: now },
      body: notesUpdated?.body ?? params.content,
    });
    const next = withTrailingNewline(rendered);
    if (next === page.raw) {
      return {
        saved: false,
        path: page.relativePath,
        revision: params.expectedRevision,
        indexesRefreshed: true,
      };
    }
    const vault = await fsRoot(params.config.vault.path);
    const pageStat = await vault.stat(page.relativePath);
    await writeGuardedVaultPage({
      vault,
      pagePath: page.relativePath,
      content: next,
      pageStat,
      pageLabel: "personal Wiki page",
    });
    await appendMemoryWikiLog(params.config.vault.path, {
      type: "edit",
      timestamp: now,
      details: {
        path: page.relativePath,
        agentId: params.config.agentId,
        editMode: params.editMode,
      },
    });
    await invalidateMemoryWikiCompiledCache(params.config);
    let indexesRefreshed = false;
    try {
      await compileMemoryWikiVault(params.config);
      indexesRefreshed = true;
    } catch {
      // The document write committed. A later compile/refresh may repair derived indexes.
    }
    return {
      saved: true,
      path: page.relativePath,
      revision: revision(await vault.readText(page.relativePath)),
      indexesRefreshed,
    };
  });
}
