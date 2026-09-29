import type {
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import {
  platformClawMemoryAgentId,
  platformClawMemoryResponses,
} from "./platformclaw-memory-fixture.ts";
import {
  wikiHubPersonalId,
  wikiHubPersonalDocument,
  wikiHubResponses,
  wikiHubSnapshot,
} from "./platformclaw-wiki-hub-fixture.ts";

type PlatformClawMemoryResponses = NonNullable<ControlUiMockGatewayScenario["methodResponses"]>;
type BusyWikiKind = "entity" | "concept" | "source" | "synthesis" | "report";

const busyWikiTitles = [
  "Release canary ownership and rollback decision record for cross-service production changes",
  "Runtime alert triage boundaries for noisy dependency and infrastructure failures",
  "Personal agent workspace retention rules across interactive and scheduled sessions",
  "Verification evidence checklist for changes that touch shared gateway behavior",
  "How to hand off unresolved rollout observations without losing responsible ownership",
  "Distinguishing durable operator preferences from temporary incident-specific instructions",
  "Memory promotion signals for repeated implementation decisions with stable provenance",
  "Contradiction review playbook when newer operational evidence supersedes older guidance",
  "Release readiness notes for services with independent canary and rollback checkpoints",
  "Shared runtime diagnostics that remain useful after the original incident is resolved",
  "Workspace file conventions for bounded daily notes and durable long-term summaries",
  "Evidence quality questions to ask before promoting an observed pattern into personal memory",
  "Operational ownership vocabulary for primary responders, reviewers, and rollout approvers",
  "Recurring validation patterns that should stay searchable without becoming rigid policy",
  "How synthetic preview data should expose filtering, graph density, and long title wrapping",
  "Open questions around deduplicating similar release lessons from separate daily memories",
  "Canary observation windows and the signals that justify extending or stopping a rollout",
  "Practical boundaries between source notes, concepts, syntheses, reports, and named entities",
  "Follow-up ownership after a successful rollout when deferred cleanup work still remains",
  "Contradictory runbook guidance discovered during a routine dependency upgrade review",
  "Stable review habits that reduce noisy findings while preserving actionable defect coverage",
  "Search terms operators use when they remember the outcome but not the original document path",
  "Daily memory signals that become more useful when grounded in explicit files and timestamps",
  "Long-running agent sessions and the moments that deserve a durable checkpoint before compaction",
  "Production rollout questions that should remain open until live evidence closes the loop",
  "Relationship between release synthesis pages and the ownership concepts they reference",
  "Weekly report structure for unresolved questions, contradictions, and recently promoted memories",
  "Named service entity notes that connect recurring incidents to their current operational context",
  "Source note describing a synthetic outage drill with bounded recovery and verification steps",
  "Concept for separating transient debugging detail from reusable operational knowledge",
  "Synthesis of repeated canary lessons across several synthetic release rehearsals",
  "Report on preview fixture coverage for graph navigation, search, filters, and dense wiki lists",
] as const;

const busyWikiKinds = ["concept", "synthesis", "report", "source", "entity"] as const;
const busyWikiDirectories: Record<BusyWikiKind, string> = {
  concept: "concepts",
  synthesis: "syntheses",
  report: "reports",
  source: "sources",
  entity: "entities",
};
const busyWikiDocuments = busyWikiTitles.map((title, index) => {
  const kind = busyWikiKinds[index % busyWikiKinds.length]!;
  const number = String(index + 1).padStart(2, "0");
  const path = `${busyWikiDirectories[kind]}/preview-${number}.md`;
  const claims = [
    `Synthetic claim ${index + 1}: ${index % 2 === 0 ? "keep ownership explicit" : "keep evidence traceable"}.`,
  ];
  const questions =
    index % 3 === 0
      ? [`What additional synthetic evidence would close preview question ${index + 1}?`]
      : [];
  const contradictions =
    index % 5 === 0
      ? [`Earlier synthetic guidance ${index + 1} used a broader rule than this page.`]
      : [];
  const updatedAt = `2026-08-${String(31 - (index % 12)).padStart(2, "0")}T${String(
    8 + (index % 8),
  ).padStart(2, "0")}:00:00.000Z`;
  const detailLines = [
    `# ${title}`,
    "",
    claims[0],
    ...questions.map((question) => `Question: ${question}`),
    ...contradictions.map((contradiction) => `Contradiction: ${contradiction}`),
  ];
  return {
    path,
    title,
    kind,
    updatedAt,
    claims,
    questions,
    contradictions,
    document: {
      ...wikiHubPersonalDocument,
      id: path,
      logicalPath: path,
      title,
      snippet: `Synthetic preview page ${number} covers ${kind} behavior with bounded, non-user data.`,
      content: detailLines.join("\n"),
      editableContent: detailLines.join("\n"),
      sourceContent: detailLines.join("\n"),
      revision: (index + 1).toString(16).padStart(64, "0"),
      updatedAt: Date.parse(updatedAt),
      metadata: { kind, claims, questions, contradictions },
      links: [],
      backlinks: [],
      ...(kind === "report" || kind === "source"
        ? {
            editMode: null,
            readOnlyReason: kind === "report" ? "generated-report" : "source-managed",
          }
        : {}),
    } satisfies KnowledgeVaultDocument,
  };
});

const busyWikiEdges = [
  ...busyWikiDocuments.slice(1).map((document, index) => ({
    source: busyWikiDocuments[index]!.path,
    target: document.path,
    type: "related" as const,
  })),
  ...busyWikiDocuments
    .slice(4)
    .filter((_, index) => index % 4 === 0)
    .map((document, index) => ({
      source: busyWikiDocuments[index * 4]!.path,
      target: document.path,
      type: "reference" as const,
    })),
];

function personalSnapshot(
  documents: KnowledgeVaultDocument[],
  edges: Array<{ source: string; target: string }>,
): KnowledgeVaultSnapshot {
  const snapshot = wikiHubSnapshot({ selectedId: wikiHubPersonalId });
  snapshot.vaults = snapshot.vaults.map((vault) =>
    vault.id === wikiHubPersonalId ? { ...vault, documentCount: documents.length } : vault,
  );
  snapshot.selected!.documents = documents;
  snapshot.selected!.graph = { edges, unresolvedLinks: 0, truncated: false };
  return snapshot;
}
const busyDocuments = busyWikiDocuments.map((item) => item.document);
const busySnapshot = personalSnapshot(busyDocuments, busyWikiEdges);
export const platformClawMemoryBusyResponses: PlatformClawMemoryResponses = {
  ...platformClawMemoryResponses,
  "platformclaw.vault.snapshot": {
    cases: [
      { match: { vaultId: wikiHubPersonalId }, response: busySnapshot },
      ...wikiHubResponses["platformclaw.vault.snapshot"].cases.filter(
        (item) => "vaultId" in item.match && item.match.vaultId !== wikiHubPersonalId,
      ),
      { match: {}, response: { ...busySnapshot, selected: undefined } },
    ],
  },
  "platformclaw.vault.document.get": {
    cases: [
      ...busyDocuments.map((document) => ({
        match: { vaultId: wikiHubPersonalId, documentId: document.id },
        response: document,
      })),
      ...wikiHubResponses["platformclaw.vault.document.get"].cases.filter(
        (item) => item.match.vaultId !== wikiHubPersonalId,
      ),
    ],
  },
};

export const platformClawMemoryEmptyResponses: PlatformClawMemoryResponses = {
  ...platformClawMemoryResponses,
  "platformclaw.vault.snapshot": {
    cases: [
      { match: { vaultId: wikiHubPersonalId }, response: personalSnapshot([], []) },
      ...wikiHubResponses["platformclaw.vault.snapshot"].cases.filter(
        (item) => "vaultId" in item.match && item.match.vaultId !== wikiHubPersonalId,
      ),
      { match: {}, response: { ...personalSnapshot([], []), selected: undefined } },
    ],
  },
  "agents.workspace.get": {
    cases: [
      {
        match: { agentId: platformClawMemoryAgentId, path: "MEMORY.md" },
        response: {
          file: {
            path: "MEMORY.md",
            name: "MEMORY.md",
            encoding: "utf8",
            content: "",
            missing: true,
          },
        },
      },
    ],
  },
  "agents.workspace.list": { entries: [], hasAdditionalFolders: false },
  "memory.search": {
    agentId: platformClawMemoryAgentId,
    provider: "builtin",
    searchMode: "hybrid",
    stale: false,
    results: [],
  },
  "wiki.search": [],
  "wiki.document.get": { cases: [] },
  "wiki.graph": {
    nodes: [],
    edges: [],
    stats: { totalPages: 0, totalNodes: 0, totalEdges: 0, unresolvedLinks: 0, truncated: false },
  },
  "wiki.overview": {
    totalItems: 0,
    totalPages: 0,
    pageCounts: { entity: 0, concept: 0, source: 0, synthesis: 0, report: 0 },
    totalClaims: 0,
    totalQuestions: 0,
    totalContradictions: 0,
    clusters: [],
  },
  "doctor.memory.status": {
    agentId: platformClawMemoryAgentId,
    provider: "builtin",
    embedding: { ok: true, checked: true },
    dreaming: {
      enabled: true,
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 0,
      recallSignalCount: 0,
      dailySignalCount: 0,
      groundedSignalCount: 0,
      totalSignalCount: 0,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 0,
      promotedToday: 0,
      timezone: "Asia/Seoul",
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: {
          enabled: true,
          cron: "15 3 * * *",
          managedCronPresent: true,
          nextRunAtMs: Date.UTC(2026, 7, 31, 18, 15, 0),
          lookbackDays: 7,
          limit: 25,
        },
        deep: {
          enabled: true,
          cron: "45 3 * * 1,4",
          managedCronPresent: true,
          nextRunAtMs: Date.UTC(2026, 8, 2, 18, 45, 0),
          minScore: 0.72,
          minRecallCount: 2,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 14,
          maxAgeDays: 90,
          limit: 12,
        },
        rem: {
          enabled: true,
          cron: "10 4 * * 0",
          managedCronPresent: true,
          nextRunAtMs: Date.UTC(2026, 8, 5, 19, 10, 0),
          lookbackDays: 21,
          limit: 16,
          minPatternStrength: 0.68,
        },
      },
    },
  },
  "doctor.memory.dreamDiary": {
    agentId: platformClawMemoryAgentId,
    found: false,
    path: "DREAMS.md",
  },
};

const unavailable = { __mockError: { code: "UNAVAILABLE", message: "Synthetic service outage" } };

export const platformClawMemoryErrorResponses: PlatformClawMemoryResponses = {
  ...platformClawMemoryResponses,
  "platformclaw.vault.snapshot": unavailable,
  "agents.workspace.get": unavailable,
  "agents.workspace.list": unavailable,
  "memory.search": unavailable,
  "wiki.search": unavailable,
  "wiki.overview": unavailable,
  "wiki.graph": unavailable,
  "doctor.memory.status": unavailable,
  "doctor.memory.dreamDiary": unavailable,
};
