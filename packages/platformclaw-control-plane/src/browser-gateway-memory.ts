import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import type { OrganizationMemorySearchHit } from "./contracts.js";

type JsonObject = Record<string, unknown>;

type ProjectionFailure = (message: string) => never;

const MAX_QUERY_CHARS = 1_000;
const MAX_RESULTS = 50;
const MAX_COMBINED_RESULTS = 100;
const MAX_PROVIDER_CHARS = 256;
const MAX_SNIPPET_CHARS = 16 * 1024;
const MAX_MEMORY_FILE_CHARS = 256 * 1024;
const MAX_DOCUMENT_LINES = 5_000;
const MAX_WORKSPACE_LIST_LIMIT = 500;
const ORGANIZATION_MEMORY_PATH =
  /^organization\/(global|team|group|part)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

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
    (hit.kind !== "global" && hit.kind !== "team" && hit.kind !== "group" && hit.kind !== "part") ||
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

function appendOrganizationMemoryResults(
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

export function recoverMissingBrowserMemoryResult(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  error: unknown;
}): JsonObject | undefined {
  const error = isRecord(params.error) ? params.error : null;
  const details = error && isRecord(error.details) ? error.details : null;
  if (
    params.method === "agents.workspace.list" &&
    params.request.path === "memory" &&
    details?.type === "workspace_path_not_found" &&
    details.path === "memory"
  ) {
    return {
      agentId: params.agentId,
      path: "memory",
      parentPath: "",
      entries: [],
      totalEntries: 0,
      offset: 0,
    };
  }
  if (
    params.method === "agents.workspace.get" &&
    params.request.path === "MEMORY.md" &&
    details?.type === "workspace_file_not_found" &&
    details.path === "MEMORY.md"
  ) {
    return {
      agentId: params.agentId,
      file: { path: "MEMORY.md", encoding: "utf8", content: "", missing: true },
    };
  }
  return undefined;
}

export function prepareBrowserMemoryRequest(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  assertOptionalAgentId(value: unknown, label: string): void;
  fail(message: string): never;
}): JsonObject | undefined {
  if (
    params.method !== "memory.search" &&
    params.method !== "agents.workspace.get" &&
    params.method !== "agents.workspace.list" &&
    params.method !== "platformclaw.memory.get"
  ) {
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
  if (params.method === "platformclaw.memory.get") {
    const path = typeof params.request.path === "string" ? params.request.path : "";
    if (!ORGANIZATION_MEMORY_PATH.test(path)) {
      return params.fail("organization memory path is invalid");
    }
    const prepared: JsonObject = { agentId: params.agentId, path };
    for (const [key, max] of [
      ["fromLine", Number.MAX_SAFE_INTEGER],
      ["lineCount", MAX_DOCUMENT_LINES],
    ] as const) {
      const value = params.request[key];
      if (value !== undefined) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
          return params.fail(`${key} must be an integer from 1 to ${max}`);
        }
        prepared[key] = value;
      }
    }
    return prepared;
  }
  if (params.method === "agents.workspace.list") {
    if (params.request.path !== "memory") {
      return params.fail("browser workspace browsing is limited to the personal memory directory");
    }
    return {
      agentId: params.agentId,
      path: "memory",
      offset: 0,
      limit: MAX_WORKSPACE_LIST_LIMIT,
    };
  }
  const path = canonicalMemoryFilePath(params.request.path);
  return path
    ? { agentId: params.agentId, path }
    : params.fail("browser workspace reads are limited to personal memory Markdown files");
}

export async function requestBrowserOrganizationMemoryGet(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  get?: (request: {
    agentId: string;
    path: string;
    fromLine?: number;
    lineCount?: number;
  }) => Promise<import("./contracts.js").OrganizationMemoryDocument | null>;
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (params.method !== "platformclaw.memory.get") {
    return { handled: false };
  }
  if (!params.get) {
    throw new BrowserGatewayProxyError("method-not-allowed", "Organization memory is unavailable");
  }
  const path = params.request.path as string;
  const document = await params.get({
    agentId: params.agentId,
    path,
    ...(typeof params.request.fromLine === "number" ? { fromLine: params.request.fromLine } : {}),
    ...(typeof params.request.lineCount === "number"
      ? { lineCount: params.request.lineCount }
      : {}),
  });
  if (!document) {
    return { handled: true, result: null };
  }
  if (
    document.path !== path ||
    !ORGANIZATION_MEMORY_PATH.test(document.path) ||
    typeof document.content !== "string" ||
    document.content.length > MAX_MEMORY_FILE_CHARS ||
    typeof document.title !== "string" ||
    document.title.length > 512 ||
    (document.scopeKind !== "global" &&
      document.scopeKind !== "team" &&
      document.scopeKind !== "group" &&
      document.scopeKind !== "part") ||
    typeof document.scopeName !== "string" ||
    !document.scopeName ||
    document.scopeName.length > 256 ||
    finiteNumber(document.updatedAt) === null ||
    !positiveInteger(document.fromLine) ||
    !positiveInteger(document.lineCount) ||
    document.lineCount > MAX_DOCUMENT_LINES
  ) {
    throw new BrowserGatewayProxyError(
      "upstream-result-denied",
      "Organization memory returned an invalid document",
    );
  }
  return {
    handled: true,
    result: {
      path: document.path,
      title: document.title,
      kind: document.scopeKind,
      provenanceLabel: document.scopeName,
      content: document.content,
      fromLine: document.fromLine,
      lineCount: document.lineCount,
      updatedAt: new Date(document.updatedAt).toISOString(),
    },
  };
}

export function projectBrowserMemoryResult(params: {
  method: string;
  request: JsonObject;
  result: unknown;
  agentId: string;
  fail: ProjectionFailure;
}): JsonObject | undefined {
  if (
    params.method !== "memory.search" &&
    params.method !== "agents.workspace.get" &&
    params.method !== "agents.workspace.list"
  ) {
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
  if (params.method === "agents.workspace.list") {
    const returnedOffset = finiteNumber(payload.offset);
    const totalEntries = finiteNumber(payload.totalEntries);
    if (
      params.request.path !== "memory" ||
      payload.path !== "memory" ||
      payload.parentPath !== "" ||
      returnedOffset !== 0 ||
      totalEntries === null ||
      !Number.isInteger(totalEntries) ||
      totalEntries < 0 ||
      !Array.isArray(payload.entries) ||
      payload.entries.length > MAX_WORKSPACE_LIST_LIMIT ||
      returnedOffset + payload.entries.length > totalEntries
    ) {
      return params.fail("Gateway returned an invalid personal memory directory");
    }
    const entries = payload.entries.map((value) => {
      const entry = requireObject(value, "workspace list entry", params.fail);
      const name = typeof entry.name === "string" ? entry.name : "";
      const kind = entry.kind === "file" || entry.kind === "directory" ? entry.kind : null;
      const updatedAtMs =
        entry.updatedAtMs === undefined ? undefined : finiteNumber(entry.updatedAtMs);
      if (
        !name ||
        name.length > 1_024 ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        entry.path !== `memory/${name}` ||
        !kind ||
        (entry.updatedAtMs !== undefined &&
          (typeof updatedAtMs !== "number" || !Number.isInteger(updatedAtMs) || updatedAtMs < 0))
      ) {
        return params.fail("Gateway returned an invalid workspace list entry");
      }
      return {
        path: entry.path as string,
        name,
        kind,
        ...(updatedAtMs !== undefined && updatedAtMs !== null ? { updatedAtMs } : {}),
      };
    });
    const projectedEntries = entries.flatMap(({ kind, ...entry }) =>
      kind === "file" && canonicalMemoryFilePath(entry.path) ? [entry] : [],
    );
    return {
      agentId: params.agentId,
      path: "memory",
      entries: projectedEntries,
      ...(entries.some((entry) => entry.kind === "directory")
        ? { hasAdditionalFolders: true }
        : {}),
      ...(payload.entries.length < totalEntries ? { truncated: true } : {}),
    };
  }
  const requestedPath = canonicalMemoryFilePath(params.request.path);
  const file = requireObject(payload.file, "personal memory file", params.fail);
  const returnedPath = canonicalMemoryFilePath(file.path);
  const missing = requestedPath === "MEMORY.md" && file.missing === true;
  if (
    !requestedPath ||
    returnedPath !== requestedPath ||
    file.encoding !== "utf8" ||
    typeof file.content !== "string" ||
    file.content.length > MAX_MEMORY_FILE_CHARS ||
    (file.missing !== undefined && !missing) ||
    (missing && file.content !== "")
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
      ...(missing ? { missing: true } : {}),
    },
  };
}
