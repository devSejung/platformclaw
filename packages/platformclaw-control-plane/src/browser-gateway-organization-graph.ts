import {
  BrowserGatewayProxyError,
  type BrowserGatewayProxyOptions,
} from "./browser-gateway-contracts.js";
import type {
  OrganizationMemoryGraph,
  OrganizationMemoryGraphEdge,
  OrganizationMemoryGraphKind,
} from "./contracts.js";
import { ControlPlaneAuthorizationError } from "./contracts.js";

type JsonObject = Record<string, unknown>;

const MAX_NODES = 500;
const MAX_EDGES = 2_000;
const SAFE_PATH = /^organization\/(global|team|part|group)\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/u;

function fail(message: string): never {
  throw new BrowserGatewayProxyError("upstream-result-denied", message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readKind(value: unknown): OrganizationMemoryGraphKind {
  if (value !== "part" && value !== "group" && value !== "team" && value !== "global") {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "kind must be part, group, team or global",
    );
  }
  return value;
}

function projectGraph(
  value: OrganizationMemoryGraph,
  kind: OrganizationMemoryGraphKind,
  scopeId?: string,
) {
  if (value.scopeId !== scopeId) {
    fail("organization memory graph scope does not match the request");
  }
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
      typeof edge.source !== "string" ||
      typeof edge.target !== "string" ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target)
    ) {
      fail("organization memory graph edge is invalid");
    }
    if (edge.type === "promotion") {
      return { source: edge.source, target: edge.target, type: "promotion" as const };
    }
    if (edge.type === "reference") {
      if (
        edge.source === edge.target ||
        edge.inputStatus !== "current" ||
        !Number.isSafeInteger(edge.sourceRevision) ||
        edge.sourceRevision < 1 ||
        !Number.isSafeInteger(edge.targetRevision) ||
        edge.targetRevision < 1 ||
        nodes.find((node) => node.id === edge.source)?.verification?.revision !==
          edge.sourceRevision ||
        nodes.find((node) => node.id === edge.target)?.verification?.revision !==
          edge.targetRevision
      ) {
        fail("organization memory graph reference is invalid");
      }
      return {
        source: edge.source,
        target: edge.target,
        type: "reference" as const,
        sourceRevision: edge.sourceRevision,
        targetRevision: edge.targetRevision,
        inputStatus: "current" as const,
      };
    }
    if (
      edge.type !== "comparison" ||
      !["duplicate", "enrichment", "condition-difference", "conflict"].includes(edge.kind) ||
      !["pending", "approved", "kept", "deferred", "applied"].includes(edge.reviewStatus) ||
      typeof edge.summary !== "string" ||
      !edge.summary.trim() ||
      edge.summary.length > 2_000 ||
      typeof edge.reportId !== "string" ||
      !edge.reportId.trim() ||
      edge.reportId.length > 128 ||
      !Number.isSafeInteger(edge.completedAt) ||
      edge.completedAt < 0 ||
      edge.inputStatus !== "current" ||
      !Array.isArray(edge.claimRevisions) ||
      edge.claimRevisions.length !== 2 ||
      edge.source >= edge.target
    ) {
      fail("organization memory graph inferred relation is invalid");
    }
    const citations = edge.claimRevisions.map((citation) => {
      const node = nodes.find(
        (candidate) => candidate.id === `organization:${kind}:${citation?.id}`,
      );
      if (
        typeof citation?.id !== "string" ||
        !Number.isSafeInteger(citation.revision) ||
        citation.revision < 1 ||
        node?.verification?.revision !== citation.revision ||
        (node.id !== edge.source && node.id !== edge.target)
      ) {
        fail("organization memory graph inferred citation is invalid");
      }
      return { id: citation.id, revision: citation.revision };
    });
    if (new Set(citations.map((citation) => citation.id)).size !== 2) {
      fail("organization memory graph inferred citations repeat");
    }
    return {
      source: edge.source,
      target: edge.target,
      type: "comparison" as const,
      kind: edge.kind,
      summary: edge.summary,
      reportId: edge.reportId,
      completedAt: edge.completedAt,
      inputStatus: "current" as const,
      reviewStatus: edge.reviewStatus,
      claimRevisions: citations,
    } satisfies OrganizationMemoryGraphEdge;
  });
  const edgeIds = new Set(edges.map((edge) => `${edge.type}\0${edge.source}\0${edge.target}`));
  if (edgeIds.size !== edges.length) {
    fail("organization memory graph edges are duplicated");
  }
  const provenancePairs = new Set(
    edges
      .filter((edge) => edge.type === "promotion")
      .map((edge) => [edge.source, edge.target].toSorted().join("\0")),
  );
  if (
    edges.some(
      (edge) =>
        edge.type === "comparison" &&
        provenancePairs.has([edge.source, edge.target].toSorted().join("\0")),
    )
  ) {
    fail("organization memory graph inferred relation overlaps provenance");
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
    ...(scopeId === undefined ? {} : { scopeId }),
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
  const scopeId = params.request.scopeId;
  if (kind === "global" && scopeId !== undefined) {
    throw new BrowserGatewayProxyError("invalid-params", "global graph cannot have a scopeId");
  }
  if (
    scopeId !== undefined &&
    (typeof scopeId !== "string" ||
      !scopeId.trim() ||
      scopeId.length > 128 ||
      scopeId.trim() !== scopeId)
  ) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "scopeId must be a nonempty scope identifier",
    );
  }
  let graph: OrganizationMemoryGraph;
  try {
    graph = await params.get({
      agentId: params.agentId,
      kind,
      ...(scopeId === undefined ? {} : { scopeId }),
    });
  } catch (error) {
    if (error instanceof ControlPlaneAuthorizationError) {
      throw new BrowserGatewayProxyError("cross-agent-denied", error.message);
    }
    throw error;
  }
  return {
    handled: true,
    result: projectGraph(graph, kind, scopeId),
  };
}
