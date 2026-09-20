import type { Browser, BrowserContext, Page } from "playwright";
import type { ThemeName } from "../app/theme.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import { controlUiBundledGatewayUrl, type ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";

export const platformClawMemoryAgentId = "assigned-personal";

type PlatformClawMemoryResponses = NonNullable<ControlUiMockGatewayScenario["methodResponses"]>;

const DAY_MS = 86_400_000;
const MEMORY_BASE_DATE_MS = Date.UTC(2026, 7, 31, 12, 0, 0);
const RELEASE_PREFLIGHT_PATH = "syntheses/release-preflight.md";
const RELEASE_OWNERSHIP_PATH = "concepts/release-ownership.md";
const RELEASE_PREFLIGHT_TITLE = "Release preflight synthesis";
const RELEASE_PREFLIGHT_CONTENT =
  "# Release preflight synthesis\n\nRecord canary health and the responsible owner.";

function dailyMemoryFile(index: number) {
  const day = 31 - index;
  const date = `2026-08-${String(day).padStart(2, "0")}`;
  const content =
    index === 0
      ? "# 2026-08-31\n\nRelease preflight completed. Canary stayed healthy for thirty minutes."
      : `# ${date}\n\nSynthetic daily memory note ${index + 1}. Owner follow-up remained bounded and reviewable.`;
  return {
    path: `memory/${date}.md`,
    name: `${date}.md`,
    encoding: "utf8",
    content,
    updatedAtMs: MEMORY_BASE_DATE_MS - index * DAY_MS,
  };
}

function editableWikiDocument(params: {
  path: string;
  title: string;
  kind: "entity" | "concept" | "source" | "synthesis" | "report";
  content: string;
  revision: string;
  updatedAt: string;
}) {
  return {
    title: params.title,
    path: params.path,
    kind: params.kind,
    displayContent: params.content,
    sourceContent: params.content,
    editMode: "body",
    editableContent: params.content,
    revision: params.revision,
    updatedAt: params.updatedAt,
  };
}

const releasePreflightDocument = editableWikiDocument({
  path: RELEASE_PREFLIGHT_PATH,
  title: RELEASE_PREFLIGHT_TITLE,
  kind: "synthesis",
  content: RELEASE_PREFLIGHT_CONTENT,
  revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  updatedAt: "2026-08-31T12:00:00.000Z",
});

const releaseOwnershipDocument = editableWikiDocument({
  path: RELEASE_OWNERSHIP_PATH,
  title: "Release ownership",
  kind: "concept",
  content:
    "# Release ownership\n\nEvery production rollout names one responsible owner and one explicit approval checkpoint.",
  revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  updatedAt: "2026-08-30T12:00:00.000Z",
});

export const platformClawMemoryMethods = [
  "agents.list",
  "agents.workspace.get",
  "agents.workspace.list",
  "doctor.memory.dreamDiary",
  "doctor.memory.status",
  "memory.search",
  "platformclaw.memory.get",
  "platformclaw.memory.lifecycle",
  "wiki.document.get",
  "wiki.graph",
  "wiki.get",
  "wiki.overview",
  "wiki.search",
] as const;

const personalRoster = {
  agents: [{ id: platformClawMemoryAgentId, name: "Assigned Personal Agent" }],
  defaultId: platformClawMemoryAgentId,
  mainKey: platformClawMemoryAgentId,
  scope: "agent",
};

export const platformClawMemoryResponses: PlatformClawMemoryResponses = {
  "agents.list": personalRoster,
  "agents.workspace.get": {
    cases: [
      {
        match: { agentId: platformClawMemoryAgentId, path: "MEMORY.md" },
        response: {
          file: {
            path: "MEMORY.md",
            name: "MEMORY.md",
            encoding: "utf8",
            content:
              "# Long-term memory\n\nThe release checklist starts with a bounded canary and an owner check.",
            updatedAtMs: MEMORY_BASE_DATE_MS,
          },
        },
      },
      ...Array.from({ length: 7 }, (_, index) => {
        const file = dailyMemoryFile(index);
        return {
          match: { agentId: platformClawMemoryAgentId, path: file.path },
          response: { file },
        };
      }),
    ],
  },
  "agents.workspace.list": {
    entries: Array.from({ length: 7 }, (_, index) => {
      const file = dailyMemoryFile(index);
      return { path: file.path, name: file.name, updatedAtMs: file.updatedAtMs };
    }),
    hasAdditionalFolders: true,
  },
  "memory.search": {
    agentId: platformClawMemoryAgentId,
    provider: "builtin",
    searchMode: "hybrid",
    stale: true,
    results: [
      {
        source: "memory",
        corpus: "workspace-memory",
        path: "memory/2026-08-31.md",
        snippet: "Release preflight completed. Canary stayed healthy.",
        score: 0.98,
        startLine: 2,
        endLine: 3,
      },
      {
        source: "organization",
        corpus: "platformclaw-organization",
        path: "organization/group/group-platform",
        title: "Platform release policy",
        kind: "group",
        provenanceLabel: "Platform",
        snippet: "Two approvals are required before production rollout.",
        score: 0.91,
        startLine: 1,
        endLine: 1,
      },
    ],
  },
  "wiki.search": [
    {
      path: "syntheses/release-preflight.md",
      title: "Release preflight synthesis",
      kind: "synthesis",
      score: 0.94,
      snippet: "Canary health and owner checks should be recorded together.",
      startLine: 1,
      endLine: 2,
    },
  ],
  "wiki.get": {
    content: RELEASE_PREFLIGHT_CONTENT,
    fromLine: 1,
    lineCount: 3,
  },
  "wiki.document.get": {
    cases: [
      { match: { lookup: RELEASE_PREFLIGHT_PATH }, response: releasePreflightDocument },
      { match: { lookup: RELEASE_OWNERSHIP_PATH }, response: releaseOwnershipDocument },
    ],
  },
  "wiki.graph": {
    nodes: [
      {
        id: "syntheses/release-preflight.md",
        title: RELEASE_PREFLIGHT_TITLE,
        kind: "synthesis",
        updatedAt: "2026-08-31T12:00:00.000Z",
      },
      {
        id: "concepts/release-ownership.md",
        title: "Release ownership",
        kind: "concept",
        updatedAt: "2026-08-30T12:00:00.000Z",
      },
    ],
    edges: [
      {
        source: "syntheses/release-preflight.md",
        target: "concepts/release-ownership.md",
        type: "reference",
      },
    ],
    stats: {
      totalPages: 2,
      totalNodes: 2,
      totalEdges: 1,
      unresolvedLinks: 0,
      truncated: false,
    },
  },
  "platformclaw.memory.get": {
    content: "# Platform release policy\n\nTwo approvals are required before production rollout.",
    fromLine: 1,
    lineCount: 3,
  },
  "platformclaw.memory.lifecycle": {
    scopes: [
      {
        kind: "part",
        id: "part-runtime",
        name: "Runtime",
        canRead: true,
        canAdminister: false,
      },
    ],
    personalTargets: [
      {
        kind: "part",
        scopeId: "part-runtime",
        scopeName: "Runtime",
        mode: "request",
      },
    ],
    claims: [],
    submitted: [],
    reviewable: [],
    canApproveGlobal: false,
  },
  "wiki.overview": {
    totalItems: 2,
    totalPages: 2,
    pageCounts: { entity: 0, concept: 1, source: 0, synthesis: 1, report: 0 },
    totalClaims: 2,
    totalQuestions: 1,
    totalContradictions: 1,
    clusters: [
      {
        key: "synthesis",
        label: "Syntheses",
        itemCount: 1,
        claimCount: 1,
        questionCount: 1,
        contradictionCount: 0,
        updatedAt: "2026-08-31T12:00:00.000Z",
        items: [
          {
            pagePath: RELEASE_PREFLIGHT_PATH,
            title: RELEASE_PREFLIGHT_TITLE,
            kind: "synthesis",
            updatedAt: "2026-08-31T12:00:00.000Z",
            claimCount: 1,
            questionCount: 1,
            contradictionCount: 0,
            claims: ["Record canary health and its owner."],
            questions: ["Should the owner checkpoint be required before every production canary?"],
            contradictions: [],
            snippet: "Canary and owner checks stay together.",
          },
        ],
      },
      {
        key: "concept",
        label: "Concepts",
        itemCount: 1,
        claimCount: 1,
        questionCount: 0,
        contradictionCount: 1,
        updatedAt: "2026-08-30T12:00:00.000Z",
        items: [
          {
            pagePath: RELEASE_OWNERSHIP_PATH,
            title: "Release ownership",
            kind: "concept",
            updatedAt: "2026-08-30T12:00:00.000Z",
            claimCount: 1,
            questionCount: 0,
            contradictionCount: 1,
            claims: ["Every rollout names one responsible owner."],
            questions: [],
            contradictions: ["Older notes treated the on-call rotation as an implicit owner."],
            snippet: "Ownership stays explicit through rollout and verification.",
          },
        ],
      },
    ],
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
      shortTermCount: 1,
      recallSignalCount: 1,
      dailySignalCount: 1,
      groundedSignalCount: 1,
      totalSignalCount: 3,
      phaseSignalCount: 1,
      lightPhaseHitCount: 1,
      remPhaseHitCount: 0,
      promotedTotal: 1,
      promotedToday: 1,
      timezone: "Asia/Seoul",
      lastPromotedAt: "2026-08-31T03:40:00.000Z",
      shortTermEntries: [
        {
          key: "memory/2026-08-31.md:2-3",
          path: "memory/2026-08-31.md",
          startLine: 2,
          endLine: 3,
          snippet: "Release preflight completed. Canary stayed healthy for thirty minutes.",
          recallCount: 1,
          dailyCount: 1,
          groundedCount: 1,
          totalSignalCount: 3,
          lightHits: 1,
          remHits: 0,
          phaseHitCount: 1,
          lastRecalledAt: "2026-08-31T02:50:00.000Z",
        },
      ],
      signalEntries: [
        {
          key: "memory/2026-08-31.md:2-3",
          path: "memory/2026-08-31.md",
          startLine: 2,
          endLine: 3,
          snippet: "Release preflight completed. Canary stayed healthy for thirty minutes.",
          recallCount: 1,
          dailyCount: 1,
          groundedCount: 1,
          totalSignalCount: 3,
          lightHits: 1,
          remHits: 0,
          phaseHitCount: 1,
          lastRecalledAt: "2026-08-31T02:50:00.000Z",
        },
      ],
      promotedEntries: [
        {
          key: "syntheses/release-preflight.md:1-3",
          path: RELEASE_PREFLIGHT_PATH,
          startLine: 1,
          endLine: 3,
          snippet: "Record canary health and the responsible owner.",
          recallCount: 2,
          dailyCount: 1,
          groundedCount: 1,
          totalSignalCount: 4,
          lightHits: 1,
          remHits: 1,
          phaseHitCount: 2,
          promotedAt: "2026-08-31T03:40:00.000Z",
          lastRecalledAt: "2026-08-31T03:20:00.000Z",
        },
      ],
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
    found: true,
    path: "DREAMS.md",
    content:
      "# Dream diary\n\n---\n\n*August 31, 2026, 9:05 PM*\n\nThe release checklist was consolidated safely with the canary result and responsible owner kept together.",
    updatedAtMs: Date.UTC(2026, 7, 31, 12, 5, 0),
  },
};

type PlatformClawMemoryFixtureRole = "admin" | "member";

export async function installPlatformClawMemoryDocument(
  page: Page,
  serverBaseUrl: string,
  role: PlatformClawMemoryFixtureRole = "member",
): Promise<void> {
  const response = await page.request.get(serverBaseUrl);
  const source = await response.text();
  const descriptor =
    '<meta name="platformclaw-web-descriptor" content=\'' +
    JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR) +
    "'>";
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      body: source.replace("</head>", descriptor + "</head>"),
      headers: response.headers(),
      status: response.status(),
    }),
  );
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: role + ".one",
          displayName: role === "admin" ? "Admin One" : "Member One",
          department: "Platform",
          globalRole: role,
        },
        agent: { agentId: platformClawMemoryAgentId, state: "active" },
      },
      status: 200,
    }),
  );
}

export async function createPlatformClawMemoryContext(
  browser: Browser,
  serverBaseUrl: string,
  params: {
    locale: string;
    mode: "dark" | "light";
    theme?: ThemeName;
    viewport: { height: number; width: number };
  },
): Promise<BrowserContext> {
  const bundledGatewayUrl = controlUiBundledGatewayUrl(serverBaseUrl);
  const appGatewayUrl = bundledGatewayUrl + "/platformclaw/app";
  const browserGatewayUrl = new URL(PLATFORMCLAW_WEB_DESCRIPTOR.gatewayPath, serverBaseUrl);
  browserGatewayUrl.protocol = browserGatewayUrl.protocol === "https:" ? "wss:" : "ws:";
  const context = await browser.newContext({
    colorScheme: params.mode,
    locale: params.locale,
    serviceWorkers: "block",
    viewport: params.viewport,
  });
  const theme = params.theme ?? "platformclaw";
  await context.addInitScript(
    ({
      appGatewayUrl: seededAppGatewayUrl,
      bundledGatewayUrl: seededBundledGatewayUrl,
      gatewayUrl,
      mode,
      theme: selectedTheme,
    }) => {
      for (const scopedGatewayUrl of [seededAppGatewayUrl, seededBundledGatewayUrl, gatewayUrl]) {
        localStorage.setItem(
          "openclaw.control.settings.v1:" + scopedGatewayUrl,
          JSON.stringify({
            gatewayUrl: scopedGatewayUrl,
            theme: selectedTheme,
            themeMode: mode,
          }),
        );
      }
    },
    {
      appGatewayUrl,
      bundledGatewayUrl,
      gatewayUrl: browserGatewayUrl.href.replace(/\/$/u, ""),
      mode: params.mode,
      theme,
    },
  );
  return context;
}
