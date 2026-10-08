import { createHash, randomUUID } from "node:crypto";
import { withTrailingNewline } from "openclaw/plugin-sdk/memory-host-markdown";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { walkMemoryWikiDirectory } from "./bounded-walk.js";
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
  canDelete: boolean;
  readOnlyReason?: "generated-report" | "source-managed" | "page-too-large" | "shared-vault";
  editableContent?: string;
  revision?: string;
  sourceType?: string;
  updatedAt?: string;
};

export class MemoryWikiEditValidationError extends Error {}
export class MemoryWikiEditConflictError extends Error {}

type MemoryWikiImportDocument =
  | {
      relativePath: string;
      path: string;
      title: string;
      status: "saved" | "unchanged";
      revision: string;
    }
  | {
      relativePath: string;
      path: string;
      status: "failed";
      error: "conflict" | "unavailable" | "invalid";
    };

type PlannedMemoryWikiImport =
  | { relativePath: string; path: string; status: "pending"; title: string; content: string }
  | { relativePath: string; path: string; status: "failed"; error: "invalid" };

/** The client keeps this namespace through retries; existing source bytes are the receipt. */
export async function importMemoryWikiDocuments(params: {
  config: ResolvedMemoryWikiConfig;
  importId: string;
  documents: unknown;
}): Promise<{
  importId: string;
  rootPath: string;
  documents: MemoryWikiImportDocument[];
  indexesRefreshed: boolean;
}> {
  assertPersonalVault(params.config);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(params.importId) ||
    !Array.isArray(params.documents) ||
    params.documents.length < 1 ||
    params.documents.length > 100
  ) {
    throw new MemoryWikiEditValidationError("Use an import ID and 1–100 Markdown documents.");
  }
  const rootPath = `concepts/imports/${params.importId}`;
  const paths = new Set<string>();
  let totalBytes = 0;
  // Validate the complete request before making source writes. NFC and extension
  // normalization share one collision key on case-sensitive and Windows hosts.
  const planned = params.documents.map((value): PlannedMemoryWikiImport => {
    const document = asNullableRecord(value);
    if (
      !document ||
      Object.keys(document).some((key) => key !== "relativePath" && key !== "content") ||
      typeof document.relativePath !== "string" ||
      typeof document.content !== "string"
    ) {
      throw new MemoryWikiEditValidationError("Each document requires relativePath and content.");
    }
    const relativePath = document.relativePath;
    const sourcePath = relativePath.normalize("NFC").replace(/\.(?:md|markdown)$/iu, ".md");
    const pagePath = `${rootPath}/${sourcePath}`;
    if (
      pagePath.length > 512 ||
      !/\.md$/iu.test(sourcePath) ||
      sourcePath
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[<>:"\\|?*]/u.test(part) ||
            part
              .split("")
              .some(
                (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
              ) ||
            /[. ]$/u.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) ||
            Buffer.byteLength(part) > 190,
        )
    ) {
      throw new MemoryWikiEditValidationError(`Use a safe relative Markdown path: ${relativePath}`);
    }
    const key = sourcePath.toLowerCase();
    if (paths.has(key)) {
      throw new MemoryWikiEditValidationError(`Duplicate Markdown path: ${relativePath}`);
    }
    paths.add(key);
    const bytes = Buffer.byteLength(document.content, "utf8");
    totalBytes += bytes;
    if (bytes > 1024 * 1024 || totalBytes > 4 * 1024 * 1024) {
      throw new MemoryWikiEditValidationError(
        "Import supports 1 MiB per file and 4 MiB per request.",
      );
    }
    try {
      const page = toWikiPageSummary({
        absolutePath: pagePath,
        relativePath: pagePath,
        raw: document.content,
      });
      if (page) {
        return {
          relativePath,
          path: pagePath,
          title: page.title.slice(0, 240),
          content: document.content,
          status: "pending",
        };
      }
    } catch {
      // Invalid source stays in the upload results, never in the searchable vault.
    }
    return { relativePath, path: pagePath, status: "failed", error: "invalid" };
  });
  return withMemoryWikiVaultMutation(params.config.vault.path, async () => {
    await initializeMemoryWikiVault(params.config);
    const vault = await fsRoot(params.config.vault.path);
    const existingPaths = new Map(
      (await walkMemoryWikiDirectory(params.config.vault.path, rootPath))
        .filter((entry) => entry.kind === "file")
        .map((entry) => {
          const existingPath = entry.relativePath.replaceAll("\\", "/");
          return [existingPath.normalize("NFC").toLowerCase(), existingPath] as const;
        }),
    );
    await appendMemoryWikiLog(params.config.vault.path, {
      type: "edit",
      timestamp: new Date().toISOString(),
      details: { operation: "import", importId: params.importId, agentId: params.config.agentId },
    });
    const documents: MemoryWikiImportDocument[] = [];
    for (const document of planned) {
      if (document.status === "failed") {
        documents.push(document);
        continue;
      }
      const { relativePath, path: pagePath, title, content } = document;
      const existingPath = existingPaths.get(pagePath.toLowerCase());
      if (existingPath !== undefined && existingPath !== pagePath) {
        documents.push({ relativePath, path: pagePath, status: "failed", error: "conflict" });
        continue;
      }
      try {
        let status: "saved" | "unchanged" = "saved";
        try {
          await vault.create(pagePath, content);
        } catch (error) {
          if (!(error instanceof FsSafeError && error.code === "already-exists")) {
            throw error;
          }
          const existing = await vault.readBytes(pagePath, {
            maxBytes: 1024 * 1024,
            hardlinks: "reject",
            symlinks: "reject",
          });
          if (!existing.equals(Buffer.from(content, "utf8"))) {
            documents.push({ relativePath, path: pagePath, status: "failed", error: "conflict" });
            continue;
          }
          status = "unchanged";
        }
        documents.push({
          relativePath,
          path: pagePath,
          title,
          status,
          revision: revision(content),
        });
      } catch {
        // A failed write never changes a saved sibling's outcome. Retrying the
        // same import ID verifies committed bytes and resumes only missing files.
        documents.push({ relativePath, path: pagePath, status: "failed", error: "unavailable" });
      }
    }
    let indexesRefreshed = false;
    if (documents.some((document) => document.status !== "failed")) {
      invalidateMemoryWikiCompiledPrompt(params.config);
      try {
        await compileMemoryWikiVault(params.config);
        indexesRefreshed = true;
      } catch {
        // Source outcomes are authoritative; compilation retains its failure/retry owner.
      }
    }
    return { importId: params.importId, rootPath, documents, indexesRefreshed };
  });
}

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
      canDelete: false,
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
      const matches = resolveWikiLinkTarget(targetIndex, target, page.relativePath);
      const resolved = matches.length === 1 ? matches[0] : undefined;
      return {
        target,
        documentId: resolved?.relativePath ?? null,
        logicalPath: resolved?.relativePath ?? target,
        title: (resolved?.title ?? target).slice(0, 1024),
      };
    });
  // Imported metadata is source text, not a display-size contract. Bound the
  // presentation fields without changing the authored source or its revision.
  return {
    path: page.relativePath,
    title: page.title.slice(0, 240),
    kind: page.kind,
    links,
    linksTruncated: targets.length > links.length,
    displayContent: displayMarkdown(page),
    sourceContent: page.raw,
    revision: revision(page.raw),
    editMode: classification.editMode,
    // Deletion is independent of body-editability: source-managed and large authored pages
    // remain deletable, while compiler-owned navigation follows the canonical page policy.
    canDelete:
      params.config.vault.scope === "agent" &&
      Boolean(params.config.agentId) &&
      !isGeneratedMemoryWikiPage(page.relativePath) &&
      Buffer.byteLength(page.raw, "utf8") <= 1024 * 1024,
    ...(classification.readOnlyReason ? { readOnlyReason: classification.readOnlyReason } : {}),
    ...(classification.editMode
      ? {
          editableContent:
            classification.editMode === "notes"
              ? extractHumanNotes(page.raw)
              : stripManagedWikiMarkdown(parsed.body),
        }
      : {}),
    ...(page.sourceType ? { sourceType: page.sourceType.slice(0, 256) } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt.slice(0, 256) } : {}),
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
