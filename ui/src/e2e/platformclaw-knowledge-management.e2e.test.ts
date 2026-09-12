import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrganizationKnowledgeSnapshot } from "../../../packages/platformclaw-control-plane/src/organization-memory-knowledge-contracts.js";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts/control-ui-e2e/platformclaw-knowledge-management",
);
const method = "platformclaw.memory.knowledge.";
const completedAt = Date.now() - 300_000;
const selected: OrganizationKnowledgeSnapshot = {
  scope: {
    id: "part-runtime",
    kind: "part",
    name: "Runtime",
    capabilities: {
      canReadReport: true,
      canGenerateReport: true,
      canReviewProposals: true,
      canApplyProposals: false,
    },
  },
  lastSuccess: {
    id: "shared-report",
    jobId: "completed-job",
    completedAt,
    inputFingerprint: "approved-inputs",
    inputStatus: "stale",
    summary: "Previously completed comparison",
    comparisons: [],
    bounds: {
      includedClaims: 2,
      totalEligibleClaims: 3,
      maxClaims: 20,
      maxTextChars: 4000,
      truncated: true,
    },
    coverage: {
      strategy: "candidate-pairs",
      policyVersion: "v1",
      candidatePairs: 3,
      comparedPairs: 1,
      hasUncomparedPairs: true,
    },
  },
  currentJob: {
    id: "shared-running-job",
    inputFingerprint: "changed-inputs",
    status: "running",
    createdAt: completedAt,
  },
  proposals: [],
  history: [],
  hasMore: false,
};
let browser: Browser;
let server: ControlUiE2eServer;

suite("PlatformClaw knowledge management browser flow", () => {
  beforeAll(async () => {
    if (!available) throw new Error(`Playwright Chromium is not available at ${executablePath}`);
    if (capture) await mkdir(proofDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("two leaders read identical shared job/report without requesting analysis, then explicitly get or regenerate", async () => {
    for (const [index, locale] of ["en-US", "ko-KR"].entries()) {
      const context = await browser.newContext({
        locale,
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
        ...(capture ? { recordVideo: { dir: proofDir, size: { width: 1440, height: 900 } } } : {}),
      });
      const page = await context.newPage();
      const response = await page.request.get(server.baseUrl);
      const source = await response.text();
      const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
      await page.route("**/platformclaw/app/**", (route) =>
        route.fulfill({
          body: source.replace("</head>", `${descriptor}</head>`),
          headers: response.headers(),
          status: response.status(),
        }),
      );
      await page.route("**/platformclaw/api/auth/session", (route) =>
        route.fulfill({
          status: 200,
          json: {
            authenticated: true,
            user: {
              accountId: `leader.${index}`,
              displayName: `Leader ${index}`,
              department: "DEMO",
              globalRole: "member",
            },
            agent: { agentId: `personal-${index}`, state: "active" },
          },
        }),
      );
      const gateway = await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: `personal-${index}`,
        featureMethods: [
          "agents.list",
          "platformclaw.memory.lifecycle",
          `${method}snapshot`,
          `${method}generate`,
        ],
        methodResponses: {
          "agents.list": {
            agents: [{ id: `personal-${index}`, name: `Leader ${index}` }],
            defaultId: `personal-${index}`,
            mainKey: `personal-${index}`,
            scope: "agent",
          },
          "platformclaw.memory.lifecycle": {
            scopes: [],
            personalTargets: [],
            claims: [],
            submitted: [],
            reviewable: [],
            canApproveGlobal: false,
          },
          [`${method}snapshot`]: { scopes: [selected.scope], selected, scopesHasMore: false },
          [`${method}generate`]: {
            ...selected,
            currentJob: {
              ...selected.currentJob,
              status: "failed",
              completedAt: Date.now(),
              failure: { code: "analysis-failed", message: "Retry explicit regeneration" },
            },
          },
        },
      });
      await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/organization`);
      await page
        .getByRole("tab", {
          name: locale === "ko-KR" ? "지식 관리" : "Knowledge management",
          exact: true,
        })
        .click();
      const pane = page.locator("[data-knowledge-management]");
      await expect
        .poll(() => pane.textContent())
        .toContain(locale === "ko-KR" ? "최근 생성된 리포트" : "Latest generated report");
      expect(await gateway.getRequests(`${method}generate`)).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("agent")).toHaveLength(0);
      expect(await pane.locator("[data-knowledge-job]").getAttribute("data-knowledge-job")).toBe(
        "shared-running-job",
      );
      expect(
        await pane.locator("[data-knowledge-report]").getAttribute("data-knowledge-report"),
      ).toBe("shared-report");
      expect(await pane.locator("time").first().getAttribute("datetime")).toBe(
        new Date(completedAt).toISOString(),
      );
      if (capture)
        await page.screenshot({
          path: path.join(proofDir, `leader-${index}-initial.png`),
          fullPage: true,
        });
      await pane
        .getByRole("button", {
          name: locale === "ko-KR" ? "지식 리포트 가져오기" : "Get knowledge report",
          exact: true,
        })
        .click();
      await expect.poll(() => gateway.getRequests(`${method}generate`)).toHaveLength(1);
      expect((await gateway.getRequests(`${method}generate`))[0].params).toEqual({
        scopeId: "part-runtime",
        force: false,
        requestId: expect.any(String),
      });
      await expect.poll(() => pane.textContent()).toContain("Retry explicit regeneration");
      expect(await pane.textContent()).toContain(
        locale === "ko-KR" ? "최근 생성된 리포트" : "Latest generated report",
      );
      await pane
        .getByRole("button", {
          name: locale === "ko-KR" ? "재생성" : "Regenerate report",
          exact: true,
        })
        .click();
      await expect.poll(() => gateway.getRequests(`${method}generate`)).toHaveLength(2);
      expect((await gateway.getRequests(`${method}generate`))[1].params).toEqual({
        scopeId: "part-runtime",
        force: true,
        requestId: expect.any(String),
      });
      if (capture)
        await page.screenshot({
          path: path.join(proofDir, `leader-${index}-failed.png`),
          fullPage: true,
        });
      await context.close();
    }
  });
});
