import type { Browser, BrowserContext, Page } from "playwright";
import type { ThemeName } from "../app/theme.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import { controlUiBundledGatewayUrl, type ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";

export const platformClawMemoryAgentId = "assigned-personal";

export const platformClawMemoryMethods = [
  "agents.list",
  "agents.workspace.get",
  "agents.workspace.list",
  "doctor.memory.dreamDiary",
  "doctor.memory.status",
  "memory.search",
  "platformclaw.memory.get",
  "platformclaw.memory.lifecycle",
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

export const platformClawMemoryResponses: NonNullable<
  ControlUiMockGatewayScenario["methodResponses"]
> = {
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
            updatedAtMs: 1_778_457_600_000,
          },
        },
      },
      {
        match: {
          agentId: platformClawMemoryAgentId,
          path: "memory/2026-08-31.md",
        },
        response: {
          file: {
            path: "memory/2026-08-31.md",
            name: "2026-08-31.md",
            encoding: "utf8",
            content:
              "# 2026-08-31\n\nRelease preflight completed. Canary stayed healthy for thirty minutes.",
            updatedAtMs: 1_778_457_600_000,
          },
        },
      },
    ],
  },
  "agents.workspace.list": {
    entries: Array.from({ length: 9 }, (_, index) => {
      const day = 31 - index;
      const date = String(day).padStart(2, "0");
      return {
        path: "memory/2026-08-" + date + ".md",
        name: "2026-08-" + date + ".md",
        updatedAtMs: 1_778_457_600_000 - index * 86_400_000,
      };
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
    content: "# Release preflight synthesis\n\nRecord canary health and the responsible owner.",
    fromLine: 1,
    lineCount: 3,
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
    totalItems: 1,
    totalPages: 1,
    pageCounts: { entity: 0, concept: 0, source: 0, synthesis: 1, report: 0 },
    totalClaims: 1,
    totalQuestions: 0,
    totalContradictions: 0,
    clusters: [
      {
        key: "synthesis",
        label: "Syntheses",
        itemCount: 1,
        claimCount: 1,
        questionCount: 0,
        contradictionCount: 0,
        items: [
          {
            pagePath: "syntheses/release-preflight.md",
            title: "Release preflight synthesis",
            kind: "synthesis",
            claimCount: 1,
            questionCount: 0,
            contradictionCount: 0,
            claims: ["Record canary health and its owner."],
            questions: [],
            contradictions: [],
            snippet: "Canary and owner checks stay together.",
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
      promotedTotal: 4,
      promotedToday: 1,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {},
    },
  },
  "doctor.memory.dreamDiary": {
    agentId: platformClawMemoryAgentId,
    found: true,
    path: "DREAMS.md",
    content: "# Dream diary\n\nThe release checklist was consolidated safely.",
  },
};

export type PlatformClawMemoryFixtureRole = "admin" | "member";

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
