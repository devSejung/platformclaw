import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "platformclaw-memory-actions",
);
const agentId = "assigned-personal";
let browser: Browser;
let server: ControlUiE2eServer;

async function installPlatformClawDocument(page: Page) {
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
        agent: { agentId, state: "active" },
      },
      status: 200,
    }),
  );
}

suite("PlatformClaw memory actions E2E", () => {
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

  it("confirms file deletion, explicitly submits Wiki sharing, and inspects organization provenance", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
      ...(capture ? { recordVideo: { dir: proofDir, size: { width: 1440, height: 1000 } } } : {}),
    });
    try {
      const page = await context.newPage();
      const screenshot = async (name: string) => {
        if (capture) {
          await page.screenshot({
            path: path.join(proofDir, `${name}.png`),
            animations: "disabled",
            fullPage: true,
          });
        }
      };
      await installPlatformClawDocument(page);
      const gateway = await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: agentId,
        featureMethods: [
          "agents.list",
          "agents.workspace.get",
          "agents.workspace.list",
          "doctor.memory.status",
          "memory.search",
          "memory.delete",
          "wiki.search",
          "wiki.document.get",
          "wiki.get",
          "wiki.delete",
          "wiki.overview",
          "wiki.graph",
          "platformclaw.memory.lifecycle",
          "platformclaw.memory.graph",
          "platformclaw.memory.get",
          "platformclaw.memory.promotion.submit",
        ],
        methodResponses: {
          "agents.list": {
            agents: [{ id: agentId, name: "Personal Agent" }],
            defaultId: agentId,
            mainKey: agentId,
            scope: "agent",
          },
          "doctor.memory.status": {
            agentId,
            provider: "builtin",
            embedding: { ok: true, checked: true },
          },
          "agents.workspace.list": { entries: [], hasAdditionalFolders: false },
          "agents.workspace.get": {
            file: {
              path: "MEMORY.md",
              name: "MEMORY.md",
              encoding: "utf8",
              content: "# Personal memory\nDelete this entire obsolete checklist.",
              contentHash: "a".repeat(64),
            },
          },
          "memory.delete": {
            agentId,
            path: "MEMORY.md",
            deleted: true,
            indexesRefreshed: true,
            wikiRefreshed: true,
          },
          "memory.search": { agentId, provider: "builtin", searchMode: "fts-only", results: [] },
          "wiki.search": [
            {
              path: "runbooks/recovery.md",
              title: "Recovery runbook",
              snippet: "Record the recovery owner.",
              score: 0.9,
              startLine: 1,
              endLine: 2,
            },
          ],
          "wiki.delete": {
            agentId,
            path: "runbooks/recovery.md",
            deleted: true,
            indexesRefreshed: true,
          },
          "wiki.overview": {
            totalItems: 1,
            totalPages: 1,
            pageCounts: { entity: 0, concept: 1, source: 0, synthesis: 0, report: 0 },
            totalClaims: 0,
            totalQuestions: 0,
            totalContradictions: 0,
            clusters: [
              {
                key: "concept",
                label: "Concepts",
                itemCount: 1,
                claimCount: 0,
                questionCount: 0,
                contradictionCount: 0,
                items: [
                  {
                    pagePath: "runbooks/recovery.md",
                    title: "Recovery runbook",
                    kind: "concept",
                    claimCount: 0,
                    questionCount: 0,
                    contradictionCount: 0,
                    claims: [],
                    questions: [],
                    contradictions: [],
                    snippet: "Record the recovery owner.",
                  },
                ],
              },
            ],
          },
          "wiki.graph": {
            nodes: [{ id: "runbooks/recovery.md", title: "Recovery runbook", kind: "concept" }],
            edges: [],
            stats: {
              totalPages: 1,
              totalNodes: 1,
              totalEdges: 0,
              unresolvedLinks: 0,
              truncated: false,
            },
          },
          "wiki.document.get": {
            contentHash: "b".repeat(64),
            path: "runbooks/recovery.md",
            title: "Recovery runbook",
            content: "# Recovery\nRecord the recovery owner and verify the backup.",
            displayContent: "# Recovery\nRecord the recovery owner and verify the backup.",
            sourceContent: "# Recovery\nRecord the recovery owner and verify the backup.",
            editMode: "body",
            editableContent: "# Recovery\nRecord the recovery owner and verify the backup.",
            revision: "b".repeat(64),
            fromLine: 1,
            lineCount: 2,
            totalLines: 2,
            truncated: false,
          },
          "wiki.get": {
            contentHash: "b".repeat(64),
            path: "runbooks/recovery.md",
            title: "Recovery runbook",
            content: "# Recovery\nRecord the recovery owner and verify the backup.",
            fromLine: 1,
            lineCount: 2,
            totalLines: 2,
            truncated: false,
          },
          "platformclaw.memory.promotion.submit": { id: "request-recovery", status: "pending" },
          "platformclaw.memory.lifecycle": {
            scopes: [{ kind: "part", id: "part-runtime", name: "Runtime", canAdminister: false }],
            personalTargets: [
              { kind: "part", scopeId: "part-runtime", scopeName: "Runtime", mode: "request" },
            ],
            claims: [],
            submitted: [],
            reviewable: [],
            canApproveGlobal: false,
          },
          "platformclaw.memory.get": {
            id: "approved-policy",
            path: "organization/part/approved-policy",
            scopeKind: "part",
            scopeName: "Runtime",
            title: "Approved recovery policy",
            content: "Record the recovery owner.",
            fromLine: 1,
            lineCount: 1,
          },
          "platformclaw.memory.graph": {
            kind: "part",
            nodes: [
              {
                id: "organization:part:approved-policy",
                path: "organization/part/approved-policy",
                title: "Approved recovery policy",
                scopeName: "Runtime",
                updatedAt: 1,
                verification: {
                  revision: 2,
                  approvalStatus: "approved",
                  sourceRevision: 1,
                  sourceStatus: "changed",
                },
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
      });
      await page.goto(`${server.baseUrl}platformclaw/app/settings/memory`);
      await expect.poll(() => page.locator("platformclaw-memory-page").isVisible()).toBe(true);
      await page.getByRole("tab", { name: "Memory", exact: true }).click();
      const memoryRow = page.locator(".memory-memories__result").filter({ hasText: "MEMORY.md" });
      await expect.poll(() => memoryRow.isVisible()).toBe(true);
      await screenshot("01-personal-memory");
      await memoryRow.getByRole("button", { name: "Memory actions" }).click();
      await page.locator('platformclaw-memory-item-menu wa-dropdown-item[value="delete"]').click();
      const deletion = page.locator("platformclaw-memory-delete-dialog");
      expect(
        await deletion
          .locator(".platformclaw-memory-action-dialog")
          .evaluate((dialog) => getComputedStyle(dialog).overflowY),
      ).toBe("auto");
      await expect
        .poll(() => deletion.locator(".wiki-document__reader").textContent())
        .toContain("Delete this entire obsolete checklist");
      expect(await gateway.getRequests("memory.delete")).toHaveLength(0);
      await screenshot("02-delete-preview");
      await gateway.deferNext("memory.delete");
      const memoryUrl = page.url();
      await deletion.getByRole("button", { name: "Delete memory file", exact: true }).click();
      await gateway.waitForRequest("memory.delete");
      await page.keyboard.press("Escape");
      expect(page.url()).toBe(memoryUrl);
      await expect
        .poll(() =>
          deletion.getByRole("dialog", { name: "Delete memory file", exact: true }).isVisible(),
        )
        .toBe(true);
      await gateway.rejectDeferred("memory.delete", {
        message: "Memory changed. Refresh and retry.",
      });
      await expect
        .poll(() => deletion.getByRole("alert").textContent())
        .toContain("Memory changed");
      await deletion.getByRole("button", { name: "Delete memory file", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("memory.delete")).length).toBe(2);
      const deleteParams = {
        agentId,
        path: "MEMORY.md",
        expectedContentHash: "a".repeat(64),
      };
      expect((await gateway.getRequests("memory.delete")).map((request) => request.params)).toEqual(
        [deleteParams, deleteParams],
      );
      await expect
        .poll(() => page.locator("platformclaw-memory-page").textContent())
        .toContain("Memory file deleted. Search and imported Wiki sources refreshed.");
      await screenshot("03-delete-result");

      await page.locator("#memory-search-input").fill("recovery");
      await page
        .locator(".memory-memories__search")
        .evaluate((form) => (form as HTMLFormElement).requestSubmit());
      const wikiRow = page
        .locator(".memory-memories__result")
        .filter({ hasText: "Recovery runbook" });
      await expect.poll(() => wikiRow.isVisible()).toBe(true);
      expect(await wikiRow.getByRole("button", { name: "Memory actions" }).count()).toBe(1);
      await wikiRow.click({ button: "right" });
      await screenshot("04-wiki-context-menu");
      await page.locator('platformclaw-memory-item-menu wa-dropdown-item[value="share"]').click();
      let promotion = page.locator("openclaw-modal-dialog openclaw-memory-promotions");
      expect(
        await page
          .locator(".platformclaw-memory-action-dialog")
          .evaluate((dialog) => getComputedStyle(dialog).overflowY),
      ).toBe("auto");
      await expect
        .poll(() => promotion.locator(".memory-promotions__field textarea").first().inputValue())
        .toContain("verify the backup");
      expect(await gateway.getRequests("platformclaw.memory.promotion.submit")).toHaveLength(0);
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await wikiRow.getByRole("button", { name: "Memory actions" }).click();
      await page.locator('platformclaw-memory-item-menu wa-dropdown-item[value="share"]').click();
      promotion = page.locator("openclaw-modal-dialog openclaw-memory-promotions");
      await expect
        .poll(() => promotion.locator(".memory-promotions__field textarea").first().inputValue())
        .toContain("verify the backup");
      await promotion.locator(".memory-promotions__field select").selectOption("part-runtime");
      await promotion
        .locator(".memory-promotions__field input")
        .fill("Verified recovery process for the team");
      await promotion.locator(".memory-promotions__field input").press("Tab");
      await expect
        .poll(() =>
          promotion
            .locator("button.primary")
            .evaluate((button) => document.activeElement === button),
        )
        .toBe(true);
      await expect
        .poll(() => promotion.locator(".memory-promotions__visibility").textContent())
        .toContain("Reviewers for Runtime");
      await screenshot("04-sharing-review");
      expect(await gateway.getRequests("platformclaw.memory.promotion.submit")).toHaveLength(0);
      await gateway.deferNext("platformclaw.memory.promotion.submit");
      await promotion.locator("button.primary").click();
      await gateway.waitForRequest("platformclaw.memory.promotion.submit");
      await page.keyboard.press("Escape");
      const shareModal = page.locator(
        'openclaw-modal-dialog[label="Request organization sharing…"]',
      );
      const shareDialog = page.getByRole("dialog", {
        name: "Request organization sharing…",
        exact: true,
      });
      await expect.poll(() => shareDialog.isVisible()).toBe(true);
      expect(
        await shareModal.getByRole("button", { name: "Close", exact: true }).isDisabled(),
      ).toBe(true);
      await gateway.rejectDeferred("platformclaw.memory.promotion.submit", {
        message: "Sharing failed. Try again.",
      });
      await expect
        .poll(() => promotion.getByRole("alert").textContent())
        .toContain("Sharing failed");
      expect(await promotion.locator(".memory-promotions__field input").inputValue()).toBe(
        "Verified recovery process for the team",
      );
      await promotion.locator("button.primary").click();
      await expect
        .poll(
          async () => (await gateway.getRequests("platformclaw.memory.promotion.submit")).length,
        )
        .toBe(2);
      const submitted = (await gateway.getRequests("platformclaw.memory.promotion.submit")).at(-1)!;
      expect(submitted.params).toEqual(
        expect.objectContaining({
          sourceKind: "personal",
          sourceClaimId: "runbooks/recovery.md",
          targetKind: "part",
          targetScopeId: "part-runtime",
          reason: "Verified recovery process for the team",
        }),
      );
      await expect
        .poll(() => page.locator("platformclaw-memory-page").textContent())
        .toContain("Sharing request submitted to Runtime.");
      await screenshot("05-sharing-submitted");

      await page.getByRole("tab", { name: "Personal Wiki", exact: true }).click();
      const personalWiki = page.locator("openclaw-agent-memory-panel");
      await expect.poll(() => personalWiki.textContent()).toContain("Recovery runbook");
      await personalWiki.locator(".memory-wiki-view-switch button").nth(1).click();
      const node = personalWiki.locator('[data-wiki-node="runbooks/recovery.md"]');
      await expect.poll(() => node.count()).toBe(1);
      await node.locator("circle").click({ button: "right" });
      await expect
        .poll(() => page.locator("platformclaw-memory-item-menu wa-dropdown-item").count())
        .toBe(2);
      await screenshot("07-wiki-delete-menu");
      await page.locator('platformclaw-memory-item-menu wa-dropdown-item[value="delete"]').click();
      await expect
        .poll(() => deletion.locator(".wiki-document__reader").textContent())
        .toContain("verify the backup");
      expect(await gateway.getRequests("wiki.delete")).toHaveLength(0);
      await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("wiki.delete")).toHaveLength(0);
      await node.locator("circle").click({ button: "right" });
      await page.locator('platformclaw-memory-item-menu wa-dropdown-item[value="delete"]').click();
      await expect
        .poll(() => deletion.locator(".wiki-document__reader").textContent())
        .toContain("verify the backup");
      await expect
        .poll(() => deletion.textContent())
        .toContain("Raw memory, conversations, and approved organization knowledge are retained");
      await screenshot("08-wiki-delete-confirmation");
      const graphsBefore = (await gateway.getRequests("wiki.graph")).length;
      await gateway.setMethodResponse("wiki.graph", {
        nodes: [],
        edges: [],
        stats: {
          totalPages: 0,
          totalNodes: 0,
          totalEdges: 0,
          unresolvedLinks: 0,
          truncated: false,
        },
      });
      await gateway.setMethodResponse("wiki.overview", {
        totalItems: 0,
        totalPages: 0,
        pageCounts: { entity: 0, concept: 0, source: 0, synthesis: 0, report: 0 },
        totalClaims: 0,
        totalQuestions: 0,
        totalContradictions: 0,
        clusters: [],
      });
      await deletion
        .getByRole("button", { name: "Delete Personal Wiki page", exact: true })
        .click();
      const wikiDeleted = await gateway.waitForRequest("wiki.delete");
      expect(wikiDeleted.params).toEqual({
        agentId,
        path: "runbooks/recovery.md",
        expectedContentHash: "b".repeat(64),
      });
      await expect
        .poll(async () => (await gateway.getRequests("wiki.graph")).length)
        .toBeGreaterThan(graphsBefore);
      await expect.poll(() => node.count()).toBe(0);
      await personalWiki.locator(".memory-wiki-view-switch button").first().click();
      await expect.poll(() => personalWiki.textContent()).not.toContain("Recovery runbook");
      expect(await gateway.getRequests("memory.delete")).toHaveLength(2);
      await screenshot("09-wiki-deleted");

      await page.getByRole("tab", { name: "Organization", exact: true }).click();
      await page.getByRole("tab", { name: "Organization Graph", exact: true }).click();
      const graph = page.locator("platformclaw-organization-memory-graph");
      await expect.poll(() => graph.isVisible()).toBe(true);
      await graph.locator('[data-organization-node="organization/part/approved-policy"]').click();
      await expect
        .poll(() => graph.locator("[data-memory-verification]").textContent())
        .toContain("Source changed since approval");
      await screenshot("06-organization-map");
    } finally {
      await context.close();
    }
  });
});
