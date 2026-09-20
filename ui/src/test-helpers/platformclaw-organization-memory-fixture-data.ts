import type {
  OrganizationMemoryClaim,
  OrganizationMemoryGraph,
  OrganizationMemoryLifecycleSnapshot,
  OrganizationMemoryVerification,
} from "../../../packages/platformclaw-control-plane/src/organization-memory-contracts.js";

const ORG_BASE_TIME = Date.UTC(2026, 7, 31, 10, 0, 0);

type ScopeKind = "part" | "group" | "team" | "global";

type OrganizationFixtureNode = {
  id: string;
  kind: ScopeKind;
  scopeId?: string;
  scopeName: string;
  title: string;
  text: string;
  revision: number;
  updatedAt: number;
  sourceClaimId?: string;
  referenceClaimIds?: string[];
};

type BrowserOrganizationMemoryDocument = {
  path: string;
  title: string;
  kind: ScopeKind;
  provenanceLabel: string;
  content: string;
  fromLine: number;
  lineCount: number;
  totalLines?: number;
  textTruncated?: boolean;
  verification?: OrganizationMemoryVerification;
  updatedAt: string;
};

const baseNodes: OrganizationFixtureNode[] = [
  {
    id: "runtime-release-policy",
    kind: "part",
    scopeId: "part-runtime",
    scopeName: "Runtime",
    title: "Runtime release guardrails",
    text: "Production rollout starts with a bounded canary, an explicit owner, and a recorded rollback checkpoint.",
    revision: 4,
    updatedAt: ORG_BASE_TIME,
    sourceClaimId: "personal-release-preflight",
  },
  {
    id: "runtime-incident-handoff",
    kind: "part",
    scopeId: "part-runtime",
    scopeName: "Runtime",
    title: "Runtime incident handoff",
    text: "An unresolved incident handoff records the current symptom, latest evidence, next diagnostic action, and named owner.",
    revision: 2,
    updatedAt: ORG_BASE_TIME - 3_600_000,
    referenceClaimIds: ["runtime-release-policy"],
  },
  {
    id: "silicon-bringup-evidence",
    kind: "part",
    scopeId: "part-silicon-validation",
    scopeName: "Silicon Validation",
    title: "실리콘 Bring-up 증적 체크포인트",
    text: "Bring-up 판단에는 재현 조건, 관측 로그, 적용한 설정, 판정 근거를 함께 남긴다.",
    revision: 3,
    updatedAt: ORG_BASE_TIME - 7_200_000,
  },
  {
    id: "silicon-dram-training-triage",
    kind: "part",
    scopeId: "part-silicon-validation",
    scopeName: "Silicon Validation",
    title: "DRAM training triage boundaries",
    text: "Training failures are triaged by phase, channel, rank, voltage corner, and first failing observable before changing tuning policy.",
    revision: 5,
    updatedAt: ORG_BASE_TIME - 10_800_000,
    referenceClaimIds: ["silicon-bringup-evidence"],
  },
  {
    id: "platform-release-policy",
    kind: "group",
    scopeId: "group-platform",
    scopeName: "Platform",
    title: "Platform release policy",
    text: "Two approvals are required before a production rollout leaves the canary stage.",
    revision: 6,
    updatedAt: ORG_BASE_TIME - 14_400_000,
    sourceClaimId: "runtime-release-policy",
  },
  {
    id: "platform-evidence-retention",
    kind: "group",
    scopeId: "group-platform",
    scopeName: "Platform",
    title: "Shared verification evidence retention",
    text: "Shared verification evidence keeps the decision, source revision, responsible owner, and enough context to reproduce the result.",
    revision: 3,
    updatedAt: ORG_BASE_TIME - 18_000_000,
    referenceClaimIds: ["platform-release-policy"],
  },
  {
    id: "platform-canary-exception",
    kind: "group",
    scopeId: "group-platform",
    scopeName: "Platform",
    title: "Canary exception review",
    text: "A canary exception keeps the narrower operating condition visible and requires an explicit reviewer decision before broader rollout.",
    revision: 2,
    updatedAt: ORG_BASE_TIME - 19_800_000,
    sourceClaimId: "platform-release-policy",
    referenceClaimIds: ["platform-evidence-retention"],
  },
  {
    id: "memory-preview-fixture",
    kind: "team",
    scopeId: "team-memory-tools",
    scopeName: "Memory Tools",
    title: "Memory UI preview fixture rules",
    text: "Preview fixtures use deterministic synthetic data and cover readable states without copying user content.",
    revision: 2,
    updatedAt: ORG_BASE_TIME - 21_600_000,
    sourceClaimId: "platform-evidence-retention",
  },
  {
    id: "company-change-record",
    kind: "global",
    scopeName: "Global",
    title: "Company-wide change record minimums",
    text: "A company-wide operational change record names scope, owner, approval point, verification evidence, and rollback condition.",
    revision: 2,
    updatedAt: ORG_BASE_TIME - 25_200_000,
    sourceClaimId: "platform-release-policy",
  },
];

function organizationPath(node: OrganizationFixtureNode): string {
  return `organization/${node.kind}/${node.id}`;
}

function graphNodeId(kind: ScopeKind, claimId: string): string {
  return `organization:${kind}:${claimId}`;
}

function orderedGraphPair(kind: ScopeKind, left: string, right: string): [string, string] {
  const first = graphNodeId(kind, left);
  const second = graphNodeId(kind, right);
  return first < second ? [first, second] : [second, first];
}

function verification(node: OrganizationFixtureNode) {
  return {
    approvalStatus: "approved" as const,
    revision: node.revision,
    sourceRevision: Math.max(1, node.revision - 1),
    sourceStatus: "current" as const,
  };
}

function toDocument(node: OrganizationFixtureNode): BrowserOrganizationMemoryDocument {
  const path = organizationPath(node);
  const references = (node.referenceClaimIds ?? [])
    .map((claimId) => `Related knowledge: organization/${node.kind}/${claimId}`)
    .join("\n");
  const content = [
    `# ${node.title}`,
    "",
    node.text,
    ...(references ? ["", references] : []),
    "",
    "Synthetic preview knowledge.",
  ].join("\n");
  return {
    path,
    title: node.title,
    kind: node.kind,
    provenanceLabel: node.scopeName,
    content,
    fromLine: 1,
    lineCount: content.split("\n").length,
    totalLines: content.split("\n").length,
    verification: verification(node),
    updatedAt: new Date(node.updatedAt).toISOString(),
  };
}

function toClaim(node: OrganizationFixtureNode, index: number): OrganizationMemoryClaim {
  return {
    id: node.id,
    scopeKind: node.kind,
    ...(node.scopeId ? { scopeId: node.scopeId } : {}),
    scopeName: node.scopeName,
    title: node.title,
    text: node.text,
    revision: node.revision,
    status: "active",
    createdAt: node.updatedAt - 4 * 86_400_000,
    updatedAt: node.updatedAt,
    ...(node.sourceClaimId ? { sourceClaimId: node.sourceClaimId } : {}),
    revisionApproval: {
      approvedByUserId: "synthetic.reviewer",
      approvedAt: node.updatedAt - 30 * 60_000,
      reason: "Synthetic preview approval",
      ...(index % 3 === 0 ? { proposalId: `proposal-${node.id}` } : {}),
    },
    canRetire: false,
    canPurge: false,
  };
}

function graphFor(
  kind: ScopeKind,
  scopeId: string | undefined,
  nodes: OrganizationFixtureNode[],
): OrganizationMemoryGraph {
  const graphNodes = nodes.map((node) => ({
    id: graphNodeId(kind, node.id),
    path: organizationPath(node),
    title: node.title,
    scopeName: node.scopeName,
    updatedAt: node.updatedAt,
    verification: verification(node),
  }));
  const edges: OrganizationMemoryGraph["edges"] = [];
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  for (const node of nodes) {
    if (node.sourceClaimId && byId.has(node.sourceClaimId)) {
      edges.push({
        source: graphNodeId(kind, node.sourceClaimId),
        target: graphNodeId(kind, node.id),
        type: "promotion",
      });
    }
    for (const targetId of node.referenceClaimIds ?? []) {
      const target = byId.get(targetId);
      if (!target || target.id === node.id) {
        continue;
      }
      edges.push({
        source: graphNodeId(kind, node.id),
        target: graphNodeId(kind, target.id),
        type: "reference",
        sourceRevision: node.revision,
        targetRevision: target.revision,
        inputStatus: "current",
      });
    }
  }
  if (nodes.length >= 3) {
    const promotionPairs = new Set(
      edges
        .filter((edge) => edge.type === "promotion")
        .map((edge) => [edge.source, edge.target].toSorted().join("\0")),
    );
    const pair = nodes
      .flatMap((left, index) => nodes.slice(index + 1).map((right) => [left, right] as const))
      .find(([left, right]) => {
        const ids = [graphNodeId(kind, left.id), graphNodeId(kind, right.id)].toSorted();
        return !promotionPairs.has(ids.join("\0"));
      });
    if (pair) {
      const [left, right] = pair;
      const [source, target] = orderedGraphPair(kind, left.id, right.id);
      edges.push({
        source,
        target,
        type: "comparison",
        kind: "condition-difference",
        summary:
          "Both claims are valid under different operating scopes; keep the scope condition visible.",
        reportId: `report-${kind}-${scopeId ?? "global"}`,
        completedAt: ORG_BASE_TIME - 45 * 60_000,
        inputStatus: "current",
        reviewStatus: "kept",
        claimRevisions: [
          { id: left.id, revision: left.revision },
          { id: right.id, revision: right.revision },
        ],
      });
    }
  }
  return {
    kind,
    ...(scopeId ? { scopeId } : {}),
    nodes: graphNodes,
    edges,
    stats: {
      totalPages: graphNodes.length,
      totalNodes: graphNodes.length,
      totalEdges: edges.length,
      truncated: false,
      partial: false,
    },
  };
}

const baseScopes: OrganizationMemoryLifecycleSnapshot["scopes"] = [
  { kind: "part", id: "part-runtime", name: "Runtime", canRead: true, canAdminister: false },
  {
    kind: "part",
    id: "part-silicon-validation",
    name: "Silicon Validation",
    canRead: true,
    canAdminister: false,
  },
  { kind: "group", id: "group-platform", name: "Platform", canRead: true, canAdminister: false },
  {
    kind: "team",
    id: "team-memory-tools",
    name: "Memory Tools",
    canRead: true,
    canAdminister: false,
  },
  { kind: "global", name: "Global", canRead: true, canAdminister: false },
];

export const organizationMemoryLifecycle: OrganizationMemoryLifecycleSnapshot = {
  scopes: baseScopes,
  personalTargets: [
    { kind: "part", scopeId: "part-runtime", scopeName: "Runtime", mode: "request" },
    {
      kind: "part",
      scopeId: "part-silicon-validation",
      scopeName: "Silicon Validation",
      mode: "request",
    },
  ],
  claims: baseNodes.map(toClaim),
  submitted: [
    {
      id: "request-release-observation",
      sourceKind: "personal",
      sourceClaimId: "syntheses/release-preflight.md",
      sourceRevision: 1,
      targetKind: "part",
      targetScopeName: "Runtime",
      proposedText: "Record canary health, rollback checkpoint, and responsible owner together.",
      evidence: ["syntheses/release-preflight.md@1"],
      reason: "Repeated release practice worth sharing",
      status: "pending",
      createdAt: ORG_BASE_TIME - 5_400_000,
      canReview: false,
    },
  ],
  reviewable: [],
  canApproveGlobal: false,
};

export const organizationMemoryGraphCases = [
  {
    match: { kind: "part", scopeId: "part-runtime" },
    response: graphFor(
      "part",
      "part-runtime",
      baseNodes.filter((node) => node.scopeId === "part-runtime"),
    ),
  },
  {
    match: { kind: "part", scopeId: "part-silicon-validation" },
    response: graphFor(
      "part",
      "part-silicon-validation",
      baseNodes.filter((node) => node.scopeId === "part-silicon-validation"),
    ),
  },
  {
    match: { kind: "group", scopeId: "group-platform" },
    response: graphFor(
      "group",
      "group-platform",
      baseNodes.filter((node) => node.scopeId === "group-platform"),
    ),
  },
  {
    match: { kind: "team", scopeId: "team-memory-tools" },
    response: graphFor(
      "team",
      "team-memory-tools",
      baseNodes.filter((node) => node.scopeId === "team-memory-tools"),
    ),
  },
  {
    match: { kind: "global" },
    response: graphFor(
      "global",
      undefined,
      baseNodes.filter((node) => node.kind === "global"),
    ),
  },
];

export const organizationMemoryGetCases = baseNodes.map((node) => ({
  match: { path: organizationPath(node) },
  response: toDocument(node),
}));

const busyTitles = [
  "배포 전 canary 관측값과 책임자 확인을 한 화면에서 검증하는 운영 기준",
  "Cross-service rollback ownership when a shared gateway change fails after canary promotion",
  "DRAM training 실패를 phase·channel·rank·corner 기준으로 분류하는 공통 triage 규칙",
  "Evidence required before changing a shared runtime timeout after an intermittent lab failure",
  "조직 지식 승격 시 원본 revision과 승인 근거를 함께 보존하는 방법",
  "Long-running validation handoff with unresolved observations, owner, and next diagnostic action",
  "서로 다른 보드 revision에서만 재현되는 오류를 동일 결함으로 합치지 않는 조건",
  "Shared release checklist for independent firmware, gateway, and control-plane deployables",
  "실패 로그에 민감한 원문 대신 재현 가능한 최소 증거를 남기는 규칙",
  "When a newer runbook enriches rather than replaces an older operating condition",
  "LPDDR training 변경 후 정상 부팅만으로 완료 판정하지 않는 검증 체크포인트",
  "Operator-visible evidence for automatic retries that eventually recover without intervention",
  "조직 공통 문서에서 Part 전용 예외 조건을 명확히 분리하는 작성 규칙",
  "Release decision record for a canary that is healthy except for one noisy dependency signal",
  "동일 증상에 대한 silicon validation과 runtime team의 관측 차이를 비교하는 방법",
  "Source revision drift detected after a shared claim was already approved for wider reuse",
  "재현 횟수가 적은 간헐 오류를 확정 정책으로 승격하기 전 필요한 최소 관측량",
  "Boundaries between evidence, diagnosis, workaround, and durable policy in organization memory",
  "승인된 지식의 조건이 달라졌을 때 기존 문서를 폐기하지 않고 차이를 남기는 절차",
  "How to reference a narrower Part claim from a Group policy without hiding its original scope",
  "bring-up 초기에 임시 workaround가 장기 운영 규칙으로 굳지 않게 하는 검토 기준",
  "Comparison report for two release policies with different approval thresholds and risk scopes",
  "조직 그래프에서 provenance와 reference를 혼동하지 않도록 원인을 기록하는 규칙",
  "Validation evidence retained after the original incident ticket is closed and archived",
  "여러 AP 프로젝트에서 반복된 초기화 순서 문제를 공통 지식으로 추상화하는 기준",
  "When a global guideline should retain a link to the narrower Group policy it came from",
  "자동화된 검증 결과와 수동 재현 결과가 충돌할 때 판정 근거를 남기는 방식",
  "Shared diagnostic vocabulary for timeout, polling termination, ordering, and stale state defects",
  "장기적으로 유효한 JEDEC 해석과 특정 제품 workaround를 분리해서 공유하는 원칙",
  "Evidence review checklist before applying an AI-suggested organization knowledge merge",
  "운영자에게 필요한 최소 context를 유지하면서 오래된 incident 세부사항을 축약하는 규칙",
  "Cross-team ownership handoff after a successful rollout still leaves deferred cleanup work",
] as const;

const busyNodes: OrganizationFixtureNode[] = busyTitles.map((title, index) => {
  const node: OrganizationFixtureNode = {
    id: `platform-knowledge-${String(index + 1).padStart(2, "0")}`,
    kind: "group",
    scopeId: "group-platform",
    scopeName: "Platform",
    title,
    text: `Synthetic organization knowledge ${index + 1}. Keep scope, evidence, revision, and responsible ownership explicit so the preview exercises realistic reviewable content.`,
    revision: 1 + (index % 6),
    updatedAt: ORG_BASE_TIME - index * 2_700_000,
    referenceClaimIds:
      index > 0
        ? [`platform-knowledge-${String(index).padStart(2, "0")}`]
        : ["platform-release-policy"],
  };
  if (index > 0 && index % 5 === 0) {
    node.sourceClaimId = `platform-knowledge-${String(index).padStart(2, "0")}`;
  }
  return node;
});

const busyGroupNodes = [
  ...baseNodes.filter((node) => node.scopeId === "group-platform"),
  ...busyNodes,
];
const busyGraph = graphFor("group", "group-platform", busyGroupNodes);
for (let index = 4; index < busyNodes.length; index += 6) {
  const source = busyNodes[index - 4]!;
  const target = busyNodes[index]!;
  const [sourceId, targetId] = orderedGraphPair("group", source.id, target.id);
  const overlapsPromotion = busyGraph.edges.some(
    (edge) =>
      edge.type === "promotion" &&
      [edge.source, edge.target].toSorted().join("\0") === [sourceId, targetId].join("\0"),
  );
  if (overlapsPromotion) {
    continue;
  }
  busyGraph.edges.push({
    source: sourceId,
    target: targetId,
    type: "comparison",
    kind: index % 12 === 4 ? "enrichment" : "conflict",
    summary:
      index % 12 === 4
        ? "The later claim adds evidence and operating conditions without invalidating the earlier claim."
        : "The two claims use incompatible decision thresholds; review is still pending.",
    reportId: `busy-report-${index}`,
    completedAt: ORG_BASE_TIME - index * 1_800_000,
    inputStatus: "current",
    reviewStatus: index % 12 === 4 ? "applied" : "pending",
    claimRevisions: [
      { id: source.id, revision: source.revision },
      { id: target.id, revision: target.revision },
    ],
  });
}
busyGraph.stats.totalEdges = busyGraph.edges.length;

export const organizationMemoryBusyLifecycle: OrganizationMemoryLifecycleSnapshot = {
  ...organizationMemoryLifecycle,
  claims: [...busyNodes.map(toClaim), ...organizationMemoryLifecycle.claims],
};

export const organizationMemoryBusyGraphCases = organizationMemoryGraphCases.map((entry) =>
  entry.match.kind === "group" &&
  "scopeId" in entry.match &&
  entry.match.scopeId === "group-platform"
    ? { match: entry.match, response: busyGraph }
    : entry,
);

export const organizationMemoryBusyGetCases = [
  ...busyNodes.map((node) => ({
    match: { path: organizationPath(node) },
    response: toDocument(node),
  })),
  ...organizationMemoryGetCases,
];

function emptyGraph(kind: ScopeKind, scopeId?: string): OrganizationMemoryGraph {
  return {
    kind,
    ...(scopeId ? { scopeId } : {}),
    nodes: [],
    edges: [],
    stats: { totalPages: 0, totalNodes: 0, totalEdges: 0, truncated: false, partial: false },
  };
}

export const organizationMemoryEmptyLifecycle: OrganizationMemoryLifecycleSnapshot = {
  scopes: baseScopes,
  personalTargets: organizationMemoryLifecycle.personalTargets,
  claims: [],
  submitted: [],
  reviewable: [],
  canApproveGlobal: false,
};

export const organizationMemoryEmptyGraphCases = [
  {
    match: { kind: "part", scopeId: "part-runtime" },
    response: emptyGraph("part", "part-runtime"),
  },
  {
    match: { kind: "part", scopeId: "part-silicon-validation" },
    response: emptyGraph("part", "part-silicon-validation"),
  },
  {
    match: { kind: "group", scopeId: "group-platform" },
    response: emptyGraph("group", "group-platform"),
  },
  {
    match: { kind: "team", scopeId: "team-memory-tools" },
    response: emptyGraph("team", "team-memory-tools"),
  },
  { match: { kind: "global" }, response: emptyGraph("global") },
];
