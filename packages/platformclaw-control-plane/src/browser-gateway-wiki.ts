import { isRecord } from "@openclaw/normalization-core/record-coerce";

type JsonObject = Record<string, unknown>;
type ProjectionFailure = (message: string) => never;

const WIKI_METHODS = new Set([
  "doctor.memory.backfillDreamDiary",
  "doctor.memory.dedupeDreamDiary",
  "doctor.memory.dreamDiary",
  "doctor.memory.repairDreamingArtifacts",
  "doctor.memory.resetDreamDiary",
  "doctor.memory.resetGroundedShortTerm",
  "doctor.memory.status",
  "wiki.get",
  "wiki.importInsights",
  "wiki.overview",
  "wiki.search",
  "wiki.status",
]);
const DREAM_ACTION_METHODS = new Set([
  "doctor.memory.backfillDreamDiary",
  "doctor.memory.dedupeDreamDiary",
  "doctor.memory.repairDreamingArtifacts",
  "doctor.memory.resetDreamDiary",
  "doctor.memory.resetGroundedShortTerm",
]);
const DREAM_ACTIONS_BY_METHOD: Readonly<Record<string, string>> = {
  "doctor.memory.backfillDreamDiary": "backfill",
  "doctor.memory.dedupeDreamDiary": "dedupeDreamDiary",
  "doctor.memory.repairDreamingArtifacts": "repairDreamingArtifacts",
  "doctor.memory.resetDreamDiary": "reset",
  "doctor.memory.resetGroundedShortTerm": "resetGroundedShortTerm",
};
const MAX_QUERY_CHARS = 1_000;
const MAX_RESULTS = 50;
const MAX_PAGE_LINES = 5_000;
const MAX_CONTENT_CHARS = 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_LIST_ITEMS = 100;
const MAX_TEXT_CHARS = 16 * 1024;
const WIKI_ROOTS = new Set(["entities", "concepts", "sources", "syntheses", "reports"]);

function failObject(value: unknown, label: string, fail: ProjectionFailure): JsonObject {
  return isRecord(value) ? value : fail(`Gateway returned invalid ${label}`);
}

function text(
  value: unknown,
  label: string,
  fail: ProjectionFailure,
  max = MAX_TEXT_CHARS,
): string {
  return typeof value === "string" && value.length <= max
    ? value
    : fail(`Gateway returned invalid ${label}`);
}

function count(value: unknown, label: string, fail: ProjectionFailure): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail(`Gateway returned invalid ${label}`);
}

function score(value: unknown, label: string, fail: ProjectionFailure): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(`Gateway returned invalid ${label}`);
}

function optionalText(
  value: unknown,
  label: string,
  fail: ProjectionFailure,
  max = MAX_TEXT_CHARS,
): string | undefined {
  return value === undefined ? undefined : text(value, label, fail, max);
}

function stringList(value: unknown, label: string, fail: ProjectionFailure): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    return fail(`Gateway returned invalid ${label}`);
  }
  return value.map((entry) => text(entry, label, fail));
}

function relativePath(value: unknown, label: string, fail: ProjectionFailure): string {
  const candidate = text(value, label, fail, 1_024).replaceAll("\\", "/");
  if (
    candidate.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(candidate) ||
    candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return fail(`Gateway returned unsafe ${label}`);
  }
  return candidate;
}

function wikiPath(value: unknown, label: string, fail: ProjectionFailure): string {
  const candidate = relativePath(value, label, fail);
  const [root] = candidate.split("/");
  return root && WIKI_ROOTS.has(root) && candidate.endsWith(".md")
    ? candidate
    : fail(`Gateway returned invalid ${label}`);
}

function memoryPath(value: unknown, label: string, fail: ProjectionFailure): string {
  const candidate = relativePath(value, label, fail);
  return candidate === "MEMORY.md" || (candidate.startsWith("memory/") && candidate.endsWith(".md"))
    ? candidate
    : fail(`Gateway returned invalid ${label}`);
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  fail: ProjectionFailure,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fail(`${label} must be one of: ${allowed.join(", ")}`);
}

function positiveInteger(
  value: unknown,
  label: string,
  max: number,
  fail: ProjectionFailure,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : fail(`${label} must be an integer from 1 to ${max}`);
}

function projectDreamingEntry(value: unknown, fail: ProjectionFailure): JsonObject {
  const entry = failObject(value, "dreaming entry", fail);
  return {
    key: text(entry.key, "dreaming entry key", fail, 1_024),
    path: memoryPath(entry.path, "dreaming entry path", fail),
    startLine: count(entry.startLine, "dreaming entry startLine", fail),
    endLine: count(entry.endLine, "dreaming entry endLine", fail),
    snippet: text(entry.snippet, "dreaming entry snippet", fail),
    recallCount: count(entry.recallCount, "dreaming entry recallCount", fail),
    dailyCount: count(entry.dailyCount, "dreaming entry dailyCount", fail),
    groundedCount: count(entry.groundedCount, "dreaming entry groundedCount", fail),
    totalSignalCount: count(entry.totalSignalCount, "dreaming entry totalSignalCount", fail),
    lightHits: count(entry.lightHits, "dreaming entry lightHits", fail),
    remHits: count(entry.remHits, "dreaming entry remHits", fail),
    phaseHitCount: count(entry.phaseHitCount, "dreaming entry phaseHitCount", fail),
    ...(optionalText(entry.promotedAt, "dreaming entry promotedAt", fail)
      ? { promotedAt: entry.promotedAt }
      : {}),
    ...(optionalText(entry.lastRecalledAt, "dreaming entry lastRecalledAt", fail)
      ? { lastRecalledAt: entry.lastRecalledAt }
      : {}),
  };
}

function projectDreaming(rawValue: unknown, fail: ProjectionFailure): JsonObject | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const dreaming = failObject(rawValue, "dreaming status", fail);
  const entries = (key: string) => {
    const values = dreaming[key];
    if (!Array.isArray(values) || values.length > MAX_ITEMS) {
      return fail(`Gateway returned invalid dreaming ${key}`);
    }
    return values.map((entry) => projectDreamingEntry(entry, fail));
  };
  const phases = failObject(dreaming.phases, "dreaming phases", fail);
  const projectPhase = (phaseValue: unknown, label: string) => {
    const phase = failObject(phaseValue, label, fail);
    const result: JsonObject = {};
    for (const key of [
      "enabled",
      "cron",
      "managedCronPresent",
      "nextRunAtMs",
      "lookbackDays",
      "limit",
      "minScore",
      "minRecallCount",
      "minUniqueQueries",
      "recencyHalfLifeDays",
      "maxAgeDays",
      "minPatternStrength",
    ] as const) {
      const item = phase[key];
      if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
        result[key] = item;
      } else if (key === "cron" && typeof item === "string" && item.length <= 1_024) {
        result[key] = item;
      }
    }
    return result;
  };
  const result: JsonObject = {
    enabled: dreaming.enabled === true,
    verboseLogging: dreaming.verboseLogging === true,
    storageMode: optionalEnum(
      dreaming.storageMode,
      ["inline", "separate", "both"],
      "storageMode",
      fail,
    ),
    separateReports: dreaming.separateReports === true,
    shortTermCount: count(dreaming.shortTermCount, "shortTermCount", fail),
    recallSignalCount: count(dreaming.recallSignalCount, "recallSignalCount", fail),
    dailySignalCount: count(dreaming.dailySignalCount, "dailySignalCount", fail),
    groundedSignalCount: count(dreaming.groundedSignalCount, "groundedSignalCount", fail),
    totalSignalCount: count(dreaming.totalSignalCount, "totalSignalCount", fail),
    phaseSignalCount: count(dreaming.phaseSignalCount, "phaseSignalCount", fail),
    lightPhaseHitCount: count(dreaming.lightPhaseHitCount, "lightPhaseHitCount", fail),
    remPhaseHitCount: count(dreaming.remPhaseHitCount, "remPhaseHitCount", fail),
    promotedTotal: count(dreaming.promotedTotal, "promotedTotal", fail),
    promotedToday: count(dreaming.promotedToday, "promotedToday", fail),
    shortTermEntries: entries("shortTermEntries"),
    signalEntries: entries("signalEntries"),
    promotedEntries: entries("promotedEntries"),
    phases: {
      light: projectPhase(phases.light, "light dreaming phase"),
      deep: projectPhase(phases.deep, "deep dreaming phase"),
      rem: projectPhase(phases.rem, "REM dreaming phase"),
    },
  };
  const timezone = optionalText(dreaming.timezone, "dreaming timezone", fail, 256);
  const lastPromotedAt = optionalText(dreaming.lastPromotedAt, "lastPromotedAt", fail, 256);
  return {
    ...result,
    ...(timezone ? { timezone } : {}),
    ...(lastPromotedAt ? { lastPromotedAt } : {}),
  };
}

function projectWikiOverviewItem(value: unknown, fail: ProjectionFailure): JsonObject {
  const item = failObject(value, "wiki overview item", fail);
  const kind = optionalEnum(
    item.kind,
    ["entity", "concept", "source", "synthesis", "report"],
    "kind",
    fail,
  );
  if (!kind) {
    return fail("Gateway returned invalid wiki overview kind");
  }
  return {
    pagePath: wikiPath(item.pagePath, "wiki page path", fail),
    title: text(item.title, "wiki title", fail),
    kind,
    ...(optionalText(item.id, "wiki id", fail, 1_024) ? { id: item.id } : {}),
    ...(optionalText(item.updatedAt, "wiki updatedAt", fail, 256)
      ? { updatedAt: item.updatedAt }
      : {}),
    ...(optionalText(item.sourceType, "wiki sourceType", fail, 256)
      ? { sourceType: item.sourceType }
      : {}),
    claimCount: count(item.claimCount, "wiki claimCount", fail),
    questionCount: count(item.questionCount, "wiki questionCount", fail),
    contradictionCount: count(item.contradictionCount, "wiki contradictionCount", fail),
    claims: stringList(item.claims, "wiki claims", fail),
    questions: stringList(item.questions, "wiki questions", fail),
    contradictions: stringList(item.contradictions, "wiki contradictions", fail),
    ...(optionalText(item.snippet, "wiki snippet", fail) ? { snippet: item.snippet } : {}),
  };
}

function projectWikiClusters(value: unknown, fail: ProjectionFailure): JsonObject[] {
  if (!Array.isArray(value) || value.length > 10) {
    return fail("Gateway returned invalid wiki clusters");
  }
  return value.map((raw) => {
    const cluster = failObject(raw, "wiki cluster", fail);
    if (!Array.isArray(cluster.items) || cluster.items.length > MAX_ITEMS) {
      return fail("Gateway returned invalid wiki cluster items");
    }
    return {
      key: text(cluster.key, "wiki cluster key", fail, 256),
      label: text(cluster.label, "wiki cluster label", fail, 1_024),
      itemCount: count(cluster.itemCount, "wiki cluster itemCount", fail),
      claimCount: count(cluster.claimCount, "wiki cluster claimCount", fail),
      questionCount: count(cluster.questionCount, "wiki cluster questionCount", fail),
      contradictionCount: count(
        cluster.contradictionCount,
        "wiki cluster contradictionCount",
        fail,
      ),
      ...(optionalText(cluster.updatedAt, "wiki cluster updatedAt", fail, 256)
        ? { updatedAt: cluster.updatedAt }
        : {}),
      items: cluster.items.map((item) => projectWikiOverviewItem(item, fail)),
    };
  });
}

function projectImportInsights(value: unknown, fail: ProjectionFailure): JsonObject {
  const payload = failObject(value, "wiki import insights", fail);
  if (!Array.isArray(payload.clusters) || payload.clusters.length > MAX_ITEMS) {
    return fail("Gateway returned invalid wiki insight clusters");
  }
  return {
    sourceType:
      payload.sourceType === "chatgpt"
        ? "chatgpt"
        : fail("Gateway returned invalid wiki insight sourceType"),
    totalItems: count(payload.totalItems, "wiki insight totalItems", fail),
    totalClusters: count(payload.totalClusters, "wiki insight totalClusters", fail),
    clusters: payload.clusters.map((raw) => {
      const cluster = failObject(raw, "wiki insight cluster", fail);
      if (!Array.isArray(cluster.items) || cluster.items.length > MAX_ITEMS) {
        return fail("Gateway returned invalid wiki insight items");
      }
      const projectedCluster: JsonObject = {
        key: text(cluster.key, "wiki insight cluster key", fail, 1_024),
        label: text(cluster.label, "wiki insight cluster label", fail),
        itemCount: count(cluster.itemCount, "wiki insight itemCount", fail),
        highRiskCount: count(cluster.highRiskCount, "wiki insight highRiskCount", fail),
        withheldCount: count(cluster.withheldCount, "wiki insight withheldCount", fail),
        preferenceSignalCount: count(
          cluster.preferenceSignalCount,
          "wiki insight preferenceSignalCount",
          fail,
        ),
        items: cluster.items.map((entry) => {
          const item = failObject(entry, "wiki insight item", fail);
          const riskLevel = optionalEnum(
            item.riskLevel,
            ["low", "medium", "high", "unknown"],
            "riskLevel",
            fail,
          );
          const digestStatus = optionalEnum(
            item.digestStatus,
            ["available", "withheld"],
            "digestStatus",
            fail,
          );
          if (!riskLevel || !digestStatus) {
            return fail("Gateway returned invalid wiki insight enum");
          }
          const projected: JsonObject = {
            pagePath: wikiPath(item.pagePath, "wiki insight pagePath", fail),
            title: text(item.title, "wiki insight title", fail),
            riskLevel,
            riskReasons: stringList(item.riskReasons, "wiki insight riskReasons", fail),
            labels: stringList(item.labels, "wiki insight labels", fail),
            topicKey: text(item.topicKey, "wiki insight topicKey", fail),
            topicLabel: text(item.topicLabel, "wiki insight topicLabel", fail),
            digestStatus,
            activeBranchMessages: count(
              item.activeBranchMessages,
              "wiki insight activeBranchMessages",
              fail,
            ),
            userMessageCount: count(item.userMessageCount, "wiki insight userMessageCount", fail),
            assistantMessageCount: count(
              item.assistantMessageCount,
              "wiki insight assistantMessageCount",
              fail,
            ),
            summary: text(item.summary, "wiki insight summary", fail),
            candidateSignals: stringList(
              item.candidateSignals,
              "wiki insight candidateSignals",
              fail,
            ),
            correctionSignals: stringList(
              item.correctionSignals,
              "wiki insight correctionSignals",
              fail,
            ),
            preferenceSignals: stringList(
              item.preferenceSignals,
              "wiki insight preferenceSignals",
              fail,
            ),
          };
          for (const key of [
            "firstUserLine",
            "lastUserLine",
            "assistantOpener",
            "createdAt",
            "updatedAt",
          ] as const) {
            const fieldValue = optionalText(item[key], `wiki insight ${key}`, fail);
            if (fieldValue !== undefined) {
              projected[key] = fieldValue;
            }
          }
          return projected;
        }),
      };
      const updatedAt = optionalText(cluster.updatedAt, "wiki insight updatedAt", fail, 256);
      if (updatedAt !== undefined) {
        projectedCluster.updatedAt = updatedAt;
      }
      return projectedCluster;
    }),
  };
}

export function prepareBrowserWikiRequest(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  assertOptionalAgentId(value: unknown, label: string): void;
  fail: ProjectionFailure;
}): JsonObject | undefined {
  if (!WIKI_METHODS.has(params.method)) {
    return undefined;
  }
  params.assertOptionalAgentId(params.request.agentId, params.method);
  const prepared: JsonObject = { agentId: params.agentId };
  if (params.method === "doctor.memory.status" && params.request.probe !== undefined) {
    if (typeof params.request.probe !== "boolean") {
      return params.fail("memory status probe must be a boolean");
    }
    prepared.probe = params.request.probe;
  }
  if (params.method === "wiki.search") {
    const query = typeof params.request.query === "string" ? params.request.query.trim() : "";
    if (!query || query.length > MAX_QUERY_CHARS) {
      return params.fail(`wiki search query must contain 1-${MAX_QUERY_CHARS} characters`);
    }
    prepared.query = query;
    const maxResults = positiveInteger(
      params.request.maxResults,
      "maxResults",
      MAX_RESULTS,
      params.fail,
    );
    if (maxResults !== undefined) {
      prepared.maxResults = maxResults;
    }
    const mode = optionalEnum(
      params.request.mode,
      ["auto", "find-person", "route-question", "source-evidence", "raw-claim"],
      "mode",
      params.fail,
    );
    if (mode) {
      prepared.mode = mode;
    }
  } else if (params.method === "wiki.get") {
    const lookup = typeof params.request.lookup === "string" ? params.request.lookup.trim() : "";
    if (!lookup || lookup.length > MAX_QUERY_CHARS) {
      return params.fail(`wiki lookup must contain 1-${MAX_QUERY_CHARS} characters`);
    }
    prepared.lookup = lookup;
    for (const [key, max] of [
      ["fromLine", Number.MAX_SAFE_INTEGER],
      ["lineCount", MAX_PAGE_LINES],
    ] as const) {
      const value = positiveInteger(params.request[key], key, max, params.fail);
      if (value !== undefined) {
        prepared[key] = value;
      }
    }
  }
  return prepared;
}

export function projectBrowserWikiResult(params: {
  method: string;
  request: JsonObject;
  result: unknown;
  agentId: string;
  fail: ProjectionFailure;
}): JsonObject | JsonObject[] | null | undefined {
  if (!WIKI_METHODS.has(params.method)) {
    return undefined;
  }
  if (DREAM_ACTION_METHODS.has(params.method)) {
    const payload = failObject(params.result, "dreaming action", params.fail);
    if (payload.agentId !== params.agentId) {
      return params.fail("Gateway returned dreaming action outside the browser binding");
    }
    const expectedAction = DREAM_ACTIONS_BY_METHOD[params.method];
    if (!expectedAction || payload.action !== expectedAction) {
      return params.fail("Gateway returned mismatched dreaming action");
    }
    const result: JsonObject = {
      agentId: params.agentId,
      action: expectedAction,
    };
    if (payload.path !== undefined) {
      result.path =
        payload.path === "DREAMS.md" || payload.path === "dreams.md"
          ? payload.path
          : params.fail("Gateway returned invalid dreaming action path");
    }
    for (const key of [
      "found",
      "changed",
      "archivedDreamsDiary",
      "archivedSessionCorpus",
      "archivedSessionIngestion",
    ] as const) {
      if (typeof payload[key] === "boolean") {
        result[key] = payload[key];
      }
    }
    for (const key of [
      "scannedFiles",
      "written",
      "replaced",
      "removedEntries",
      "removedShortTermEntries",
      "dedupedEntries",
      "keptEntries",
    ] as const) {
      if (payload[key] !== undefined) {
        result[key] = count(payload[key], `dreaming action ${key}`, params.fail);
      }
    }
    return result;
  }
  if (params.method === "doctor.memory.dreamDiary") {
    const payload = failObject(params.result, "dream diary", params.fail);
    if (payload.agentId !== params.agentId || typeof payload.found !== "boolean") {
      return params.fail("Gateway returned dream diary outside the browser binding");
    }
    const path =
      payload.path === "DREAMS.md" || payload.path === "dreams.md"
        ? payload.path
        : params.fail("Gateway returned invalid dream diary path");
    return {
      agentId: params.agentId,
      found: payload.found,
      path,
      ...(payload.found
        ? { content: text(payload.content, "dream diary content", params.fail, MAX_CONTENT_CHARS) }
        : {}),
      ...(typeof payload.updatedAtMs === "number" && Number.isFinite(payload.updatedAtMs)
        ? { updatedAtMs: payload.updatedAtMs }
        : {}),
    };
  }
  if (params.method === "doctor.memory.status") {
    const payload = failObject(params.result, "memory status", params.fail);
    if (payload.agentId !== params.agentId) {
      return params.fail("Gateway returned memory status outside the browser binding");
    }
    const embedding = failObject(payload.embedding, "memory embedding status", params.fail);
    const projectedEmbedding: JsonObject = { ok: embedding.ok === true };
    if (embedding.ok !== true && typeof embedding.error === "string") {
      projectedEmbedding.error =
        "Memory embeddings unavailable; ask a PlatformClaw administrator to check provider setup.";
    }
    for (const key of ["checked", "cached"] as const) {
      if (typeof embedding[key] === "boolean") {
        projectedEmbedding[key] = embedding[key];
      }
    }
    for (const key of ["checkedAtMs", "cacheExpiresAtMs"] as const) {
      if (typeof embedding[key] === "number" && Number.isFinite(embedding[key])) {
        projectedEmbedding[key] = embedding[key];
      }
    }
    const dreaming = projectDreaming(payload.dreaming, params.fail);
    return {
      agentId: params.agentId,
      ...(typeof payload.provider === "string" && payload.provider.length <= 256
        ? { provider: payload.provider }
        : {}),
      embedding: projectedEmbedding,
      ...(dreaming ? { dreaming } : {}),
    };
  }
  if (params.method === "wiki.importInsights") {
    return projectImportInsights(params.result, params.fail);
  }
  if (params.method === "wiki.overview") {
    const payload = failObject(params.result, "wiki overview", params.fail);
    const pageCounts = failObject(payload.pageCounts, "wiki page counts", params.fail);
    return {
      totalItems: count(payload.totalItems, "wiki totalItems", params.fail),
      totalPages: count(payload.totalPages, "wiki totalPages", params.fail),
      pageCounts: Object.fromEntries(
        ["entity", "concept", "source", "synthesis", "report"].map((key) => [
          key,
          count(pageCounts[key], `wiki ${key} count`, params.fail),
        ]),
      ),
      totalClaims: count(payload.totalClaims, "wiki totalClaims", params.fail),
      totalQuestions: count(payload.totalQuestions, "wiki totalQuestions", params.fail),
      totalContradictions: count(
        payload.totalContradictions,
        "wiki totalContradictions",
        params.fail,
      ),
      clusters: projectWikiClusters(payload.clusters, params.fail),
    };
  }
  if (params.method === "wiki.status") {
    const payload = failObject(params.result, "wiki status", params.fail);
    if (payload.agentId !== params.agentId) {
      return params.fail("Gateway returned wiki status outside the browser binding");
    }
    return {
      agentId: params.agentId,
      vaultScope:
        payload.vaultScope === "agent"
          ? "agent"
          : params.fail("Gateway returned non-personal wiki scope"),
      vaultMode:
        payload.vaultMode === "bridge"
          ? "bridge"
          : params.fail("Gateway returned non-bridge wiki mode"),
      renderMode:
        payload.renderMode === "native"
          ? "native"
          : params.fail("Gateway returned non-native wiki render mode"),
      vaultExists: payload.vaultExists === true,
      pageCounts: Object.fromEntries(
        ["entity", "concept", "source", "synthesis", "report"].map((key) => [
          key,
          count(
            failObject(payload.pageCounts, "wiki page counts", params.fail)[key],
            `wiki ${key} count`,
            params.fail,
          ),
        ]),
      ),
      sourceCounts: Object.fromEntries(
        ["native", "bridge", "bridgeEvents", "unsafeLocal", "other"].map((key) => [
          key,
          count(
            failObject(payload.sourceCounts, "wiki source counts", params.fail)[key],
            `wiki ${key} source count`,
            params.fail,
          ),
        ]),
      ),
      bridgePublicArtifactCount:
        payload.bridgePublicArtifactCount === null
          ? null
          : count(payload.bridgePublicArtifactCount, "bridge artifact count", params.fail),
    };
  }
  if (params.method === "wiki.search") {
    if (!Array.isArray(params.result) || params.result.length > MAX_RESULTS) {
      return params.fail("Gateway returned invalid wiki search results");
    }
    return params.result.map((raw) => {
      const item = failObject(raw, "wiki search result", params.fail);
      const corpus =
        item.corpus === "wiki" ? "wiki" : params.fail("Gateway returned non-wiki search corpus");
      const path = wikiPath(item.path, "wiki search path", params.fail);
      return {
        corpus,
        path,
        title: text(item.title, "wiki search title", params.fail),
        kind: text(item.kind, "wiki search kind", params.fail, 256),
        score: score(item.score, "wiki search score", params.fail),
        snippet: text(item.snippet, "wiki search snippet", params.fail),
        ...(optionalText(item.id, "wiki search id", params.fail, 1_024) ? { id: item.id } : {}),
        ...(typeof item.startLine === "number"
          ? { startLine: count(item.startLine, "wiki search startLine", params.fail) }
          : {}),
        ...(typeof item.endLine === "number"
          ? { endLine: count(item.endLine, "wiki search endLine", params.fail) }
          : {}),
        ...(optionalText(item.updatedAt, "wiki search updatedAt", params.fail, 256)
          ? { updatedAt: item.updatedAt }
          : {}),
      };
    });
  }
  if (params.result === null) {
    return null;
  }
  const item = failObject(params.result, "wiki page", params.fail);
  const corpus =
    item.corpus === "wiki" ? "wiki" : params.fail("Gateway returned non-wiki page corpus");
  return {
    corpus,
    path: wikiPath(item.path, "wiki page path", params.fail),
    title: text(item.title, "wiki page title", params.fail),
    kind: text(item.kind, "wiki page kind", params.fail, 256),
    content: text(item.content, "wiki page content", params.fail, MAX_CONTENT_CHARS),
    fromLine: count(item.fromLine, "wiki page fromLine", params.fail),
    lineCount: count(item.lineCount, "wiki page lineCount", params.fail),
    ...(typeof item.totalLines === "number"
      ? { totalLines: count(item.totalLines, "wiki page totalLines", params.fail) }
      : {}),
    ...(item.truncated === true ? { truncated: true } : {}),
    ...(optionalText(item.updatedAt, "wiki page updatedAt", params.fail, 256)
      ? { updatedAt: item.updatedAt }
      : {}),
  };
}
