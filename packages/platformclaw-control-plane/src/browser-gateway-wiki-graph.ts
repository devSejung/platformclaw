import { wikiPath } from "./browser-gateway-content-paths.js";
import {
  count,
  failObject,
  optionalEnum,
  optionalText,
  text,
  type JsonObject,
  type ProjectionFailure,
} from "./browser-gateway-wiki-projection.js";

const MAX_GRAPH_NODES = 500;
const MAX_GRAPH_EDGES = 2_000;

export function projectWikiGraph(
  rawValue: unknown,
  agentId: string,
  fail: ProjectionFailure,
): JsonObject {
  const payload = failObject(rawValue, "wiki graph", fail);
  if (payload.agentId !== undefined && payload.agentId !== agentId) {
    return fail("Gateway returned wiki graph outside the browser binding");
  }
  if (!Array.isArray(payload.nodes) || payload.nodes.length > MAX_GRAPH_NODES) {
    return fail("Gateway returned invalid wiki graph nodes");
  }
  if (!Array.isArray(payload.edges) || payload.edges.length > MAX_GRAPH_EDGES) {
    return fail("Gateway returned invalid wiki graph edges");
  }
  const nodes = payload.nodes.map((value) => {
    const node = failObject(value, "wiki graph node", fail);
    const kind = optionalEnum(
      node.kind,
      ["entity", "concept", "source", "synthesis", "report"],
      "wiki graph node kind",
      fail,
    );
    if (!kind) {
      return fail("Gateway returned invalid wiki graph node kind");
    }
    const updatedAt = optionalText(node.updatedAt, "wiki graph node updatedAt", fail, 256);
    return {
      id: wikiPath(node.id, "wiki graph node id", fail),
      title: text(node.title, "wiki graph node title", fail),
      kind,
      ...(updatedAt ? { updatedAt } : {}),
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) {
    return fail("Gateway returned duplicate wiki graph node ids");
  }
  const edges = payload.edges.map((value) => {
    const edge = failObject(value, "wiki graph edge", fail);
    const source = wikiPath(edge.source, "wiki graph edge source", fail);
    const target = wikiPath(edge.target, "wiki graph edge target", fail);
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      return fail("Gateway returned wiki graph edge outside the projected nodes");
    }
    if (edge.type !== "link") {
      return fail("Gateway returned invalid wiki graph edge type");
    }
    return { source, target, type: "link" };
  });
  const stats = failObject(payload.stats, "wiki graph stats", fail);
  const projectedStats = {
    totalPages: count(stats.totalPages, "wiki graph totalPages", fail),
    totalNodes: count(stats.totalNodes, "wiki graph totalNodes", fail),
    totalEdges: count(stats.totalEdges, "wiki graph totalEdges", fail),
    unresolvedLinks: count(stats.unresolvedLinks, "wiki graph unresolvedLinks", fail),
    truncated:
      typeof stats.truncated === "boolean"
        ? stats.truncated
        : fail("Gateway returned invalid wiki graph truncated flag"),
  };
  if (
    projectedStats.totalNodes !== nodes.length ||
    projectedStats.totalEdges !== edges.length ||
    projectedStats.totalPages < projectedStats.totalNodes
  ) {
    return fail("Gateway returned inconsistent wiki graph stats");
  }
  return { nodes, edges, stats: projectedStats };
}
