import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentPublishInput,
  KnowledgeVaultDocumentPublishResult,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createPlatformClawMemoryContext,
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
  platformClawMemoryMethods,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";
import {
  wikiHubPersonalDocument,
  wikiHubPersonalId,
  wikiHubSnapshot,
} from "../test-helpers/platformclaw-wiki-hub-fixture.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" || process.env.CI === "true";
const captureVideo = process.env.OPENCLAW_CAPTURE_UI_VIDEO === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "wiki-document-bulk");
const RPC = "platformclaw.vault.";
const GET = `${RPC}document.get`;
const PUBLISH = `${RPC}document.publish`;
const DELETE = `${RPC}document.delete`;
const targetVaultId = "vault-phy";
const viewports = [
  { locale: "ko-KR", width: 1920, height: 1080, name: "ko-fhd" },
  { locale: "en-US", width: 390, height: 844, name: "en-mobile" },
] as const;
type Viewport = (typeof viewports)[number];
type PublishRequest = Omit<KnowledgeVaultDocumentPublishInput, "userId">;
type Scenario = { page: Page; hub: Locator; actions: Locator; gateway: MockGatewayControls };
let browser: Browser;
let server: ControlUiE2eServer;

function sourceDocument(id: string, title: string, body: string, canDelete = true) {
  const sourceContent = `---\ntitle: ${title}\n---\n# ${title}\n\n${body}\n`;
  const revision = createHash("sha256").update(sourceContent).digest("hex");
  return {
    ...wikiHubPersonalDocument,
    id,
    logicalPath: id,
    title,
    content: `# ${title}\n\n${body}`,
    sourceContent,
    editableContent: "Only the editable note, not the full publication source.",
    revision,
    canDelete,
    links: [],
    backlinks: [],
    compile: { ...wikiHubPersonalDocument.compile, indexedRevision: revision },
  } satisfies KnowledgeVaultDocument;
}

const documents = [
  sourceDocument(
    "concepts/launch-checklist.md",
    "Reviewed launch checklist",
    "Keep the complete original. See [[generated-summary]].",
  ),
  sourceDocument("concepts/service-ownership.md", "Reviewed service ownership", "Name one owner."),
  sourceDocument(
    "sources/generated-summary.md",
    "Generated summary",
    "Unselected linked page.",
    false,
  ),
];

function snapshots(remaining = documents) {
  const catalog = wikiHubSnapshot();
  const selected = wikiHubSnapshot({ selectedId: wikiHubPersonalId });
  // Catalog excerpts and revisions are deliberately stale. Confirmation must use document.get.
  selected.selected!.documents = remaining.map((document) => ({
    ...document,
    title: document.title.replace("Reviewed ", "Catalog "),
    revision: "0".repeat(64),
    content: "Catalog excerpt only.",
    sourceContent: undefined,
  }));
  selected.selected!.documentsTruncated = true;
  selected.selected!.documentCount = 3000;
  selected.selected!.graph = { edges: [], unresolvedLinks: 0, truncated: false };
  return {
    cases: [
      { match: { vaultId: wikiHubPersonalId }, response: selected },
      { match: {}, response: catalog },
    ],
  };
}

function reads(current = documents) {
  return {
    cases: current.map((document) => ({
      match: { vaultId: wikiHubPersonalId, documentId: document.id },
      response: document,
    })),
  };
}

async function screenshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (capture) {
    await page.screenshot({ path: path.join(proofDir, `${name}.png`), animations: "disabled" });
  }
}

async function assertNoWholeVaultMutations(gateway: MockGatewayControls) {
  const requests = await gateway.getRequests();
  expect(
    requests.filter(({ method }) =>
      [
        "create",
        "delete",
        "rename",
        "publish",
        "connection.set",
        "document.save",
        "document.import",
      ]
        .map((name) => `${RPC}${name}`)
        .includes(method),
    ),
  ).toEqual([]);
}

async function runScenario(
  viewport: Viewport,
  purpose: string,
  run: (scenario: Scenario) => Promise<void>,
) {
  const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
    locale: viewport.locale,
    mode: "light",
    viewport: { width: viewport.width, height: viewport.height },
    ...(captureVideo
      ? { recordVideo: { dir: proofDir, size: { width: viewport.width, height: viewport.height } } }
      : {}),
  });
  const page = await context.newPage();
  try {
    await installPlatformClawMemoryDocument(page, server.baseUrl);
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: platformClawMemoryAgentId,
      featureMethods: [...platformClawMemoryMethods, PUBLISH],
      methodResponses: {
        ...platformClawMemoryResponses,
        [`${RPC}snapshot`]: snapshots(),
        [GET]: reads(),
        // Every mutation in this proof must be explicitly deferred and inspected first.
        [PUBLISH]: { __mockError: { code: "INVALID_REQUEST", message: "Unexpected publication" } },
        [DELETE]: { __mockError: { code: "INVALID_REQUEST", message: "Unexpected deletion" } },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/vaults`);
    const hub = page.locator("platformclaw-memory-vaults");
    await hub.locator(`[data-vault-card="${wikiHubPersonalId}"] .vaults__card-title`).waitFor();
    expect(await hub.locator("[data-document-select]").count()).toBe(0);
    await hub.locator(`[data-vault-card="${wikiHubPersonalId}"] .vaults__card-title`).click();
    const actions = hub.locator("platformclaw-vault-document-actions");
    await expect.poll(() => actions.locator("[data-document-select]").count()).toBe(3);
    await run({ page, hub, actions, gateway });
    await assertNoWholeVaultMutations(gateway);
  } catch (error) {
    if (capture) {
      await page.screenshot({
        path: path.join(proofDir, `${viewport.name}-${purpose}-failure.png`),
      });
    }
    throw error;
  } finally {
    const video = page.video();
    await context.close();
    if (video) {
      await video.saveAs(path.join(proofDir, `${viewport.name}-${purpose}.webm`));
      await video.delete();
    }
  }
}

function publicationResult(
  request: PublishRequest,
  outcome: (documentId: string) => "published" | "unchanged" | "failed",
): KnowledgeVaultDocumentPublishResult {
  return {
    publishId: request.publishId,
    targetVaultId: request.targetVaultId,
    rootPath: `imports/${request.publishId}`,
    documents: request.documents.map(({ documentId }) => {
      const status = outcome(documentId);
      return status === "failed"
        ? { sourceDocumentId: documentId, status, error: "unavailable" }
        : {
            sourceDocumentId: documentId,
            status,
            documentId: `copy-${documentId}`,
            logicalPath: `imports/${request.publishId}/${documentId}`,
            revision: 1,
            compile: {
              status: "ready",
              indexedRevision: 1,
              attempts: 0,
              error: null,
              retryAt: null,
            },
          };
    }),
  };
}

suite("Wiki document selection through the built Control UI", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error("Playwright Chromium is required for Wiki document bulk-action proof.");
    }
    if (capture || captureVideo) {
      await mkdir(proofDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(viewports)(
    "publishes reviewed copies and safely retries partial results: $name",
    async (viewport) => {
      const ko = viewport.locale === "ko-KR";
      await runScenario(viewport, "publish", async ({ page, hub, actions, gateway }) => {
        const selection = actions.locator("[data-document-selection]");
        await screenshot(page, `${viewport.name}-before-selection`);
        for (const document of documents.slice(0, 2)) {
          await actions.locator(`[data-document-select="${document.id}"]`).check();
        }
        expect(await selection.textContent()).toContain(
          ko ? "불러온 문서 3개 중 2개 선택" : "Selected 2 of 3 loaded documents",
        );
        expect(await actions.locator("[data-vault-documents-truncated]").textContent()).toContain(
          "3000",
        );
        expect(await page.locator("platformclaw-vault-reader").count()).toBe(0);
        expect(await gateway.getRequests(GET)).toEqual([]);
        await screenshot(page, `${viewport.name}-selected-documents`);
        await selection
          .getByRole("button", {
            name: ko ? "선택한 문서를 공유 볼트에 게시" : "Publish selected to Shared vault",
            exact: true,
          })
          .click();
        const dialog = hub.locator("platformclaw-vault-document-bulk-publish");
        // The native top-layer dialog has geometry; its light-DOM owner does not.
        const modal = dialog.getByRole("dialog");
        await expect.poll(() => dialog.locator("[data-publish-status=ready]").count()).toBe(2);
        const destination = dialog.locator("[data-publish-destination]");
        const reviewed = dialog.locator("[data-publish-reviewed]");
        const submit = dialog.locator("[data-publish-submit]");
        expect(await destination.inputValue()).toBe("");
        expect(await reviewed.isDisabled()).toBe(true);
        expect(await submit.isDisabled()).toBe(true);
        expect(
          await destination
            .locator("option")
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
        ).toEqual(["", targetVaultId, "vault-dram"]);
        for (const document of documents.slice(0, 2)) {
          await dialog.getByRole("button", { name: document.title, exact: true }).click();
          expect(await dialog.locator("pre.vaults__source").textContent()).toBe(
            document.sourceContent,
          );
          expect(await dialog.locator(".vaults__batch-preview").textContent()).toContain(
            document.revision,
          );
        }
        expect((await gateway.getRequests(GET)).map(({ params }) => params)).toEqual(
          documents.slice(0, 2).map(({ id }) => ({ vaultId: wikiHubPersonalId, documentId: id })),
        );
        await destination.selectOption(targetVaultId);
        expect(await submit.isDisabled()).toBe(true);
        await reviewed.check();
        await expect.poll(() => submit.isEnabled()).toBe(true);
        expect(await gateway.getRequests(PUBLISH)).toEqual([]);
        expect(await gateway.getRequests(DELETE)).toEqual([]);
        expect(
          await dialog
            .locator(".vaults__batch-preview > .vaults__hint")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await screenshot(page, `${viewport.name}-source-review`);

        await gateway.deferNext(PUBLISH);
        await submit.click();
        await expect.poll(async () => (await gateway.getRequests(PUBLISH)).length).toBe(1);
        const first = (await gateway.getRequests(PUBLISH))[0]!.params as PublishRequest;
        expect(first).toEqual({
          vaultId: wikiHubPersonalId,
          targetVaultId,
          publishId: expect.stringMatching(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u),
          documents: documents.slice(0, 2).map(({ id, revision }) => ({
            documentId: id,
            expectedRevision: revision,
          })),
        });
        const appUrl = page.url();
        expect(await modal.isVisible()).toBe(true);
        expect(await modal.getAttribute("open")).not.toBeNull();
        await page.keyboard.press("Escape");
        expect(await modal.isVisible()).toBe(true);
        expect(await modal.getAttribute("open")).not.toBeNull();
        expect(page.url()).toBe(appUrl);
        expect(await submit.isDisabled()).toBe(true);
        expect(await destination.isDisabled()).toBe(true);
        await dialog
          .getByRole("button", {
            name: ko ? "현재 묶음 처리 후 중지" : "Cancel after current batch",
            exact: true,
          })
          .click();
        expect(await modal.isVisible()).toBe(true);
        await gateway.resolveDeferred(
          PUBLISH,
          publicationResult(first, (id) => (id === documents[0]!.id ? "published" : "failed")),
        );
        await expect.poll(() => dialog.locator("[data-publish-status=published]").count()).toBe(1);
        await expect.poll(() => dialog.locator("[data-publish-status=failed]").count()).toBe(1);
        await screenshot(page, `${viewport.name}-publish-partial`);
        await dialog
          .locator(".vaults__actions")
          .getByRole("button", { name: ko ? "대화상자 닫기" : "Close dialog", exact: true })
          .click();
        const keepEditing = dialog.getByRole("button", {
          name: ko ? "계속 편집" : "Keep editing",
          exact: true,
        });
        await keepEditing.waitFor();
        expect(await gateway.getRequests(PUBLISH)).toHaveLength(1);
        await keepEditing.click();
        expect(await destination.inputValue()).toBe(targetVaultId);
        expect(await destination.isDisabled()).toBe(true);

        const readsBeforeRetry = await gateway.getRequests(GET);
        await gateway.deferNext(PUBLISH);
        await submit.click();
        await expect.poll(async () => (await gateway.getRequests(PUBLISH)).length).toBe(2);
        const retry = (await gateway.getRequests(PUBLISH))[1]!.params as PublishRequest;
        expect(retry).toEqual({ ...first, documents: [first.documents[1]] });
        expect(await gateway.getRequests(GET)).toEqual(readsBeforeRetry);
        await gateway.resolveDeferred(
          PUBLISH,
          publicationResult(retry, () => "unchanged"),
        );
        await expect.poll(() => dialog.locator("[data-publish-status=unchanged]").count()).toBe(1);
        expect(await dialog.locator("[data-publish-status=published]").count()).toBe(1);
        expect(await submit.isDisabled()).toBe(true);
        expect(await destination.inputValue()).toBe(targetVaultId);
        await screenshot(page, `${viewport.name}-publish-retried`);
        await dialog
          .locator(".vaults__actions")
          .getByRole("button", { name: ko ? "대화상자 닫기" : "Close dialog", exact: true })
          .click();
        await expect.poll(() => dialog.count()).toBe(0);
        expect(await actions.locator("[data-document-select]").count()).toBe(3);
        expect(await gateway.getRequests(DELETE)).toEqual([]);
        await actions
          .getByRole("button", { name: "Catalog launch checklist", exact: true })
          .click();
        const reader = page.locator("platformclaw-vault-reader");
        await reader.locator(".wiki-document__reader").waitFor();
        expect(await reader.locator(".wiki-document__reader").textContent()).toContain(
          "Keep the complete original.",
        );
        await screenshot(page, `${viewport.name}-personal-original-preserved`);
      });
    },
  );

  it.each(viewports)(
    "pins deletion to fresh review and stops safely while a request is pending: $name",
    async (viewport) => {
      const ko = viewport.locale === "ko-KR";
      await runScenario(viewport, "delete", async ({ page, hub, actions, gateway }) => {
        const selection = actions.locator("[data-document-selection]");
        await selection
          .getByRole("button", {
            name: ko ? "불러온 문서 선택" : "Select loaded documents",
            exact: true,
          })
          .click();
        expect(await actions.locator("[data-document-select]:checked").count()).toBe(3);
        const openDelete = selection.getByRole("button", {
          name: ko ? "선택한 문서 삭제" : "Delete selected documents",
          exact: true,
        });
        const dialog = hub.locator("platformclaw-vault-document-bulk-delete");
        const modal = dialog.getByRole("dialog");
        await openDelete.click();
        await expect.poll(() => dialog.locator("[data-delete-status=ready]").count()).toBe(2);
        expect(await dialog.locator("[data-delete-status=excluded]").textContent()).toContain(
          documents[2]!.title,
        );
        for (const document of documents.slice(0, 2)) {
          expect(
            await dialog.locator(`[data-document-delete-result="${document.id}"]`).textContent(),
          ).toContain(document.title);
        }
        const confirm = dialog.getByRole("button", {
          name: ko ? "확인한 문서 2개 삭제" : "Delete 2 reviewed documents",
          exact: true,
        });
        expect(await confirm.isEnabled()).toBe(true);
        expect(await gateway.getRequests(DELETE)).toEqual([]);
        await screenshot(page, `${viewport.name}-delete-confirmation`);
        await dialog.getByRole("button", { name: ko ? "취소" : "Cancel", exact: true }).click();
        await expect.poll(() => dialog.count()).toBe(0);
        expect(await gateway.getRequests(DELETE)).toEqual([]);

        await openDelete.click();
        await expect.poll(() => dialog.locator("[data-delete-status=ready]").count()).toBe(2);
        await gateway.deferNext(DELETE);
        await confirm.click();
        await expect.poll(async () => (await gateway.getRequests(DELETE)).length).toBe(1);
        expect((await gateway.getRequests(DELETE))[0]!.params).toEqual({
          vaultId: wikiHubPersonalId,
          documentId: documents[0]!.id,
          expectedRevision: documents[0]!.revision,
        });
        const appUrl = page.url();
        expect(await modal.isVisible()).toBe(true);
        expect(await modal.getAttribute("open")).not.toBeNull();
        await page.keyboard.press("Escape");
        expect(await modal.isVisible()).toBe(true);
        expect(await modal.getAttribute("open")).not.toBeNull();
        expect(page.url()).toBe(appUrl);
        expect(await dialog.locator(".vaults__heading button").isDisabled()).toBe(true);
        await dialog
          .getByRole("button", {
            name: ko ? "현재 문서 처리 후 중지" : "Stop after current document",
            exact: true,
          })
          .click();
        expect(await modal.isVisible()).toBe(true);
        await gateway.setMethodResponse(`${RPC}snapshot`, snapshots(documents.slice(1)));
        await gateway.resolveDeferred(DELETE, {
          deleted: true,
          documentId: documents[0]!.id,
          indexesRefreshed: false,
        });
        await expect.poll(() => dialog.locator("[data-delete-status=deleted]").count()).toBe(1);
        await expect
          .poll(() => dialog.locator("[data-delete-status=not-attempted]").count())
          .toBe(1);
        expect(await dialog.locator("[data-delete-status=excluded]").count()).toBe(1);
        expect(await gateway.getRequests(DELETE)).toHaveLength(1);
        await screenshot(page, `${viewport.name}-delete-stopped-results`);
        await dialog
          .locator(".vaults__actions")
          .getByRole("button", {
            name: ko ? "대화상자 닫기" : "Close dialog",
            exact: true,
          })
          .click();
        await expect.poll(() => dialog.count()).toBe(0);
        expect(await actions.locator("[data-document-select]").count()).toBe(2);

        const current = sourceDocument(
          documents[1]!.id,
          "Newly reviewed service ownership",
          "A newer source revision.",
        );
        await gateway.setMethodResponse(GET, reads([current, documents[2]!]));
        await openDelete.click();
        await expect.poll(() => dialog.locator("[data-delete-status=ready]").count()).toBe(1);
        expect(await dialog.locator("[data-delete-status=ready]").textContent()).toContain(
          current.title,
        );
        await gateway.deferNext(DELETE);
        await dialog
          .getByRole("button", {
            name: ko ? "확인한 문서 1개 삭제" : "Delete 1 reviewed documents",
            exact: true,
          })
          .click();
        await expect.poll(async () => (await gateway.getRequests(DELETE)).length).toBe(2);
        expect((await gateway.getRequests(DELETE))[1]!.params).toEqual({
          vaultId: wikiHubPersonalId,
          documentId: current.id,
          expectedRevision: current.revision,
        });
        await gateway.rejectDeferred(DELETE, {
          code: "INVALID_REQUEST",
          message: "Personal deletion response could not be verified",
        });
        await expect.poll(() => dialog.locator("[data-delete-status=unconfirmed]").count()).toBe(1);
        expect(await dialog.locator("[data-delete-status=unconfirmed]").textContent()).toContain(
          "Personal deletion response could not be verified",
        );
        expect(await dialog.getByRole("alert").textContent()).toContain(
          ko ? "이미 삭제되었을 수 있습니다" : "may already be deleted",
        );
        expect(await actions.locator("[data-document-select]").count()).toBe(2);
        expect(await gateway.getRequests(DELETE)).toHaveLength(2);
        expect(await gateway.getRequests(PUBLISH)).toEqual([]);
        await screenshot(page, `${viewport.name}-delete-unconfirmed-preserved`);
      });
    },
  );
});
