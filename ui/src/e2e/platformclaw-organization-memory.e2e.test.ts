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
import { findControlUiPreviewFixture } from "../test-helpers/control-ui-preview-fixtures.ts";

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
        agent: { agentId: "assigned-personal", state: "active" },
      },
      status: 200,
    }),
  );
}

async function openSharedFixture(
  id: "platformclaw-memory" | "platformclaw-memory-busy",
  viewport: { width: number; height: number },
) {
  const fixture = findControlUiPreviewFixture(id);
  if (!fixture) {
    throw new Error(`Missing preview fixture: ${id}`);
  }
  return fixture.open({
    browser,
    server,
    options: { locale: "en-US", mode: "light", theme: "platformclaw", viewport },
  });
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
          "platformclaw.memory.graph",
          "platformclaw.memory.get",
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
          "wiki.search": [],
          "platformclaw.memory.lifecycle": {
            scopes: [
              { kind: "global", name: "Global", canRead: true, canAdminister: false },
              {
                kind: "group",
                id: "group-platform",
                name: "Platform",
                canRead: true,
                canAdminister: false,
              },
              {
                kind: "part",
                id: "part-runtime",
                parentScopeId: "group-platform",
                name: "Runtime",
                canRead: true,
                canAdminister: false,
              },
            ],
            personalTargets: [],
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
          "platformclaw.memory.graph": {
            cases: [
              {
                match: { kind: "part", scopeId: "part-runtime" },
                response: {
                  kind: "part",
                  nodes: [
                    {
                      id: "organization:part:runtime-policy",
                      path: "organization/part/runtime-policy",
                      title: "Runtime policy",
                      scopeName: "Runtime",
                      updatedAt: 1,
                    },
                  ],
                  edges: [],
                  stats: {
                    totalPages: 1,
                    totalNodes: 1,
                    totalEdges: 0,
                    truncated: false,
                    partial: false,
                  },
                },
              },
              {
                match: { kind: "group", scopeId: "group-platform" },
                response: {
                  kind: "group",
                  nodes: [
                    {
                      id: "organization:group:platform-policy",
                      path: "organization/group/platform-policy",
                      title: "Platform policy",
                      scopeName: "Platform",
                      updatedAt: 2,
                    },
                  ],
                  edges: [],
                  stats: {
                    totalPages: 1,
                    totalNodes: 1,
                    totalEdges: 0,
                    truncated: false,
                    partial: false,
                  },
                },
              },
            ],
          },
          "platformclaw.memory.get": {
            id: "claim-1",
            path: "organization/group/platform-policy",
            kind: "group",
            provenanceLabel: "Platform",
            title: "Platform policy",
            snippet: scenario.snippet,
            score: 1,
            updatedAt: new Date(2).toISOString(),
            content: `# Platform policy\n\n${scenario.snippet}`,
            fromLine: 1,
            lineCount: 3,
          },
        },
      });

      await page.goto(`${server.baseUrl}platformclaw/app/settings/memory`);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/platformclaw/app/settings/memory");
      await expect.poll(() => page.locator("platformclaw-memory-page").isVisible()).toBe(true);
      await expect
        .poll(() =>
          page
            .locator(".platformclaw-memory-page__tabs")
            .getByRole("tab", { name: "Memory", exact: true })
            .getAttribute("aria-selected"),
        )
        .toBe("true");
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
      expect(await gateway.getRequests("platformclaw.memory.graph")).toHaveLength(0);
      if (scenario.proofName === "en-US-desktop") {
        await page.getByRole("tab", { name: "Organization Graph", exact: true }).click();
        await expect
          .poll(() => gateway.getRequests("platformclaw.memory.graph"))
          .toEqual([
            expect.objectContaining({ params: { kind: "part", scopeId: "part-runtime" } }),
          ]);
        await expect
          .poll(() =>
            page.locator('[data-organization-node="organization/part/runtime-policy"]').count(),
          )
          .toBe(1);
        await page.getByRole("tab", { name: "Group Graph", exact: true }).click();
        await expect
          .poll(() => gateway.getRequests("platformclaw.memory.graph"))
          .toContainEqual(
            expect.objectContaining({ params: { kind: "group", scopeId: "group-platform" } }),
          );
        await expect
          .poll(() =>
            page.locator('[data-organization-node="organization/group/platform-policy"]').count(),
          )
          .toBe(1);
        const viewport = page.locator("[data-svg-graph-viewport]");
        const beforeZoom = Number(
          (await viewport.getAttribute("transform"))?.match(/scale\(([^)]+)\)/u)?.[1],
        );
        await page.getByRole("button", { name: "Zoom in" }).click();
        await expect
          .poll(async () =>
            Number((await viewport.getAttribute("transform"))?.match(/scale\(([^)]+)\)/u)?.[1]),
          )
          .toBeCloseTo(beforeZoom * 1.2, 8);
        await page.locator('[data-organization-node="organization/group/platform-policy"]').click();
        await expect
          .poll(() => page.locator(".organization-memory-graph__selection").textContent())
          .toContain("Platform policy");
        expect(await gateway.getRequests("platformclaw.memory.get")).toHaveLength(0);
        await page.getByRole("button", { name: "Open document", exact: true }).click();
        await expect
          .poll(() =>
            page
              .locator(".organization-memory-graph__preview .wiki-document__reader")
              .textContent(),
          )
          .toContain(scenario.snippet);
        expect(await gateway.getRequests("platformclaw.memory.get")).toEqual([
          expect.objectContaining({
            params: {
              agentId: "assigned-personal",
              path: "organization/group/platform-policy",
              fromLine: 1,
              lineCount: 200,
            },
          }),
        ]);
        expect(
          (await gateway.getRequests()).filter(({ method }) =>
            /platformclaw\.memory\.(?:promotion\.|claim\.|knowledge\.(?:generate|decide|apply))/u.test(
              method,
            ),
          ),
        ).toEqual([]);
      }
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

  it("uses the shared base fixture to browse readable scopes and opens only after explicit selection", async () => {
    const { page, context } = await openSharedFixture("platformclaw-memory", {
      width: 1440,
      height: 900,
    });
    try {
      await page.locator("#platformclaw-memory-tab-organization").click();
      await page.locator("#platformclaw-memory-organization-tab-graph").click();
      const graph = page.locator("platformclaw-organization-memory-graph");
      await expect
        .poll(() => graph.locator(".organization-memory-graph__scope select").inputValue())
        .toBe("part-runtime");
      await expect.poll(() => graph.locator("[data-organization-node]").count()).toBe(2);

      await graph
        .getByRole("combobox", { name: "Select a document" })
        .selectOption("organization:part:runtime-release-policy");
      await expect
        .poll(() => graph.locator(".organization-memory-graph__selection").textContent())
        .toContain("Runtime release guardrails");
      expect(
        await graph
          .locator("platformclaw-organization-memory-document-preview openclaw-modal-dialog")
          .count(),
      ).toBe(0);
      await graph.getByRole("button", { name: "Open document", exact: true }).click();
      await expect
        .poll(() =>
          graph.locator(".organization-memory-graph__preview .wiki-document__reader").textContent(),
        )
        .toContain("Production rollout starts with a bounded canary");
      await graph.getByRole("button", { name: "Close", exact: true }).click();

      await graph
        .locator(".organization-memory-graph__scope select")
        .selectOption("part-silicon-validation");
      await expect
        .poll(() =>
          graph
            .locator('[data-organization-node="organization/part/silicon-bringup-evidence"]')
            .count(),
        )
        .toBe(1);

      await graph.getByRole("tab", { name: "Group Graph", exact: true }).click();
      await expect.poll(() => graph.locator("[data-organization-node]").count()).toBe(3);
      const comparison = graph.locator('line[data-edge-type="comparison"]');
      await expect.poll(() => comparison.count()).toBe(1);
      await comparison.press("Enter");
      await expect
        .poll(() => graph.locator(".organization-memory-graph__edge-detail").textContent())
        .toContain("Kept separately");

      await graph.getByRole("tab", { name: "Team knowledge", exact: true }).click();
      await expect.poll(() => graph.locator("[data-organization-node]").count()).toBe(1);
      await graph.getByRole("tab", { name: "Global knowledge", exact: true }).click();
      await expect.poll(() => graph.locator("[data-organization-node]").count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("keeps the dense shared graph usable with search, relation filters, connected-only focus, and mobile controls", async () => {
    const { page, context } = await openSharedFixture("platformclaw-memory-busy", {
      width: 390,
      height: 844,
    });
    try {
      await page.locator("#platformclaw-memory-tab-organization").click();
      await page.locator("#platformclaw-memory-organization-tab-graph").click();
      const graph = page.locator("platformclaw-organization-memory-graph");
      await graph.getByRole("tab", { name: "Group Graph", exact: true }).click();
      await expect
        .poll(() => graph.locator("[data-organization-node]").count())
        .toBeGreaterThan(30);
      const denseCount = await graph.locator("[data-organization-node]").count();

      const search = graph.getByRole("searchbox", { name: "Search this graph" });
      await search.fill("DRAM training");
      await expect.poll(() => graph.locator("[data-organization-node]").count()).toBe(1);
      await expect
        .poll(() => graph.locator("[data-organization-node]").first().getAttribute("aria-label"))
        .toContain("DRAM training");
      await search.fill("");
      await expect.poll(() => graph.locator("[data-organization-node]").count()).toBe(denseCount);

      const picker = graph.getByRole("combobox", { name: "Select a document" });
      const firstDocumentValue = await picker.locator("option").nth(1).getAttribute("value");
      const firstDocumentTitle = (await picker.locator("option").nth(1).textContent())?.trim();
      expect(firstDocumentValue).toBeTruthy();
      expect(firstDocumentTitle).toBeTruthy();
      await picker.selectOption(firstDocumentValue!);
      expect(
        await graph
          .locator("platformclaw-organization-memory-document-preview openclaw-modal-dialog")
          .count(),
      ).toBe(0);
      await expect
        .poll(() => graph.getByRole("button", { name: "Focus selection" }).count())
        .toBe(1);
      expect(
        await graph
          .locator("platformclaw-organization-memory-document-preview openclaw-modal-dialog")
          .count(),
      ).toBe(0);

      const connected = graph.getByLabel("Show only connected documents");
      await connected.check();
      await expect
        .poll(() => graph.locator("[data-organization-node]").count())
        .toBeLessThan(denseCount);
      await connected.uncheck();
      await expect.poll(() => graph.locator("[data-organization-node]").count()).toBe(denseCount);

      const reference = graph.locator(
        '.organization-memory-graph__filters label[data-relation-type="reference"] input',
      );
      await reference.uncheck();
      await expect.poll(() => graph.locator('line[data-edge-type="reference"]').count()).toBe(0);
      expect(await graph.locator('line[data-edge-type="comparison"]').count()).toBeGreaterThan(0);

      await graph.getByRole("button", { name: "Focus selection", exact: true }).click();
      const selectedNode = graph.locator(`[data-svg-graph-node="${firstDocumentValue}"]`);
      const beforeDrag = await selectedNode.boundingBox();
      expect(beforeDrag).not.toBeNull();
      await page.mouse.move(
        beforeDrag!.x + beforeDrag!.width / 2,
        beforeDrag!.y + beforeDrag!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        beforeDrag!.x + beforeDrag!.width / 2 + 40,
        beforeDrag!.y + beforeDrag!.height / 2 + 25,
      );
      await page.mouse.up();
      const afterDrag = await selectedNode.boundingBox();
      expect(afterDrag).not.toBeNull();
      expect(afterDrag!.x - beforeDrag!.x).toBeCloseTo(40, 0);
      expect(afterDrag!.y - beforeDrag!.y).toBeCloseTo(25, 0);
      expect(
        await graph
          .locator("platformclaw-organization-memory-document-preview openclaw-modal-dialog")
          .count(),
      ).toBe(0);
      await graph.getByRole("button", { name: "Fit graph", exact: true }).click();
      await graph.getByRole("button", { name: "Enlarge graph", exact: true }).click();
      await expect
        .poll(() => graph.locator(".organization-memory-graph--expanded").count())
        .toBe(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1);
      await graph.getByRole("button", { name: "Open document", exact: true }).click();
      await expect
        .poll(() =>
          graph.locator(".organization-memory-graph__preview .wiki-document__reader").textContent(),
        )
        .toContain(firstDocumentTitle!);
      const readerPanel = graph.locator(".organization-memory-graph__preview");
      await readerPanel.waitFor({ state: "visible" });
      const readerBox = await readerPanel.boundingBox();
      expect(readerBox).not.toBeNull();
      expect(readerBox!.x).toBeGreaterThanOrEqual(0);
      expect(readerBox!.x + readerBox!.width).toBeLessThanOrEqual(390);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1);
      await graph.getByRole("button", { name: "Close", exact: true }).click();
    } finally {
      await context.close();
    }
  });
});
