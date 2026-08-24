import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const allowMissing = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = available || !allowMissing ? describe : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-organization-memory",
);

let browser: Browser;
let server: ControlUiE2eServer;

async function installPlatformClawDocument(page: import("playwright").Page): Promise<void> {
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
      json: {
        authenticated: true,
        user: {
          accountId: "person.one",
          displayName: "Person One",
          department: "Platform",
          globalRole: "member",
        },
      },
      status: 200,
    }),
  );
}

suite("PlatformClaw organization memory Settings E2E", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is not available at ${executablePath}`);
    }
    if (capture) {
      await mkdir(proofDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders pinned organization scope results in English and Korean", async () => {
    for (const scenario of [
      {
        locale: "en-US",
        query: "release",
        snippet: "Two approvals are required.",
        organizationTab: "Organization",
        promotionTitle: "Share Wiki knowledge",
        proofName: "en-US-desktop",
        viewport: { height: 900, width: 1440 },
      },
      {
        locale: "ko-KR",
        query: "보안",
        snippet: "모든 직원에게 적용되는 보안 정책입니다.",
        organizationTab: "조직 지식",
        promotionTitle: "Wiki 지식 공유",
        proofName: "ko-KR-desktop",
        viewport: { height: 900, width: 1440 },
      },
      {
        locale: "ko-KR",
        query: "보안",
        snippet: "모든 직원에게 적용되는 보안 정책입니다.",
        organizationTab: "조직 지식",
        promotionTitle: "Wiki 지식 공유",
        proofName: "ko-KR-mobile",
        viewport: { height: 844, width: 390 },
      },
    ]) {
      const context = await browser.newContext({
        locale: scenario.locale,
        serviceWorkers: "block",
        viewport: scenario.viewport,
      });
      const page = await context.newPage();
      await installPlatformClawDocument(page);
      const gateway = await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: "assigned-personal",
        featureMethods: [
          "agents.list",
          "doctor.memory.status",
          "memory.search",
          "platformclaw.memory.lifecycle",
          "wiki.get",
          "wiki.search",
        ],
        methodResponses: {
          "agents.list": {
            agents: [{ id: "assigned-personal", name: "Assigned Personal Agent" }],
            defaultId: "assigned-personal",
            mainKey: "assigned-personal",
            scope: "agent",
          },
          "doctor.memory.status": {
            agentId: "assigned-personal",
            provider: "builtin",
            embedding: { ok: true, checked: true },
          },
          "memory.search": {
            agentId: "assigned-personal",
            provider: "builtin",
            searchMode: "fts-only",
            results: [
              {
                source: "organization",
                corpus: "platformclaw-organization",
                path: "organization/group/policy",
                title: "Policy",
                kind: "group",
                provenanceLabel: "Platform",
                snippet: scenario.snippet,
                score: 0.95,
                startLine: 1,
                endLine: 1,
              },
            ],
          },
          "platformclaw.memory.lifecycle": {
            scopes: [
              { kind: "global", name: "Global", canAdminister: false },
              {
                kind: "part",
                id: "part-runtime",
                parentScopeId: "group-platform",
                name: "Runtime",
                canAdminister: false,
              },
            ],
            claims: [],
            submitted: [],
            reviewable: [
              {
                id: "request-1",
                sourceKind: "personal",
                sourceClaimId: "runbooks/release.md",
                sourceRevision: 1,
                targetKind: "part",
                targetScopeName: "Runtime",
                proposedText: scenario.snippet,
                evidence: ["incident-1"],
                reason: "Reusable policy",
                status: "pending",
                createdAt: 1,
                canReview: true,
              },
            ],
            canApproveGlobal: false,
          },
        },
      });

      await page.goto(`${server.baseUrl}platformclaw/app/settings/memory`);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/platformclaw/app/settings/memory");
      await expect.poll(() => page.locator("platformclaw-memory-page").isVisible()).toBe(true);
      await page.getByRole("tab", { name: "Memory", exact: true }).click();
      await page.locator("#memory-search-input").fill(scenario.query);
      await page
        .locator(".memory-memories__search")
        .evaluate((form) => (form as HTMLFormElement).requestSubmit());
      await expect
        .poll(() => page.locator(".memory-memories__results").textContent())
        .toContain(scenario.snippet);
      await expect
        .poll(() => page.locator(".memory-memories__source").textContent())
        .toContain("Platform");
      await page.getByRole("tab", { name: scenario.organizationTab, exact: true }).click();
      await expect
        .poll(() => page.locator("openclaw-memory-promotions").textContent())
        .toContain(scenario.snippet);
      await expect
        .poll(() => page.locator("openclaw-memory-promotions h2").textContent())
        .toContain(scenario.promotionTitle);
      expect(await page.locator("article > button").count()).toBe(0);
      expect(await gateway.getRequests("memory.search")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ agentId: "assigned-personal", query: scenario.query }),
        }),
      ]);
      expect(await gateway.getRequests("platformclaw.memory.lifecycle")).toEqual([
        expect.objectContaining({ params: {} }),
      ]);
      if (capture) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, `organization-memory-${scenario.proofName}.png`),
        });
      }
      await context.close();
    }
  });
});
