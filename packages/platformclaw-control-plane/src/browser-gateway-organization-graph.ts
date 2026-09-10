import {
  BrowserGatewayProxyError,
  type BrowserGatewayProxyOptions,
} from "./browser-gateway-contracts.js";
import type { OrganizationMemoryGraph, OrganizationMemoryGraphKind } from "./contracts.js";

type JsonObject = Record<string, unknown>;

const MAX_NODES = 500;
const MAX_EDGES = 2_000;
const SAFE_PATH = /^organization\/(part|group)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/u;

function fail(message: string): never {
  throw new BrowserGatewayProxyError("upstream-result-denied", message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readKind(value: unknown): OrganizationMemoryGraphKind {
  if (value !== "part" && value !== "group") {
    throw new BrowserGatewayProxyError("invalid-params", "kind must be part or group");
  }
  return value;
}

function projectGraph(value: OrganizationMemoryGraph, kind: OrganizationMemoryGraphKind) {
  if (value.kind !== kind || !Array.isArray(value.nodes) || value.nodes.length > MAX_NODES) {
    fail("organization memory graph nodes are invalid");
  }
  if (!Array.isArray(value.edges) || value.edges.length > MAX_EDGES) {
    fail("organization memory graph edges are invalid");
  }
  const nodes = value.nodes.map((node) => {
    const pathMatch = typeof node?.path === "string" ? SAFE_PATH.exec(node.path) : null;
    if (
      !node ||
      typeof node.id !== "string" ||
      !pathMatch ||
      pathMatch[1] !== kind ||
      node.id !== `organization:${kind}:${pathMatch[2]}` ||
      typeof node.title !== "string" ||
      !node.title.trim() ||
      node.title.length > 500 ||
      typeof node.scopeName !== "string" ||
      !node.scopeName.trim() ||
      node.scopeName.length > 500 ||
      !Number.isSafeInteger(node.updatedAt) ||
      node.updatedAt < 0
    ) {
      fail("organization memory graph node is invalid");
    }
    const verification = node.verification;
    if (
      verification &&
      (verification.approvalStatus !== "approved" ||
        !Number.isSafeInteger(verification.revision) ||
        verification.revision < 1 ||
        !Number.isSafeInteger(verification.sourceRevision) ||
        verification.sourceRevision < 1 ||
        !["current", "changed", "unavailable"].includes(verification.sourceStatus))
    ) {
      fail("organization memory graph verification is invalid");
    }
    return {
      id: node.id,
      path: node.path,
      title: node.title.trim(),
      scopeName: node.scopeName.trim(),
      updatedAt: node.updatedAt,
      ...(verification
        ? {
            verification: {
              approvalStatus: verification.approvalStatus,
              revision: verification.revision,
              sourceRevision: verification.sourceRevision,
              sourceStatus: verification.sourceStatus,
            },
          }
        : {}),
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) {
    fail("organization memory graph node ids are duplicated");
  }
  const edges = value.edges.map((edge) => {
    if (
      !edge ||
      edge.type !== "promotion" ||
      typeof edge.source !== "string" ||
      typeof edge.target !== "string" ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target)
    ) {
      fail("organization memory graph edge is invalid");
    }
    return { source: edge.source, target: edge.target, type: "promotion" as const };
  });
  const edgeIds = new Set(edges.map((edge) => `${edge.source}\0${edge.target}`));
  if (edgeIds.size !== edges.length) {
    fail("organization memory graph edges are duplicated");
  }
  const stats = value.stats;
  if (
    !stats ||
    !Number.isSafeInteger(stats.totalPages) ||
    stats.totalPages < nodes.length ||
    !Number.isSafeInteger(stats.totalNodes) ||
    stats.totalNodes !== nodes.length ||
    !Number.isSafeInteger(stats.totalEdges) ||
    stats.totalEdges !== edges.length ||
    typeof stats.truncated !== "boolean" ||
    typeof stats.partial !== "boolean"
  ) {
    fail("organization memory graph stats are invalid");
  }
  return {
    kind,
    nodes: nodes.toSorted((left, right) => compareText(left.id, right.id)),
    edges: edges.toSorted(
      (left, right) =>
        compareText(left.source, right.source) || compareText(left.target, right.target),
    ),
    stats: {
      totalPages: stats.totalPages,
      totalNodes: stats.totalNodes,
      totalEdges: stats.totalEdges,
      truncated: stats.truncated,
      partial: stats.partial,
    },
  };
}

export async function requestBrowserOrganizationMemoryGraph(params: {
  method: string;
  request: JsonObject;
  agentId: string;
  get: BrowserGatewayProxyOptions["getOrganizationMemoryGraph"];
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (params.method !== "platformclaw.memory.graph") {
    return { handled: false };
  }
  if (!params.get) {
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      "organization memory graph is unavailable",
    );
  }
  const kind = readKind(params.request.kind);
  return {
    handled: true,
    result: projectGraph(await params.get({ agentId: params.agentId, kind }), kind),
  };
}
