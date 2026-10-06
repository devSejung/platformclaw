import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  KnowledgeVaultDocument,
  KnowledgeVaultDocumentImportResult,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
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
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "personal-memory-import");
const importMethod = "platformclaw.vault.document.import";
const padding = Array.from(
  { length: 24 },
  (_, index) => `Paragraph ${index + 1}. Keep the authored source.\n\n`,
).join("");
const startSource = `\uFEFF# Start\r\n\r\n[Local section](#local)\r\n[Open target](sub/Target.markdown#details)\r\n[[Target#Details|Open wiki target]]\r\n\r\n${padding.replace(/\n/g, "\r\n")}## Local\r\n\r\n${padding.replace(/\n/g, "\r\n")}`;
const targetSource = `# Target\n\n${padding}## Details\n\n${padding}`;
type ImportRequest = {
  vaultId: string;
  importId: string;
  documents: Array<{ relativePath: string; content: string }>;
};
let browser: Browser;
let server: ControlUiE2eServer;

async function screenshot(page: Page, name: string) {
  if (capture) {
    await page.screenshot({ path: path.join(proofDir, name), animations: "disabled" });
  }
}

suite("Personal Wiki folder import", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error("Playwright Chromium is required for Personal Wiki upload proof.");
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
    { locale: "ko-KR", width: 1920, height: 1080, name: "ko-fhd" },
    { locale: "en-US", width: 390, height: 844, name: "en-mobile" },
  ])(
    "keeps folder links and retries only failed files: $name",
    async ({ locale, width, height, name }) => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "platformclaw-import-e2e-"));
      const folder = path.join(temporary, "Notes");
      await mkdir(path.join(folder, "sub"), { recursive: true });
      await Promise.all([
        writeFile(path.join(folder, "Start.MD"), startSource, "utf8"),
        writeFile(path.join(folder, "sub", "Target.markdown"), targetSource, "utf8"),
        writeFile(path.join(folder, "image.png"), "attachment is explicitly excluded"),
      ]);
      const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
        locale,
        mode: "light",
        viewport: { width, height },
      });
      const page = await context.newPage();
      try {
        await installPlatformClawMemoryDocument(page, server.baseUrl);
        const gateway = await installMockGateway(page, {
          basePath: "/platformclaw/app",
          defaultAgentId: platformClawMemoryAgentId,
          featureMethods: [...platformClawMemoryMethods],
          methodResponses: { ...platformClawMemoryResponses },
        });
        await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/vaults`);
        const hub = page.locator("platformclaw-memory-vaults");
        await hub.locator(`[data-vault-card="${wikiHubPersonalId}"] .vaults__card-title`).click();
        await hub
          .getByRole("button", {
            name: locale === "ko-KR" ? "파일 업로드" : "Upload files",
            exact: true,
          })
          .click();
        const upload = hub.locator("[data-vault-upload]");
        await upload.locator("input[webkitdirectory]").setInputFiles(folder);
        await expect.poll(() => upload.locator("[data-upload-status=ready]").count()).toBe(2);
        expect(await upload.locator("[data-upload-status=excluded]").count()).toBe(1);
        await upload
          .getByRole("button", {
            name: locale === "ko-KR" ? "Start.MD 미리보기" : "Preview Start.MD",
            exact: true,
          })
          .click();
        expect(await upload.locator("pre.vaults__source").textContent()).toBe(startSource);
        await upload.locator(".vaults__batch-preview summary").click();
        await screenshot(page, `${name}-selected.png`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );

        await gateway.deferNext(importMethod);
        await upload.locator("[data-upload-submit]").click();
        await expect.poll(async () => (await gateway.getRequests(importMethod)).length).toBe(1);
        const first = (await gateway.getRequests(importMethod))[0]!.params as ImportRequest;
        expect(first.vaultId).toBe(wikiHubPersonalId);
        expect(first.importId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u);
        expect(first.documents).toHaveLength(2);
        expect(first.documents).toEqual(
          expect.arrayContaining([
            { relativePath: "Start.MD", content: startSource },
            { relativePath: "sub/Target.markdown", content: targetSource },
          ]),
        );
        expect(await upload.locator("[data-upload-submit]").isDisabled()).toBe(true);
        const rootPath = `concepts/imports/${first.importId}`;
        const documentPath = (relativePath: string) =>
          `${rootPath}/${relativePath.replace(/\.(?:md|markdown)$/iu, ".md")}`;
        const outcome = (entry: ImportRequest["documents"][number]) => ({
          relativePath: entry.relativePath,
          path: documentPath(entry.relativePath),
          status: "saved" as const,
          title: entry.relativePath.endsWith("Start.MD") ? "Start" : "Target",
          revision: createHash("sha256").update(entry.content, "utf8").digest("hex"),
        });
        const partial: KnowledgeVaultDocumentImportResult = {
          importId: first.importId,
          rootPath,
          documents: first.documents.map((entry) =>
            entry.relativePath.endsWith("Start.MD")
              ? outcome(entry)
              : {
                  relativePath: entry.relativePath,
                  path: documentPath(entry.relativePath),
                  status: "failed",
                  error: "unavailable",
                },
          ),
          indexesRefreshed: false,
        };
        await gateway.resolveDeferred(importMethod, partial);
        await expect.poll(() => upload.locator("[data-upload-status=saved]").count()).toBe(1);
        await expect.poll(() => upload.locator("[data-upload-status=failed]").count()).toBe(1);
        await expect.poll(() => upload.locator("[data-upload-submit]").isEnabled()).toBe(true);
        await screenshot(page, `${name}-partial.png`);

        await gateway.deferNext(importMethod);
        await upload.locator("[data-upload-submit]").click();
        await expect.poll(async () => (await gateway.getRequests(importMethod)).length).toBe(2);
        const retry = (await gateway.getRequests(importMethod))[1]!.params as ImportRequest;
        expect(retry).toEqual({
          vaultId: wikiHubPersonalId,
          importId: first.importId,
          documents: [{ relativePath: "sub/Target.markdown", content: targetSource }],
        });
        const startPath = documentPath("Start.MD");
        const targetPath = documentPath("sub/Target.markdown");
        const documents: KnowledgeVaultDocument[] = first.documents.map((entry) => ({
          ...wikiHubPersonalDocument,
          id: documentPath(entry.relativePath),
          logicalPath: documentPath(entry.relativePath),
          title: outcome(entry).title,
          snippet: "Imported source with preserved folder relationships.",
          content: entry.content,
          sourceContent: entry.content,
          editableContent: entry.content,
          revision: outcome(entry).revision,
          metadata: { claims: [], questions: [], contradictions: [] },
          links: entry.relativePath.endsWith("Start.MD")
            ? [
                {
                  target: `${rootPath}/sub/Target.markdown`,
                  documentId: targetPath,
                  logicalPath: targetPath,
                  title: "Target",
                },
                {
                  target: "Target",
                  documentId: targetPath,
                  logicalPath: targetPath,
                  title: "Target",
                },
              ]
            : [],
          backlinks: [],
          compile: { ...wikiHubPersonalDocument.compile, indexedRevision: outcome(entry).revision },
        }));
        const snapshot = wikiHubSnapshot({ selectedId: wikiHubPersonalId });
        snapshot.selected!.documents = documents;
        snapshot.selected!.graph = {
          edges: [{ source: startPath, target: targetPath }],
          unresolvedLinks: 0,
          truncated: false,
        };
        snapshot.vaults = snapshot.vaults.map((vault) =>
          vault.id === wikiHubPersonalId ? { ...vault, documentCount: documents.length } : vault,
        );
        await gateway.setMethodResponse("platformclaw.vault.snapshot", snapshot);
        await gateway.setMethodResponse("platformclaw.vault.document.get", {
          cases: documents.map((document) => ({
            match: { vaultId: wikiHubPersonalId, documentId: document.id },
            response: document,
          })),
        });
        await gateway.resolveDeferred(importMethod, {
          importId: first.importId,
          rootPath,
          documents: retry.documents.map(outcome),
          indexesRefreshed: true,
        } satisfies KnowledgeVaultDocumentImportResult);
        await expect.poll(() => upload.locator("[data-upload-status=saved]").count()).toBe(2);
        expect(await upload.locator("[data-upload-status=failed]").count()).toBe(0);
        expect(await upload.locator("[data-upload-status=excluded]").count()).toBe(1);
        await expect.poll(() => upload.locator("[data-upload-submit]").count()).toBe(0);
        await screenshot(page, `${name}-complete.png`);
        await upload
          .getByRole("button", { name: locale === "ko-KR" ? "완료" : "Done", exact: true })
          .click();
        await expect.poll(() => upload.count()).toBe(0);

        await hub.getByRole("button", { name: "Start", exact: true }).click();
        const reader = page.locator("platformclaw-vault-reader");
        const article = reader.locator(".wiki-document__reader");
        await expect.poll(() => article.count()).toBe(1);
        const appUrl = page.url();
        await article.getByRole("link", { name: "Local section", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent))
          .toBe("Local");
        expect(
          await reader.locator(".wiki-hub__preview-body").evaluate((element) => element.scrollTop),
        ).toBeGreaterThan(0);
        expect(page.url()).toBe(appUrl);
        await article.getByRole("link", { name: "Open target", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent))
          .toBe("Details");
        expect(
          await reader.locator(".wiki-hub__preview-body").evaluate((element) => element.scrollTop),
        ).toBeGreaterThan(0);
        expect(page.url()).toBe(appUrl);
        expect(
          (await gateway.getRequests("platformclaw.vault.document.get")).at(-1)?.params,
        ).toEqual({
          vaultId: wikiHubPersonalId,
          documentId: targetPath,
        });
        await screenshot(page, `${name}-linked-heading.png`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } catch (error) {
        await screenshot(page, `${name}-failure.png`);
        throw error;
      } finally {
        await context.close();
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
});
