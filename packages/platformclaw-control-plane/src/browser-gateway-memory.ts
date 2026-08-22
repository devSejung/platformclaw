import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OrganizationMemorySearchHit } from "./contracts.js";

type JsonObject = Record<string, unknown>;

type ProjectionFailure = (message: string) => never;

const MAX_QUERY_CHARS = 1_000;
const MAX_RESULTS = 50;
const MAX_COMBINED_RESULTS = 100;
const MAX_PROVIDER_CHARS = 256;
const MAX_SNIPPET_CHARS = 16 * 1024;
const MAX_MEMORY_FILE_CHARS = 256 * 1024;
const ORGANIZATION_MEMORY_PATH =
  /^organization\/(global|group|part)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

function requireObject(value: unknown, label: string, fail: ProjectionFailure): JsonObject {
  return isRecord(value) ? value : fail(`Gateway returned invalid ${label}`);
}

function canonicalMemoryFilePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 1_024) {
    return null;
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized === "MEMORY.md" ||
    (normalized.startsWith("memory/") && normalized.endsWith(".md"))
    ? normalized
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function projectMemorySearchHit(value: unknown, fail: ProjectionFailure): JsonObject {
  const hit = requireObject(value, "memory search hit", fail);
  const path = canonicalMemoryFilePath(hit.path);
  const startLine = positiveInteger(hit.startLine);
  const endLine = positiveInteger(hit.endLine);
  const score = finiteNumber(hit.score);
  if (
    !path ||
    startLine === null ||
    endLine === null ||
    endLine < startLine ||
    score === null ||
    typeof hit.snippet !== "string" ||
    hit.snippet.length > MAX_SNIPPET_CHARS
  ) {
    return fail("Gateway returned an invalid personal memory search hit");
  }
  return { path, startLine, endLine, score, snippet: hit.snippet, source: "memory" };
}

function projectOrganizationMemorySearchHit(value: unknown, fail: ProjectionFailure): JsonObject {
  const hit = requireObject(value, "organization memory search hit", fail);
  const score = finiteNumber(hit.score);
  if (
    typeof hit.path !== "string" ||
    !ORGANIZATION_MEMORY_PATH.test(hit.path) ||
    score === null ||
    typeof hit.snippet !== "string" ||
    hit.snippet.length > MAX_SNIPPET_CHARS ||
    typeof hit.title !== "string" ||
    hit.title.length > 512 ||
    (hit.kind !== "global" && hit.kind !== "group" && hit.kind !== "part") ||
    typeof hit.provenanceLabel !== "string" ||
    !hit.provenanceLabel ||
    hit.provenanceLabel.length > 256
  ) {
    return fail("Gateway returned an invalid organization memory search hit");
  }
  return {
    corpus: "platformclaw-organization",
    source: "organization",
    path: hit.path,
    title: hit.title,
    kind: hit.kind,
    score,
    snippet: hit.snippet,
    startLine: 1,
    endLine: 1,
    provenanceLabel: hit.provenanceLabel,
    ...(typeof hit.updatedAt === "string" ? { updatedAt: hit.updatedAt } : {}),
  };
}

export function appendOrganizationMemoryResults(
  result: unknown,
  organizationResults: readonly OrganizationMemorySearchHit[],
): unknown {
  if (!isRecord(result) || !Array.isArray(result.results)) {
    return result;
  }
  return {
    ...result,
    results: [
      ...result.results,
      ...organizationResults.map((hit) => ({
        corpus: "platformclaw-organization",
        source: "organization",
        path: hit.path,
        title: hit.title,
        kind: hit.scopeKind,
        score: hit.score,
        snippet: hit.snippet,
        startLine: 1,
        endLine: 1,
        provenanceLabel: hit.scopeName,
        updatedAt: new Date(hit.updatedAt).toISOString(),
      })),
    ],
  };
}

export async function appendOrganizationMemorySearch(
  method: string,
  result: unknown,
  agentId: string,
  query: string,
  search?: (params: {
    agentId: string;
    query: string;
    maxResults?: number;
  }) => Promise<OrganizationMemorySearchHit[]>,
): Promise<unknown> {
  if (method !== "memory.search" || !search) {
    return result;
  }
  try {
    return appendOrganizationMemoryResults(
      result,
      await search({ agentId, query, maxResults: 20 }),
    );
  } catch {
    // Organization memory is supplemental: its outage must not hide personal memory.
    return isRecord(result) ? { ...result, organizationMemoryUnavailable: true } : result;
  }
}

export function prepareBrowserMemoryRequest(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  assertOptionalAgentId(value: unknown, label: string): void;
  fail(message: string): never;
}): JsonObject | undefined {
  if (params.method !== "memory.search" && params.method !== "agents.workspace.get") {
    return undefined;
  }
  params.assertOptionalAgentId(params.request.agentId, params.method);
  if (params.method === "memory.search") {
    const query = typeof params.request.query === "string" ? params.request.query.trim() : "";
    if (!query || query.length > MAX_QUERY_CHARS) {
      return params.fail(`memory search query must contain 1-${MAX_QUERY_CHARS} characters`);
    }
    return { query, agentId: params.agentId };
  }
  const path = canonicalMemoryFilePath(params.request.path);
  return path
    ? { agentId: params.agentId, path }
    : params.fail("browser workspace reads are limited to personal memory Markdown files");
}

export function projectBrowserMemoryResult(params: {
  method: string;
  request: JsonObject;
  result: unknown;
  agentId: string;
  fail: ProjectionFailure;
}): JsonObject | undefined {
  if (params.method !== "memory.search" && params.method !== "agents.workspace.get") {
    return undefined;
  }
  const payload = requireObject(params.result, `${params.method} result`, params.fail);
  if (payload.agentId !== params.agentId) {
    return params.fail("Gateway returned memory outside the browser binding");
  }
  if (params.method === "memory.search") {
    if (
      typeof payload.provider !== "string" ||
      payload.provider.length > MAX_PROVIDER_CHARS ||
      (payload.searchMode !== "hybrid" && payload.searchMode !== "fts-only") ||
      !Array.isArray(payload.results) ||
      payload.results.length > MAX_COMBINED_RESULTS
    ) {
      return params.fail("Gateway returned an invalid personal memory search result");
    }
    // Session transcripts have separate visibility; this surface exposes pinned long-term memory.
    const memoryHits = payload.results.filter(
      (value) =>
        isRecord(value) && value.source === "memory" && canonicalMemoryFilePath(value.path),
    );
    const organizationHits = payload.results.filter(
      (value) =>
        isRecord(value) &&
        value.source === "organization" &&
        typeof value.path === "string" &&
        ORGANIZATION_MEMORY_PATH.test(value.path),
    );
    const results = [
      ...memoryHits.map((hit) => projectMemorySearchHit(hit, params.fail)),
      ...organizationHits.map((hit) => projectOrganizationMemorySearchHit(hit, params.fail)),
    ]
      .toSorted((left, right) => (finiteNumber(right.score) ?? 0) - (finiteNumber(left.score) ?? 0))
      .slice(0, MAX_RESULTS);
    return {
      agentId: params.agentId,
      provider: payload.provider,
      searchMode: payload.searchMode,
      results,
      ...(payload.stale === true ? { stale: true } : {}),
      ...(payload.organizationMemoryUnavailable === true
        ? { organizationMemoryUnavailable: true }
        : {}),
    };
  }
  const requestedPath = canonicalMemoryFilePath(params.request.path);
  const file = requireObject(payload.file, "personal memory file", params.fail);
  const returnedPath = canonicalMemoryFilePath(file.path);
  if (
    !requestedPath ||
    returnedPath !== requestedPath ||
    file.encoding !== "utf8" ||
    typeof file.content !== "string" ||
    file.content.length > MAX_MEMORY_FILE_CHARS
  ) {
    return params.fail("Gateway returned an invalid personal memory file");
  }
  return {
    agentId: params.agentId,
    file: {
      path: requestedPath,
      name: requestedPath.slice(requestedPath.lastIndexOf("/") + 1),
      ...(typeof file.size === "number" ? { size: file.size } : {}),
      ...(typeof file.updatedAtMs === "number" ? { updatedAtMs: file.updatedAtMs } : {}),
      mimeType: "text/plain",
      encoding: "utf8",
      content: file.content,
    },
  };
}
