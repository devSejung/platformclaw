import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  waitForControlUiRoute,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createPlatformClawMemoryContext,
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
  platformClawMemoryMethods,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "shared-vault");
const rpc = "platformclaw.vault.";
const personalSource =
  "---\ntitle: Personal training notes\n---\n# Training\n\n  Reviewed original.  \n";
const doc: KnowledgeVaultDocument = {
  id: "doc-training",
  vaultId: "vault-phy",
  title: "Training sequence",
  logicalPath: "guides/training.md",
  revision: 3,
  updatedAt: 1_790_467_200_000,
  content:
    "# Training sequence\n\n1. Initialize the controller.\n2. Verify the training result.\n\nThe original Markdown stays unchanged.",
  links: [],
  backlinks: [],
  compile: {
    status: "failed",
    indexedRevision: 2,
    error: "Index compiler temporarily unavailable",
    attempts: 1,
    retryAt: 1_790_467_260_000,
  },
};
function snapshot(owner: boolean, connected = true, selected = false): KnowledgeVaultSnapshot {
  const vault = {
    id: "vault-phy",
    name: "Ulysses PHY Spec",
    type: "shared" as const,
    description: "Project specifications and reviewed training notes.",
    role: owner ? ("owner" as const) : ("reader" as const),
    canEdit: owner,
    canManageMembers: owner,
    canExport: owner,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    selectionRevision: connected ? 2 : 3,
    vaults: [
      { ...vault, connected, documentCount: 1, attachmentCount: 0 },
      {
        ...vault,
        id: "managed:team:platform",
        name: "Platform Handbook",
        type: "managed",
        description: "Approved team knowledge and engineering standards.",
        role: "reader",
        connected: false,
        canEdit: false,
        canManageMembers: false,
        canExport: false,
        documentCount: 4,
        attachmentCount: 0,
      },
      {
        ...vault,
        id: "vault-dram",
        name: "DRAM Controller",
        description: "Controller architecture, timing constraints, and integration notes.",
        role: owner ? "editor" : "reader",
        connected: false,
        canEdit: owner,
        canManageMembers: false,
        canExport: false,
        documentCount: 8,
        attachmentCount: 2,
      },
    ],
    selected: selected
      ? {
          vault,
          documents: [
            doc,
            {
              ...doc,
              id: "doc-init",
              title: "Initialization",
              logicalPath: "guides/init.md",
              compile: {
                ...doc.compile,
                status: "ready",
                indexedRevision: 3,
                error: null,
                retryAt: null,
              },
            },
            {
              ...doc,
              id: "doc-orphan",
              title: "Unlinked notes",
              logicalPath: "notes/orphan.md",
              compile: {
                ...doc.compile,
                status: "ready",
                indexedRevision: 3,
                error: null,
                retryAt: null,
              },
            },
          ],
          graph: {
            edges: [
              { source: doc.id, target: "doc-init" },
              { source: "doc-init", target: doc.id },
            ],
            unresolvedLinks: 1,
            truncated: false,
          },
          members: [
            {
              userId: "u-owner",
              accountId: "owner.one",
              displayName: "Project Owner",
              role: "owner",
              canExport: true,
            },
          ],
          attachments: [],
        }
      : undefined,
  };
}
function snapshotResponse(owner: boolean, connected = true) {
  return {
    cases: [
      { match: { vaultId: "vault-phy" }, response: snapshot(owner, connected, true) },
      { match: {}, response: snapshot(owner, connected) },
    ],
  };
}
let browser: Browser;
let server: ControlUiE2eServer;
async function screenshot(page: Page, name: string, target?: Locator) {
  if (capture) {
    // Settings scroll inside the app shell; full-page capture leaves content clipped.
    await target?.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
    );
    await page.screenshot({
      path: path.join(proofDir, name),
      animations: "disabled",
      fullPage: false,
    });
  }
}
suite("Shared Knowledge Vault browser experience", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error("Playwright Chromium is required for Shared Vault browser proof.");
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
  it.each([
    { owner: true, locale: "ko-KR", width: 1440, name: "owner-ko-desktop" },
    { owner: false, locale: "en-US", width: 390, name: "reader-en-mobile" },
  ])(
    "shows capabilities, source preservation and provenance: $name",
    async ({ owner, locale, width, name: caseName }) => {
      const viewport = { width, height: 900 };
      const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
        locale,
        mode: "light",
        viewport,
        ...(capture ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      });
      const page = await context.newPage();
      try {
        await installPlatformClawMemoryDocument(page, server.baseUrl);
        const gateway = await installMockGateway(page, {
          basePath: "/platformclaw/app",
          defaultAgentId: platformClawMemoryAgentId,
          featureMethods: [
            ...platformClawMemoryMethods,
            ...[
              "snapshot",
              "connection.set",
              "create",
              "document.get",
              "document.save",
              "document.preview",
              "member.set",
              "member.remove",
              "rebuild",
              "publish",
            ].map((name) => `${rpc}${name}`),
          ],
          methodResponses: {
            ...platformClawMemoryResponses,
            [`${rpc}snapshot`]: snapshotResponse(owner),
            [`${rpc}connection.set`]: {
              cases: [
                { match: { connected: true }, response: snapshot(owner, true) },
                { match: { connected: false }, response: snapshot(owner, false) },
              ],
            },
            [`${rpc}document.get`]: {
              cases: [
                {
                  match: { vaultId: "vault-dram" },
                  response: {
                    ...doc,
                    vaultId: "vault-dram",
                    id: "doc-dram",
                    title: "Controller training",
                  },
                },
                { match: {}, response: doc },
              ],
            },
            [`${rpc}document.save`]: { ...doc, revision: 4 },
            [`${rpc}document.preview`]: {
              cases: [
                {
                  match: { filename: "imported.markdown" },
                  response: { title: "Extracted training title", logicalPath: "imported.md" },
                },
                {
                  match: { title: "New training notes" },
                  response: { title: "New training notes", logicalPath: "new-training.md" },
                },
                {
                  match: {},
                  response: { title: "Personal training notes", logicalPath: "training.md" },
                },
              ],
            },
            "wiki.search": [
              {
                path: "concepts/personal-training.md",
                title: "Personal training notes",
                snippet: "Reviewed original",
              },
            ],
            [`${rpc}publish`]: doc,
            "wiki.document.get": {
              path: "concepts/personal-training.md",
              title: "Personal training notes",
              displayContent: personalSource,
              sourceContent: personalSource,
              revision: "body-only-revision",
              truncated: false,
            },
            "memory.search": {
              agentId: platformClawMemoryAgentId,
              provider: "local",
              results: [
                {
                  vaultId: doc.vaultId,
                  vaultName: "Ulysses PHY Spec",
                  vaultType: "shared",
                  documentId: doc.id,
                  title: doc.title,
                  path: `shared/${doc.vaultId}/${doc.id}`,
                  snippet: "Verify the training result.",
                  revision: 2,
                  score: 1,
                  source: "shared",
                  startLine: 1,
                  endLine: 3,
                },
              ],
            },
          },
        });
        await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/vaults`);
        await waitForControlUiRoute(page, {
          routeId: "memory",
          pathname: "/platformclaw/app/settings/memory/vaults",
        });
        const panel = page.locator("platformclaw-memory-vaults");
        await expect.poll(() => panel.textContent()).toContain("Ulysses PHY Spec");
        const memoryTabs = page.locator(".platformclaw-memory-page__tabs");
        expect(await memoryTabs.locator("wa-tab").count()).toBe(5);
        expect(await memoryTabs.textContent()).toContain("Personal Wiki");
        expect(await memoryTabs.textContent()).toContain("Dreaming");
        await screenshot(page, `${caseName}-initial.png`, memoryTabs);
        const sharedCard = panel.locator('[data-vault-card="vault-phy"]');
        await sharedCard
          .getByRole("button", { name: owner ? "연결 해제" : "Disconnect", exact: true })
          .click();
        await expect.poll(() => sharedCard.count()).toBe(0);
        const disconnected = await gateway.waitForRequest(`${rpc}connection.set`);
        expect(disconnected.params).toEqual({ vaultId: "vault-phy", connected: false });
        await gateway.setMethodResponse(`${rpc}snapshot`, snapshotResponse(owner, false));
        await panel.locator("#vault-catalog-tab-discover").click();
        await expect.poll(() => panel.locator("[data-vault-card]").count()).toBe(3);
        await screenshot(page, `${caseName}-discover.png`, memoryTabs);
        const catalogSearch = panel.locator(".vaults__catalog-search input");
        await catalogSearch.fill("Ulysses");
        await expect.poll(() => panel.locator("[data-vault-card]").count()).toBe(1);
        await sharedCard
          .getByRole("button", {
            name: owner ? "내 볼트에 추가" : "Add to my vaults",
            exact: true,
          })
          .click();
        await expect
          .poll(() => sharedCard.textContent())
          .toContain(owner ? "AI 참고 중" : "AI reference enabled");
        await gateway.setMethodResponse(`${rpc}snapshot`, snapshotResponse(owner, true));
        await panel.locator("#vault-catalog-tab-mine").click();
        await catalogSearch.fill("");
        await expect.poll(() => panel.locator("[data-vault-card]").count()).toBe(2);
        await sharedCard.getByRole("button", { name: "Ulysses PHY Spec", exact: true }).click();
        await expect.poll(() => panel.locator("[data-vault-index=failed]").count()).toBe(1);
        await screenshot(
          page,
          `${caseName}-vault.png`,
          panel.locator(".vaults__selected > header"),
        );
        await panel.locator("#vault-documents-tab-graph").click();
        const graph = panel.locator(".vault-graph");
        await expect.poll(() => graph.locator("[data-svg-graph-node]").count()).toBe(3);
        expect(await graph.locator('line[marker-end="url(#vault-graph-arrow)"]').count()).toBe(2);
        const graphSearch = graph.locator("input[type=search]");
        await graphSearch.fill("orphan.md");
        await expect.poll(() => graph.locator("[data-svg-graph-node]").count()).toBe(1);
        expect(await graph.locator("line").count()).toBe(0);
        await graphSearch.fill("");
        await expect.poll(() => graph.locator("[data-svg-graph-node]").count()).toBe(3);
        await graphSearch.fill("orphan.md");
        await expect.poll(() => graph.locator("[data-svg-graph-node]").count()).toBe(1);
        await graph
          .getByRole("button", { name: owner ? "화면에 맞추기" : "Fit graph", exact: true })
          .click();
        await graphSearch.fill("");
        await expect.poll(() => graph.locator("[data-svg-graph-node]").count()).toBe(3);
        await expect
          .poll(async () => {
            const text = await graph.locator("[data-svg-graph-node] text").first().boundingBox();
            return text?.height ?? 0;
          })
          .toBeGreaterThanOrEqual(10);
        const nodeColumns = await graph
          .locator("[data-svg-graph-node] circle")
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().x));
        expect(Math.max(...nodeColumns) - Math.min(...nodeColumns)).toBeGreaterThan(80);
        await graph.locator("select").selectOption(doc.id);
        await expect
          .poll(() => graph.locator(".vault-graph__inspector h3").textContent())
          .toBe(doc.title);
        await screenshot(page, `${caseName}-shared-graph.png`, graph.locator(".vault-graph__body"));
        const transform = await graph
          .locator("[data-svg-graph-viewport]")
          .getAttribute("transform");
        await graph.getByRole("button", { name: owner ? "확대" : "Zoom in", exact: true }).click();
        expect(await graph.locator("[data-svg-graph-viewport]").getAttribute("transform")).not.toBe(
          transform,
        );
        await graph
          .getByRole("button", { name: owner ? "문서 열기" : "Open document", exact: true })
          .click();
        await expect
          .poll(() =>
            panel.locator("[data-vault-document] .dreams-diary__preview-title").textContent(),
          )
          .toBe(doc.title);
        await page.keyboard.press("Escape");
        await expect.poll(() => panel.locator("[data-vault-document]").count()).toBe(0);
        await panel.locator("#vault-documents-tab-documents").click();
        if (owner) {
          await panel.getByRole("button", { name: "지식 추가", exact: true }).click();
          const editor = panel.locator("[data-vault-editor]");
          await editor.locator("[name=title]").fill("New training notes");

          await editor.locator("[name=content]").fill("# Authored\n\n  Preserve these spaces.  \n");
          await screenshot(page, `${caseName}-editor.png`, editor);
          await editor.locator("button.primary").click();
          await expect.poll(() => editor.locator(".vaults__author-preview").count()).toBe(1);
          await editor.getByRole("button", { name: "문서 저장", exact: true }).click();
          const saved = await gateway.waitForRequest(`${rpc}document.save`);
          expect(saved.params).toEqual({
            vaultId: "vault-phy",
            title: "New training notes",
            content: "# Authored\n\n  Preserve these spaces.  \n",
          });
          await expect.poll(() => editor.count()).toBe(0);
          await page.keyboard.press("Escape");
          await panel.getByRole("button", { name: "지식 추가", exact: true }).click();
          await panel.locator("#vault-author-source-tab-upload").click();
          const importedContent =
            "\uFEFF---\r\ntitle: Extracted training title\r\n---\r\n# Training\r\n\r\n  Preserve original.  \r\n";
          await panel.locator('input[accept=".md,.markdown,text/markdown"]').setInputFiles({
            name: "imported.markdown",
            mimeType: "text/markdown",
            buffer: Buffer.from(importedContent),
          });
          await expect
            .poll(() => panel.locator("[name=title]").inputValue())
            .toBe("Extracted training title");
          expect(await gateway.getRequests(`${rpc}document.save`)).toHaveLength(1);
          await panel.getByRole("button", { name: "문서 저장", exact: true }).click();
          await expect
            .poll(async () => (await gateway.getRequests(`${rpc}document.save`)).at(-1)?.params)
            .toEqual({
              vaultId: "vault-phy",
              title: "Extracted training title",
              content: importedContent,
              filename: "imported.markdown",
            });
          await expect.poll(() => panel.locator("platformclaw-vault-author").count()).toBe(0);
          await page.keyboard.press("Escape");
          await panel.getByRole("button", { name: "지식 추가", exact: true }).click();
          await panel.locator("#vault-author-source-tab-personal").click();
          const sourceQuery = panel.locator("#memory-source-query");
          await sourceQuery.fill("training");
          await sourceQuery.press("Enter");
          await panel.locator(".memory-source-picker__result").click();
          await expect
            .poll(() => panel.locator("[name=content]").inputValue())
            .toBe(personalSource);
          await panel.locator("[name=content]").fill("# Team training\n\nReviewed shared copy.");
          expect(await gateway.getRequests(`${rpc}publish`)).toHaveLength(0);
          await panel.locator("[data-vault-editor] button.primary").click();
          await expect.poll(() => panel.locator(".vaults__author-preview").count()).toBe(1);
          await screenshot(
            page,
            `${caseName}-publish-review.png`,
            panel.locator(".vaults__author-preview"),
          );
          await panel.getByRole("button", { name: "공유 사본 게시", exact: true }).click();
          const published = await gateway.waitForRequest(`${rpc}publish`);
          expect(published.params).toEqual({
            lookup: "concepts/personal-training.md",
            targetVaultId: "vault-phy",
            title: "Personal training notes",
            content: "# Team training\n\nReviewed shared copy.",
            expectedRevision: createHash("sha256").update(personalSource).digest("hex"),
          });
          await expect.poll(() => panel.locator("platformclaw-vault-author").count()).toBe(0);
          await page.keyboard.press("Escape");
        } else {
          expect(
            await panel.getByRole("button", { name: "Add knowledge", exact: true }).count(),
          ).toBe(0);
          expect(
            await panel
              .getByRole("button", { name: "Download entire vault ZIP", exact: true })
              .count(),
          ).toBe(0);
        }
        await panel.getByRole("button", { name: "Training sequence", exact: true }).click();
        await expect
          .poll(() => panel.locator("[data-vault-document] h1").textContent())
          .toBe("Training sequence");
        await screenshot(page, `${caseName}-document.png`, panel.locator("[data-vault-document]"));
        const bounds = await panel.locator("[data-vault-document]").boundingBox();
        expect(bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.height).toBeLessThanOrEqual(viewport.height);
        await page.keyboard.press("Escape");
        await expect.poll(() => panel.locator("[data-vault-document]").count()).toBe(0);
        const input = panel.locator("#memory-search-input");
        await input.fill("training");
        await input.press("Enter");
        const search = await gateway.waitForRequest("memory.search");
        expect(search.params).toEqual({
          agentId: platformClawMemoryAgentId,
          query: "training",
          vaultId: "vault-phy",
        });
        await expect
          .poll(() => panel.locator("[data-vault-provenance]").textContent())
          .toContain("Ulysses PHY Spec");
        expect(await gateway.getRequests("wiki.search")).toHaveLength(owner ? 1 : 0);
        await screenshot(page, `${caseName}-search.png`, panel.locator(".memory-memories__result"));
        if (capture) {
          const provenance = await panel.locator("[data-vault-provenance]").boundingBox();
          expect(provenance).not.toBeNull();
          expect(provenance!.y).toBeGreaterThanOrEqual(0);
          expect(provenance!.y + provenance!.height).toBeLessThanOrEqual(viewport.height);
        }
        await panel.locator(".memory-memories__result > button.settings-row").click();
        await expect
          .poll(() =>
            panel.locator("[data-vault-document] .dreams-diary__preview-title").textContent(),
          )
          .toBe(doc.title);
        await page.keyboard.press("Escape");
        await expect.poll(() => input.inputValue()).toBe("training");
        await panel.locator("#vault-search-tab-all").click();
        await gateway.setMethodResponse("memory.search", {
          agentId: platformClawMemoryAgentId,
          provider: "local",
          results: [
            {
              vaultId: "vault-dram",
              vaultName: "DRAM Controller",
              vaultType: "shared",
              documentId: "doc-dram",
              title: "Controller training",
              path: "shared/vault-dram/doc-dram",
              snippet: "Cross-vault training",
              revision: 3,
              score: 1,
              source: "shared",
              startLine: 1,
              endLine: 3,
            },
          ],
        });
        await input.fill("all training");
        await input.press("Enter");
        await expect
          .poll(async () => (await gateway.getRequests("memory.search")).at(-1)?.params)
          .toEqual({ agentId: platformClawMemoryAgentId, query: "all training", scope: "all" });
        await panel.locator(".memory-memories__result > button.settings-row").click();
        await expect
          .poll(() =>
            panel.locator("[data-vault-document] .dreams-diary__preview-meta").textContent(),
          )
          .toContain("DRAM Controller");
        expect(await panel.locator(".vaults__selected > header h2").textContent()).toBe(
          "Ulysses PHY Spec",
        );
        if (owner) {
          await panel.getByRole("button", { name: "편집 · 이동", exact: true }).click();
          const crossAuthor = panel.locator("platformclaw-vault-author");
          expect(await crossAuthor.textContent()).toContain("DRAM Controller");
          await crossAuthor.getByRole("button", { name: "취소", exact: true }).click();
        } else {
          expect(
            await panel
              .locator("[data-vault-document]")
              .getByRole("button", { name: "Edit / move", exact: true })
              .count(),
          ).toBe(0);
        }
        await page.keyboard.press("Escape");
        await expect.poll(() => input.inputValue()).toBe("all training");
        expect(await panel.locator(".memory-memories__result").count()).toBe(1);
        await memoryTabs.locator("#platformclaw-memory-tab-memory").click();
        await gateway.setMethodResponse("memory.search", {
          agentId: platformClawMemoryAgentId,
          results: [
            {
              vaultId: "vault-phy",
              vaultName: "Ulysses PHY Spec",
              vaultType: "shared",
              documentId: doc.id,
              title: doc.title,
              path: doc.logicalPath,
              snippet: "Training",
              revision: 3,
              source: "shared",
              score: 1,
              startLine: 1,
              endLine: 3,
            },
          ],
        });
        const memorySearch = page.locator("openclaw-memory-memories #memory-search-input");
        await memorySearch.fill("general shared training");
        await memorySearch.press("Enter");
        await page.locator('[data-memory-source="shared"] > button.settings-row').click();
        const sharedReader = page.locator("platformclaw-vault-reader");
        await expect.poll(() => sharedReader.locator("[data-vault-document]").count()).toBe(1);
        await waitForControlUiRoute(page, {
          routeId: "memory",
          pathname: "/platformclaw/app/settings/memory/memories",
        });
        expect(await page.locator(".memory-memories__detail").count()).toBe(0);
        await screenshot(page, `${caseName}-general-memory-reader.png`, sharedReader);
        if (owner) {
          await sharedReader.getByRole("button", { name: "편집 · 이동", exact: true }).click();
          const draft = sharedReader.locator("platformclaw-vault-author");
          await draft.locator("[name=content]").fill("# Unsaved shared edit");
          await page.keyboard.press("Escape");
          await expect.poll(() => draft.textContent()).toContain("저장하지 않은 변경을 버릴까요?");
          await screenshot(page, "dirty-draft-confirmation-ko-desktop.png", draft);
          await draft.getByRole("button", { name: "계속 편집", exact: true }).click();
          expect(await draft.locator("[name=content]").inputValue()).toBe("# Unsaved shared edit");
          await draft.getByRole("button", { name: "취소", exact: true }).click();
          await draft.getByRole("button", { name: "변경 버리기", exact: true }).click();
          await expect.poll(() => sharedReader.locator("[data-vault-document]").count()).toBe(1);
        }
        await page.keyboard.press("Escape");
        await expect.poll(() => sharedReader.count()).toBe(0);
        expect(await memorySearch.inputValue()).toBe("general shared training");
        expect(await page.locator('[data-memory-source="shared"]').count()).toBe(1);
        if (owner) {
          await memoryTabs.locator("#platformclaw-memory-tab-wiki").click();
          await page
            .locator('[data-wiki-page="syntheses/release-preflight.md"] .memory-wiki-card__title')
            .click();
          const personalReader = page.locator("openclaw-agent-memory-panel openclaw-modal-dialog");
          await personalReader
            .getByRole("button", { name: "공유 볼트에 게시", exact: true })
            .click();
          const author = page.locator("platformclaw-vault-author");
          await author.locator(".vaults__select select").selectOption("vault-phy");
          await expect
            .poll(() => author.locator("[name=content]").inputValue())
            .toBe(personalSource);
          expect(await personalReader.count()).toBe(0);
          expect(await page.locator("openclaw-modal-dialog").count()).toBe(1);
          await author
            .locator("[name=content]")
            .fill("# Explicit shared copy\nReviewed independently.");
          await author.locator("[data-vault-editor] button.primary").click();
          await screenshot(page, "personal-to-shared-review-ko-desktop.png", author);
          await author.getByRole("button", { name: "공유 사본 게시", exact: true }).click();
          await expect
            .poll(async () => (await gateway.getRequests(`${rpc}publish`)).at(-1)?.params)
            .toEqual({
              targetVaultId: "vault-phy",
              lookup: "concepts/personal-training.md",
              title: "Personal training notes",
              content: "# Explicit shared copy\nReviewed independently.",
              expectedRevision: createHash("sha256").update(personalSource).digest("hex"),
            });
          await page.getByRole("button", { name: "공유 사본 열기", exact: true }).click();
          await expect.poll(() => panel.locator("[data-vault-document]").count()).toBe(1);
          await page.keyboard.press("Escape");
          for (const [tab, pathname] of [
            ["memory", "memories"],
            ["wiki", "wiki"],
            ["organization", "organization"],
            ["dreaming", "dreams"],
          ]) {
            await memoryTabs.locator(`#platformclaw-memory-tab-${tab}`).click();
            await waitForControlUiRoute(page, {
              routeId: "memory",
              pathname: `/platformclaw/app/settings/memory/${pathname}`,
            });
            expect(await memoryTabs.locator("wa-tab").count()).toBe(5);
            await screenshot(page, `existing-${tab}-ko-desktop.png`, memoryTabs);
          }
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      } catch (error) {
        await screenshot(page, `${caseName}-failure.png`);
        throw error;
      } finally {
        await context.close();
      }
    },
  );
});
