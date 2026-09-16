// Memory Wiki plugin module implements apply behavior.
import { createHash } from "node:crypto";
import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { readFiniteNumberParam } from "openclaw/plugin-sdk/param-readers";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { compileMemoryWikiVault, type CompileMemoryWikiResult } from "./compile.js";
import { invalidateMemoryWikiCompiledCache } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { createWikiLinkTargetIndex, resolveWikiLinkTarget } from "./link-resolution.js";
import {
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiPageStem,
  slugifyWikiSegment,
  normalizeSourceIds,
  normalizeWikiClaims,
  type WikiClaim,
  type WikiRelationship,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import {
  readQueryableWikiPages,
  resolveQueryableWikiPageByLookup,
  type QueryableWikiPage,
} from "./query.js";
import { initializeMemoryWikiVault } from "./vault.js";

const GENERATED_START = "<!-- openclaw:wiki:generated:start -->";
const GENERATED_END = "<!-- openclaw:wiki:generated:end -->";
const HUMAN_START = "<!-- openclaw:human:start -->";
const HUMAN_END = "<!-- openclaw:human:end -->";

type ProposedWikiRelationship = {
  lookup: string;
  kind: "reference" | "enrichment" | "condition-difference" | "duplicate" | "conflict";
  status: "confirmed" | "candidate";
  expectedRevision: string;
  confidence?: number;
  note?: string;
};

type CreateSynthesisMemoryWikiMutation = {
  op: "create_synthesis";
  title: string;
  body: string;
  sourceIds: string[];
  claims?: WikiClaim[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number;
  status?: string;
  relationships?: ProposedWikiRelationship[];
};

type UpdateMetadataMemoryWikiMutation = {
  op: "update_metadata";
  lookup: string;
  sourceIds?: string[];
  claims?: WikiClaim[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number | null;
  status?: string;
  relationships?: ProposedWikiRelationship[];
};

type ApplyMemoryWikiMutation = CreateSynthesisMemoryWikiMutation | UpdateMetadataMemoryWikiMutation;

type MemoryWikiMutationInputOp = ApplyMemoryWikiMutation["op"] | "synthesis" | "metadata";

type ApplyMemoryWikiMutationResult = {
  changed: boolean;
  operation: ApplyMemoryWikiMutation["op"];
  pagePath: string;
  pageId?: string;
  indexesRefreshed: boolean;
  compile?: CompileMemoryWikiResult;
};

function normalizeProposedRelationships(value: unknown): ProposedWikiRelationship[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("relationships must be an array.");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("each relationship must be an object.");
    }
    const record = entry as Record<string, unknown>;
    const lookup = typeof record.lookup === "string" ? record.lookup.trim() : "";
    const kind = record.kind;
    const status = record.status;
    const expectedRevision =
      typeof record.expectedRevision === "string" ? record.expectedRevision.trim() : "";
    if (
      !lookup ||
      !["reference", "enrichment", "condition-difference", "duplicate", "conflict"].includes(
        String(kind),
      ) ||
      (status !== "confirmed" && status !== "candidate") ||
      !/^[a-f0-9]{64}$/u.test(expectedRevision)
    ) {
      throw new Error(
        "relationships require lookup, kind, status, and the current wiki_get revision.",
      );
    }
    const confidence = readFiniteNumberParam(record, "confidence", { min: 0, max: 1 });
    const note = typeof record.note === "string" ? record.note.trim() : undefined;
    return {
      lookup,
      kind: kind as ProposedWikiRelationship["kind"],
      status,
      expectedRevision,
      ...(typeof confidence === "number" ? { confidence } : {}),
      ...(note ? { note } : {}),
    };
  });
}

function normalizeMutationConfidence(
  params: Record<string, unknown>,
  options: { allowNull: false },
): number | undefined;
function normalizeMutationConfidence(
  params: Record<string, unknown>,
  options: { allowNull: true },
): number | null | undefined;
function normalizeMutationConfidence(
  params: Record<string, unknown>,
  options: { allowNull: boolean },
): number | null | undefined {
  if (options.allowNull && params.confidence === null) {
    return null;
  }
  return readFiniteNumberParam(params, "confidence", {
    min: 0,
    max: 1,
  });
}

function normalizeMemoryWikiMutationOp(
  op: MemoryWikiMutationInputOp,
): ApplyMemoryWikiMutation["op"] {
  if (op === "synthesis") {
    return "create_synthesis";
  }
  if (op === "metadata") {
    return "update_metadata";
  }
  return op;
}

export function normalizeMemoryWikiMutationInput(rawParams: unknown): ApplyMemoryWikiMutation {
  const params = rawParams as {
    op: MemoryWikiMutationInputOp;
    title?: string;
    body?: string;
    lookup?: string;
    sourceIds?: string[];
    claims?: WikiClaim[];
    contradictions?: string[];
    questions?: string[];
    confidence?: number | null;
    status?: string;
    relationships?: unknown;
  };
  const op = normalizeMemoryWikiMutationOp(params.op);
  if (op === "create_synthesis") {
    if (!params.title?.trim()) {
      throw new Error("wiki mutation requires title for create_synthesis.");
    }
    if (!params.body?.trim()) {
      throw new Error("wiki mutation requires body for create_synthesis.");
    }
    if (!params.sourceIds || params.sourceIds.length === 0) {
      throw new Error("wiki mutation requires at least one sourceId for create_synthesis.");
    }
    const confidence = normalizeMutationConfidence(params as Record<string, unknown>, {
      allowNull: false,
    });
    return {
      op: "create_synthesis",
      title: params.title,
      body: params.body,
      sourceIds: params.sourceIds,
      ...(Array.isArray(params.claims) ? { claims: normalizeWikiClaims(params.claims) } : {}),
      ...(params.contradictions ? { contradictions: params.contradictions } : {}),
      ...(params.questions ? { questions: params.questions } : {}),
      ...(typeof confidence === "number" ? { confidence } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.relationships !== undefined
        ? { relationships: normalizeProposedRelationships(params.relationships) }
        : {}),
    };
  }
  if (!params.lookup?.trim()) {
    throw new Error("wiki mutation requires lookup for update_metadata.");
  }
  const confidence = normalizeMutationConfidence(params as Record<string, unknown>, {
    allowNull: true,
  });
  return {
    op: "update_metadata",
    lookup: params.lookup,
    ...(params.sourceIds ? { sourceIds: params.sourceIds } : {}),
    ...(Array.isArray(params.claims) ? { claims: normalizeWikiClaims(params.claims) } : {}),
    ...(params.contradictions ? { contradictions: params.contradictions } : {}),
    ...(params.questions ? { questions: params.questions } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.relationships !== undefined
      ? { relationships: normalizeProposedRelationships(params.relationships) }
      : {}),
  };
}

function resolveRelationshipTarget(
  pages: readonly QueryableWikiPage[],
  lookup: string,
): QueryableWikiPage {
  const matches = resolveWikiLinkTarget(createWikiLinkTargetIndex(pages), lookup);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Wiki relationship target not found: ${lookup}`
        : `Wiki relationship target is ambiguous: ${lookup}`,
    );
  }
  return matches[0]!;
}

async function resolveVerifiedRelationships(params: {
  config: ResolvedMemoryWikiConfig;
  proposed?: ProposedWikiRelationship[];
  sourcePath: string;
}): Promise<WikiRelationship[] | undefined> {
  if (params.proposed === undefined) {
    return undefined;
  }
  const pages = await readQueryableWikiPages(params.config.vault.path);
  const now = new Date().toISOString();
  return params.proposed.map((relationship) => {
    const target = resolveRelationshipTarget(pages, relationship.lookup);
    if (target.relativePath === params.sourcePath) {
      throw new Error("Wiki relationships cannot target the page being written.");
    }
    if (createHash("sha256").update(target.raw).digest("hex") !== relationship.expectedRevision) {
      throw new Error(`Wiki relationship target changed; read it again: ${relationship.lookup}`);
    }
    return {
      ...(target.id ? { targetId: target.id } : {}),
      targetPath: target.relativePath,
      targetTitle: target.title,
      kind: relationship.kind,
      status: relationship.status,
      evidenceKind:
        relationship.status === "confirmed" ? "content-reviewed" : "ai-comparison-candidate",
      ...(relationship.confidence !== undefined ? { confidence: relationship.confidence } : {}),
      ...(relationship.note ? { note: relationship.note } : {}),
      updatedAt: now,
    };
  });
}

function normalizeUniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  return uniqueStrings(normalizeStringEntries(values));
}

function ensureHumanNotesBlock(body: string): string {
  if (body.includes(HUMAN_START) && body.includes(HUMAN_END)) {
    return body;
  }
  const trimmed = body.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}## Notes\n${HUMAN_START}\n${HUMAN_END}\n`;
}

function buildSynthesisBody(params: {
  title: string;
  originalBody?: string;
  generatedBody: string;
}): string {
  const base = params.originalBody?.trim().length
    ? params.originalBody
    : `# ${params.title}\n\n## Notes\n${HUMAN_START}\n${HUMAN_END}\n`;
  const withGenerated = replaceManagedMarkdownBlock({
    original: base,
    heading: "## Summary",
    startMarker: GENERATED_START,
    endMarker: GENERATED_END,
    body: params.generatedBody,
  });
  return ensureHumanNotesBlock(withGenerated);
}

type VaultRoot = Awaited<ReturnType<typeof fsRoot>>;

function isMissingWikiPageError(error: unknown): boolean {
  return error instanceof FsSafeError && error.code === "not-found";
}

async function readExistingWikiPage(root: VaultRoot, pagePath: string): Promise<string> {
  try {
    return await root.readText(pagePath);
  } catch {
    try {
      return await root.readText(pagePath);
    } catch (retryError) {
      if (isMissingWikiPageError(retryError)) {
        return "";
      }
      throw retryError;
    }
  }
}

async function writeWikiPage(params: {
  rootDir: string;
  relativePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}): Promise<boolean> {
  const root = await fsRoot(params.rootDir);
  const rendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: params.frontmatter,
      body: params.body,
    }),
  );
  const existing = await readExistingWikiPage(root, params.relativePath);
  if (existing === rendered) {
    return false;
  }
  await root.write(params.relativePath, rendered);
  return true;
}

async function resolveWritablePage(params: {
  config: ResolvedMemoryWikiConfig;
  lookup: string;
}): Promise<QueryableWikiPage | null> {
  const pages = await readQueryableWikiPages(params.config.vault.path);
  return resolveQueryableWikiPageByLookup(pages, params.lookup);
}

async function applyCreateSynthesisMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: CreateSynthesisMemoryWikiMutation;
}): Promise<{ changed: boolean; pagePath: string; pageId: string }> {
  const slug = slugifyWikiSegment(params.mutation.title);
  const pageStem = slugifyWikiPageStem(params.mutation.title);
  const pagePath = path.join("syntheses", `${pageStem}.md`).replace(/\\/g, "/");
  const root = await fsRoot(params.config.vault.path);
  const existing = await readExistingWikiPage(root, pagePath);
  const parsed = parseWikiMarkdown(existing);
  const pageId =
    (typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim()) ||
    `synthesis.${slug}`;
  const relationships = await resolveVerifiedRelationships({
    config: params.config,
    proposed: params.mutation.relationships,
    sourcePath: pagePath,
  });
  const changed = await writeWikiPage({
    rootDir: params.config.vault.path,
    relativePath: pagePath,
    frontmatter: {
      ...parsed.frontmatter,
      pageType: "synthesis",
      id: pageId,
      title: params.mutation.title,
      sourceIds: normalizeSourceIds(params.mutation.sourceIds),
      ...(params.mutation.claims ? { claims: normalizeWikiClaims(params.mutation.claims) } : {}),
      ...(normalizeUniqueStrings(params.mutation.contradictions)
        ? { contradictions: normalizeUniqueStrings(params.mutation.contradictions) }
        : {}),
      ...(normalizeUniqueStrings(params.mutation.questions)
        ? { questions: normalizeUniqueStrings(params.mutation.questions) }
        : {}),
      ...(typeof params.mutation.confidence === "number"
        ? { confidence: params.mutation.confidence }
        : {}),
      ...(relationships && relationships.length > 0 ? { relationships } : {}),
      status: params.mutation.status?.trim() || "active",
      updatedAt: new Date().toISOString(),
    },
    body: buildSynthesisBody({
      title: params.mutation.title,
      originalBody: parsed.body,
      generatedBody: params.mutation.body.trim(),
    }),
  });
  return { changed, pagePath, pageId };
}

function buildUpdatedFrontmatter(params: {
  original: Record<string, unknown>;
  mutation: UpdateMetadataMemoryWikiMutation;
  relationships?: WikiRelationship[];
}): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    ...params.original,
    updatedAt: new Date().toISOString(),
  };
  if (params.mutation.sourceIds) {
    frontmatter.sourceIds = normalizeSourceIds(params.mutation.sourceIds);
  }
  if (params.mutation.claims) {
    const claims = normalizeWikiClaims(params.mutation.claims);
    if (claims.length > 0) {
      frontmatter.claims = claims;
    } else {
      delete frontmatter.claims;
    }
  }
  if (params.mutation.contradictions) {
    const contradictions = normalizeUniqueStrings(params.mutation.contradictions) ?? [];
    if (contradictions.length > 0) {
      frontmatter.contradictions = contradictions;
    } else {
      delete frontmatter.contradictions;
    }
  }
  if (params.mutation.questions) {
    const questions = normalizeUniqueStrings(params.mutation.questions) ?? [];
    if (questions.length > 0) {
      frontmatter.questions = questions;
    } else {
      delete frontmatter.questions;
    }
  }
  if (params.mutation.confidence === null) {
    delete frontmatter.confidence;
  } else if (typeof params.mutation.confidence === "number") {
    frontmatter.confidence = params.mutation.confidence;
  }
  if (params.mutation.status?.trim()) {
    frontmatter.status = params.mutation.status.trim();
  }
  if (params.relationships && params.relationships.length > 0) {
    frontmatter.relationships = params.relationships;
  } else if (params.mutation.relationships !== undefined) {
    delete frontmatter.relationships;
  }
  return frontmatter;
}

async function applyUpdateMetadataMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: UpdateMetadataMemoryWikiMutation;
}): Promise<{ changed: boolean; pagePath: string; pageId?: string }> {
  const page = await resolveWritablePage({
    config: params.config,
    lookup: params.mutation.lookup,
  });
  if (!page) {
    throw new Error(`Wiki page not found: ${params.mutation.lookup}`);
  }
  const parsed = parseWikiMarkdown(page.raw);
  const relationships = await resolveVerifiedRelationships({
    config: params.config,
    proposed: params.mutation.relationships,
    sourcePath: page.relativePath,
  });
  const changed = await writeWikiPage({
    rootDir: params.config.vault.path,
    relativePath: page.relativePath,
    frontmatter: buildUpdatedFrontmatter({
      original: parsed.frontmatter,
      mutation: params.mutation,
      relationships,
    }),
    body: parsed.body,
  });
  return {
    changed,
    pagePath: page.relativePath,
    ...(page.id ? { pageId: page.id } : {}),
  };
}

async function applyMemoryWikiMutationUnlocked(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: ApplyMemoryWikiMutation;
}): Promise<ApplyMemoryWikiMutationResult> {
  await initializeMemoryWikiVault(params.config);
  const result =
    params.mutation.op === "create_synthesis"
      ? await applyCreateSynthesisMutation({
          config: params.config,
          mutation: params.mutation,
        })
      : await applyUpdateMetadataMutation({
          config: params.config,
          mutation: params.mutation,
        });
  await invalidateMemoryWikiCompiledCache(params.config);
  try {
    const compile = await compileMemoryWikiVault(params.config);
    return {
      changed: result.changed,
      operation: params.mutation.op,
      pagePath: result.pagePath,
      ...(result.pageId ? { pageId: result.pageId } : {}),
      indexesRefreshed: true,
      compile,
    };
  } catch {
    // The source page is authoritative. Report the derived projection failure so the
    // caller can preserve its draft and retry compilation without rewriting content.
    return {
      changed: result.changed,
      operation: params.mutation.op,
      pagePath: result.pagePath,
      ...(result.pageId ? { pageId: result.pageId } : {}),
      indexesRefreshed: false,
    };
  }
}

export async function applyMemoryWikiMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: ApplyMemoryWikiMutation;
}): Promise<ApplyMemoryWikiMutationResult> {
  return await withMemoryWikiVaultMutation(params.config.vault.path, () =>
    applyMemoryWikiMutationUnlocked(params),
  );
}
