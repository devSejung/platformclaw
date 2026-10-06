import { wikiPath } from "./browser-gateway-content-paths.js";
import {
  count,
  failObject,
  optionalEnum,
  optionalText,
  projectCompileFailure,
  stringList,
  text,
  type JsonObject,
  type ProjectionFailure,
} from "./browser-gateway-wiki-projection.js";

const MAX_CLUSTER_ITEMS = 500;

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
    if (!Array.isArray(cluster.items) || cluster.items.length > MAX_CLUSTER_ITEMS) {
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

export function projectWikiOverview(value: unknown, fail: ProjectionFailure): JsonObject {
  const payload = failObject(value, "wiki overview", fail);
  const pageCounts = failObject(payload.pageCounts, "wiki page counts", fail);
  const totalPages = count(payload.totalPages, "wiki totalPages", fail);
  const catalog: JsonObject = {};
  if (payload.documents !== undefined) {
    if (
      !Array.isArray(payload.documents) ||
      payload.documents.length > 1000 ||
      typeof payload.documentsTruncated !== "boolean" ||
      payload.documents.length > totalPages ||
      payload.documentsTruncated !== payload.documents.length < totalPages
    ) {
      return fail("Gateway returned invalid wiki document catalog");
    }
    const documents = payload.documents.map((item) => projectWikiOverviewItem(item, fail));
    if (new Set(documents.map((item) => item.pagePath)).size !== documents.length) {
      return fail("Gateway returned duplicate wiki catalog paths");
    }
    catalog.documents = documents;
    catalog.documentsTruncated = payload.documentsTruncated;
  }
  return {
    ...catalog,
    ...projectCompileFailure(payload.compileFailure, fail),
    ...(typeof payload.sourceSyncComplete === "boolean"
      ? { sourceSyncComplete: payload.sourceSyncComplete }
      : {}),
    totalItems: count(payload.totalItems, "wiki totalItems", fail),
    totalPages,
    pageCounts: Object.fromEntries(
      ["entity", "concept", "source", "synthesis", "report"].map((key) => [
        key,
        count(pageCounts[key], `wiki ${key} count`, fail),
      ]),
    ),
    totalClaims: count(payload.totalClaims, "wiki totalClaims", fail),
    totalQuestions: count(payload.totalQuestions, "wiki totalQuestions", fail),
    totalContradictions: count(payload.totalContradictions, "wiki totalContradictions", fail),
    clusters: projectWikiClusters(payload.clusters, fail),
  };
}
