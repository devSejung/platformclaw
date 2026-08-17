// PlatformClaw tests prove the native Memory Wiki UI through the employee BFF method surface.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-personal-memory-wiki",
);
const assignedAgentId = "assigned-personal";
const foreignAgentId = "foreign-agent";

let browser: Browser;
let server: ControlUiE2eServer;

function requestParams(request: { params?: unknown }): Record<string, unknown> {
  return request.params && typeof request.params === "object" && !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : {};
}

async function expectRequestsPinned(gateway: MockGatewayControls, method: string) {
  await expect.poll(async () => (await gateway.getRequests(method)).length).toBeGreaterThan(0);
  const requests = await gateway.getRequests(method);
  expect(requests.every((request) => requestParams(request).agentId === assignedAgentId)).toBe(
    true,
  );
  expect(requests.some((request) => requestParams(request).agentId === foreignAgentId)).toBe(false);
}

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

const personalRoster = {
  agents: [{ id: assignedAgentId, name: "Assigned Personal Agent" }],
  defaultId: assignedAgentId,
  mainKey: assignedAgentId,
  scope: "agent",
};

describeControlUiE2e("PlatformClaw personal Memory Wiki mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders Dreams, Imported Insights, and Memory Wiki only for the assigned agent", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      defaultAgentId: assignedAgentId,
      featureMethods: [
        "agents.list",
        "doctor.memory.status",
        "doctor.memory.dreamDiary",
        "wiki.importInsights",
        "wiki.overview",
        "wiki.get",
      ],
      methodResponses: {
        "agents.list": personalRoster,
        "doctor.memory.status": {
          cases: [
            {
              match: { agentId: assignedAgentId },
              response: {
                agentId: assignedAgentId,
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
            },
          ],
        },
        "doctor.memory.dreamDiary": {
          cases: [
            {
              match: { agentId: assignedAgentId },
              response: {
                agentId: assignedAgentId,
                found: true,
                path: "DREAMS.md",
                content:
                  "# Dream Diary\n\n*August 17, 2026, 3:00 AM*\n\nAssigned personal memory was consolidated.",
              },
            },
          ],
        },
        "wiki.importInsights": {
          cases: [
            {
              match: { agentId: assignedAgentId },
              response: {
                sourceType: "chatgpt",
                totalItems: 1,
                totalClusters: 1,
                clusters: [
                  {
                    key: "topic/platform",
                    label: "Platform",
                    itemCount: 1,
                    highRiskCount: 0,
                    withheldCount: 0,
                    preferenceSignalCount: 1,
                    items: [
                      {
                        pagePath: "sources/assigned-platform-notes.md",
                        title: "Assigned platform notes",
                        riskLevel: "low",
                        riskReasons: [],
                        labels: ["topic/platform"],
                        topicKey: "topic/platform",
                        topicLabel: "Platform",
                        digestStatus: "available",
                        activeBranchMessages: 3,
                        userMessageCount: 2,
                        assistantMessageCount: 1,
                        summary: "The assigned agent keeps deployment preferences here.",
                        candidateSignals: ["prefers bounded employee access"],
                        correctionSignals: [],
                        preferenceSignals: ["bounded access"],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        "wiki.overview": {
          cases: [
            {
              match: { agentId: assignedAgentId },
              response: {
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
                        pagePath: "syntheses/assigned-platform.md",
                        title: "Assigned platform knowledge",
                        kind: "synthesis",
                        claimCount: 1,
                        questionCount: 0,
                        contradictionCount: 0,
                        claims: ["Employee browser access stays agent scoped."],
                        questions: [],
                        contradictions: [],
                        snippet: "Compiled knowledge for the assigned personal agent.",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        "wiki.get": {
          cases: [
            {
              match: {
                agentId: assignedAgentId,
                lookup: "syntheses/assigned-platform.md",
                fromLine: 1,
                lineCount: 5000,
              },
              response: {
                title: "Assigned platform knowledge",
                path: "syntheses/assigned-platform.md",
                content:
                  "# Assigned platform knowledge\n\nEmployee browser access stays agent scoped.",
                totalLines: 3,
                truncated: false,
              },
            },
          ],
        },
      },
    });

    try {
      expect(
        (await page.goto(`${server.baseUrl}settings/agents/${assignedAgentId}/memory`))?.status(),
      ).toBe(200);
      await waitForControlUiRoute(page, {
        routeId: "agents",
        pathname: `/settings/agents/${assignedAgentId}/memory`,
      });

      await page.getByRole("tab", { name: "Diary" }).click();
      const diary = page.locator(".dreams-diary");
      await expect
        .poll(() => diary.textContent())
        .toContain("Assigned personal memory was consolidated.");
      await expectRequestsPinned(gateway, "doctor.memory.status");
      await expectRequestsPinned(gateway, "doctor.memory.dreamDiary");
      const initialConfigGetCount = (await gateway.getRequests("config.get")).length;
      await screenshot(page, "01-dreams.png");

      await diary.getByRole("tab", { name: "Imported Insights" }).click();
      await expect.poll(() => diary.textContent()).toContain("Assigned platform notes");
      await expectRequestsPinned(gateway, "wiki.importInsights");
      await screenshot(page, "02-imported-insights.png");

      await diary.getByRole("tab", { name: "Memory Wiki" }).click();
      await expect.poll(() => diary.textContent()).toContain("Assigned platform knowledge");
      await expectRequestsPinned(gateway, "wiki.overview");
      await diary.getByRole("button", { name: "Open wiki page" }).click();
      await expectRequestsPinned(gateway, "wiki.get");
      await expect
        .poll(() => page.locator(".dreams-diary__preview-pre").textContent())
        .toContain("Employee browser access stays agent scoped.");
      await screenshot(page, "03-memory-wiki-preview.png");

      expect(await page.getByText(foreignAgentId, { exact: false }).count()).toBe(0);
      expect(await gateway.getRequests("config.get")).toHaveLength(initialConfigGetCount);
    } finally {
      await context.close();
    }
  }, 120_000);
});
