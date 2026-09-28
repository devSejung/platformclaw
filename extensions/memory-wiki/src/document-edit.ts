import { createHash, randomUUID } from "node:crypto";
import { withTrailingNewline } from "openclaw/plugin-sdk/memory-host-markdown";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault, isGeneratedMemoryWikiPage } from "./compile.js";
import { invalidateMemoryWikiCompiledPrompt } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createWikiLinkTargetIndex, resolveWikiLinkTarget } from "./link-resolution.js";
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
  slugifyWikiPageStem,
  toWikiPageSummary,
} from "./markdown.js";
import type { WikiPageKind } from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import {
  readMemoryWikiIndexDocument,
  readQueryableWikiPages,
  resolveQueryableWikiPageByLookup,
} from "./query.js";
import { writeGuardedVaultPage } from "./vault-page-write.js";
import { initializeMemoryWikiVault } from "./vault.js";

const MAX_EDIT_BYTES = 256 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

type MemoryWikiEditMode = "body" | "notes";

type MemoryWikiDocument = {
  links: Array<{ target: string; documentId: string | null; logicalPath: string; title: string }>;
  linksTruncated: boolean;
  path: string;
  title: string;
  kind: WikiPageKind | "index";
  displayContent: string;
  sourceContent: string;
  editMode: MemoryWikiEditMode | null;
  readOnlyReason?: "generated-report" | "source-managed" | "page-too-large" | "shared-vault";
  editableContent?: string;
  revision?: string;
  sourceType?: string;
  updatedAt?: string;
};

export class MemoryWikiEditValidationError extends Error {}
export class MemoryWikiEditConflictError extends Error {}

/** Creating a document never chooses or overwrites an existing title match. */
export async function createMemoryWikiDocument(params: {
  config: ResolvedMemoryWikiConfig;
  title: string;
  content: string;
  filename?: string;
}) {
  assertPersonalVault(params.config);
  if (
    !params.title.trim() ||
    params.title.length > 240 ||
    Buffer.byteLength(params.content, "utf8") > 1024 * 1024
  ) {
    throw new MemoryWikiEditValidationError(
      "Use a title of 1–240 characters and a source of at most 1 MiB.",
    );
  }
  return await withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    await initializeMemoryWikiVault(params.config);
    const id = randomUUID();
    const originalName = params.filename
      ?.split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.(?:md|markdown)$/iu, "");
    if (
      originalName &&
      (/[<>:"/\\|?*]/u.test(originalName) ||
        originalName.split("").some((character) => character.charCodeAt(0) < 32) ||
        Buffer.byteLength(originalName) > 190 ||
        /^[. ]|[. ]$/u.test(originalName))
    ) {
      throw new MemoryWikiEditValidationError(
        "Use a source filename without filesystem-reserved characters and at most 190 UTF-8 bytes.",
      );
    }
    // A private directory makes duplicate imports unique without changing the
    // filename-derived title or inserting metadata into the original Markdown.
    const pagePath = originalName
      ? `concepts/${id}/${originalName}.md`
      : `concepts/${slugifyWikiPageStem(params.title).slice(0, 100)}-${id}.md`;
    const now = new Date().toISOString();
    const parsed = parseWikiMarkdown(params.content);
    // Matching the derived source title preserves import bytes. An explicit title
    // override is a user-authored metadata edit; unrelated fields and body survive.
    const sourceTitle = toWikiPageSummary({
      absolutePath: pagePath,
      relativePath: `concepts/${originalName ? `${originalName}.md` : "Untitled.md"}`,
      raw: params.content,
    })?.title;
    const title = params.title.trim();
    const content =
      sourceTitle === title
        ? params.content
        : renderWikiMarkdown({
            frontmatter: { ...parsed.frontmatter, title },
            body: "",
          }).slice(0, -1) + parsed.body;

    const vault = await fsRoot(params.config.vault.path);
    await vault.create(pagePath, content);
    await appendMemoryWikiLog(params.config.vault.path, {
      type: "edit",
      timestamp: now,
      details: { path: pagePath, agentId: params.config.agentId, operation: "create" },
    });
    invalidateMemoryWikiCompiledPrompt(params.config);
    let indexesRefreshed = false;
    try {
      await compileMemoryWikiVault(params.config);
      indexesRefreshed = true;
    } catch {
      // Source creation succeeded; the compiler records the failure and retry.
    }
    return {
      saved: true,
      path: pagePath,
      title: params.title.trim(),
      revision: revision(content),
      indexesRefreshed,
    };
  });
}

function revision(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function assertPersonalVault(config: ResolvedMemoryWikiConfig): void {
  if (config.vault.scope !== "agent" || !config.agentId) {
    throw new MemoryWikiEditValidationError("Wiki editing requires a personal agent-scoped vault.");
  }
}

function classifyEditMode(
  page: Awaited<ReturnType<typeof readQueryableWikiPages>>[number],
  editableVault: boolean,
): {
  editMode: MemoryWikiEditMode | null;
  readOnlyReason?: "generated-report" | "source-managed" | "page-too-large" | "shared-vault";
} {
  if (!editableVault) {
    return { editMode: null, readOnlyReason: "shared-vault" };
  }
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
}): Promise<MemoryWikiDocument | null> {
  const index = await readMemoryWikiIndexDocument({
    rootDir: params.config.vault.path,
    lookup: params.lookup,
  });
  if (index) {
    return {
      path: index.path,
      title: index.title,
      kind: "index" as const,
      links: [],
      linksTruncated: false,
      displayContent: index.content,
      sourceContent: index.content,
      revision: revision(index.content),
      editMode: null,
      readOnlyReason: "generated-report" as const,
    };
  }
  const pages = await readQueryableWikiPages(params.config.vault.path);
  const page = resolveQueryableWikiPageByLookup(pages, params.lookup);
  if (!page) {
    return null;
  }
  const parsed = parseWikiMarkdown(page.raw);
  const classification = classifyEditMode(
    page,
    params.config.vault.scope === "agent" && Boolean(params.config.agentId),
  );
  const targets = [...new Set(page.linkTargets)];
  const targetIndex = createWikiLinkTargetIndex(pages);
  const links = targets
    .filter((target) => target.length <= 1024)
    .slice(0, 2000)
    .map((target) => {
      const matches = resolveWikiLinkTarget(targetIndex, target);
      const resolved = matches.length === 1 ? matches[0] : undefined;
      return {
        target,
        documentId: resolved?.relativePath ?? null,
        logicalPath: resolved?.relativePath ?? target,
        title: (resolved?.title ?? target).slice(0, 1024),
      };
    });
  return {
    path: page.relativePath,
    title: page.title,
    kind: page.kind,
    links,
    linksTruncated: targets.length > links.length,
    displayContent: displayMarkdown(page),
    sourceContent: page.raw,
    revision: revision(page.raw),
    editMode: classification.editMode,
    ...(classification.readOnlyReason ? { readOnlyReason: classification.readOnlyReason } : {}),
    ...(classification.editMode
      ? {
          editableContent:
            classification.editMode === "notes"
              ? extractHumanNotes(page.raw)
              : stripManagedWikiMarkdown(parsed.body),
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
  title?: string;
}) {
  assertPersonalVault(params.config);
  if (
    (params.title !== undefined && (!params.title.trim() || params.title.length > 240)) ||
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
    const classification = classifyEditMode(page, true);
    if (classification.editMode !== params.editMode) {
      throw new MemoryWikiEditValidationError("This Wiki document is not editable in that mode.");
    }
    if (
      params.editMode === "notes" &&
      params.title !== undefined &&
      params.title.trim() !== page.title
    ) {
      throw new MemoryWikiEditValidationError(
        "This source-managed document title is read-only; edit its notes only.",
      );
    }
    const parsed = parseWikiMarkdown(page.raw);
    const currentEditable =
      params.editMode === "notes"
        ? extractHumanNotes(page.raw)
        : stripManagedWikiMarkdown(parsed.body);
    const currentRevision = revision(page.raw);
    if (currentRevision !== params.expectedRevision) {
      if (
        currentEditable === params.content &&
        (params.title === undefined || params.title.trim() === page.title)
      ) {
        invalidateMemoryWikiCompiledPrompt(params.config);
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
      frontmatter: {
        ...(notesUpdated?.frontmatter ?? parsed.frontmatter),
        ...(params.title === undefined ? {} : { title: params.title.trim() }),
        updatedAt: now,
      },
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
    invalidateMemoryWikiCompiledPrompt(params.config);
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
