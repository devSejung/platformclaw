import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  wikiHubMethods,
  wikiHubResponses,
  wikiHubSnapshot,
  wikiHubPersonalId,
  wikiHubPersonalDocument,
  wikiHubSharedDocument,
} from "../test-helpers/platformclaw-wiki-hub-fixture.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "shared-vault");
const rpc = "platformclaw.vault.";
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
    "unifies Personal and Shared navigation, permissions and drafts: $name",
    async ({ owner, locale, width, name }) => {
      const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
        locale,
        mode: "light",
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      try {
        await installPlatformClawMemoryDocument(page, server.baseUrl);
        const snapshots = (enabled = true, pending = false, accessGranted = false) => ({
          cases: [
            {
              match: { vaultId: wikiHubPersonalId },
              response: wikiHubSnapshot({
                owner,
                selectedId: wikiHubPersonalId,
                enabled,
                pending,
                accessGranted,
              }),
            },
            {
              match: { vaultId: "vault-phy" },
              response: wikiHubSnapshot({
                owner,
                selectedId: "vault-phy",
                enabled,
                pending,
                accessGranted,
              }),
            },
            { match: {}, response: wikiHubSnapshot({ owner, enabled, pending, accessGranted }) },
          ],
        });
        const gateway = await installMockGateway(page, {
          basePath: "/platformclaw/app",
          defaultAgentId: platformClawMemoryAgentId,
          featureMethods: [...platformClawMemoryMethods, ...wikiHubMethods],
          methodResponses: {
            ...platformClawMemoryResponses,
            ...wikiHubResponses,
            [`${rpc}snapshot`]: snapshots(),
            [`${rpc}connection.set`]: wikiHubSnapshot({ owner, enabled: false }),
            "wiki.document.get": {
              path: wikiHubPersonalDocument.logicalPath,
              title: wikiHubPersonalDocument.title,
              displayContent: wikiHubPersonalDocument.content,
              sourceContent: wikiHubPersonalDocument.sourceContent,
            },
            [`${rpc}document.preview`]: { title: "Reviewed title", logicalPath: "reviewed.md" },
            [`${rpc}document.save`]: wikiHubSharedDocument,
          },
        });
        await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/organization`);
        const hub = page.locator("platformclaw-memory-vaults");
        const tabs = page.locator(".platformclaw-memory-page__tabs");
        await expect.poll(() => hub.locator("[data-vault-card]").count()).toBe(3);
        expect((await tabs.getByRole("tab").allTextContents()).map((text) => text.trim())).toEqual([
          "Memory",
          "Wiki Hub",
          "Dreaming",
        ]);
        const phy = hub.locator('[data-vault-card="vault-phy"]');
        expect(await phy.locator("[data-vault-role]").count()).toBe(1);
        const ai = phy.locator("wa-switch");
        await ai.click();
        await expect
          .poll(async () => (await gateway.getRequests(`${rpc}connection.set`)).at(-1)?.params)
          .toEqual({ vaultId: "vault-phy", connected: false });
        expect(await phy.count()).toBe(1);
        await gateway.setMethodResponse(`${rpc}snapshot`, snapshots(false));
        await page.reload();
        await expect.poll(() => hub.locator("[data-vault-card]").count()).toBe(3);
        expect(
          await ai.evaluate((node) => (node as HTMLElement & { checked: boolean }).checked),
        ).toBe(false);
        await screenshot(page, `${name}-my-vaults.png`, tabs);
        await hub.locator("#vault-catalog-tab-discover").click();
        const lpddr = hub.locator('[data-vault-card="vault-lpddr"]');
        expect(await lpddr.locator("wa-switch").count()).toBe(0);
        expect(await lpddr.locator("[data-vault-role]").count()).toBe(0);
        await lpddr.getByRole("button").click();
        const requestForm = hub.locator("openclaw-modal-dialog form");
        await requestForm.locator("select").selectOption("editor");
        await requestForm.locator("textarea").fill("Working on training");
        await gateway.setMethodResponse(`${rpc}snapshot`, snapshots(false, true));
        await requestForm.locator("button.primary").click();
        await expect
          .poll(async () => (await gateway.getRequests(`${rpc}access.request`)).at(-1)?.params)
          .toEqual({ vaultId: "vault-lpddr", role: "editor", reason: "Working on training" });
        await expect.poll(() => lpddr.getByRole("button").isDisabled()).toBe(true);
        await screenshot(page, `${name}-access-request.png`, lpddr);
        await hub.locator("#vault-catalog-tab-requests").click();
        expect(await hub.textContent()).toContain("LPDDR Training");
        if (owner) {
          await hub.getByRole("button", { name: "승인", exact: true }).click();
          await gateway.waitForRequest(`${rpc}access.decide`);
        }
        await gateway.setMethodResponse(`${rpc}snapshot`, snapshots(false, false, true));
        await page.reload();
        await expect.poll(() => hub.locator("[data-vault-card]").count()).toBe(4);
        expect(
          await hub
            .locator('[data-vault-card="vault-lpddr"] wa-switch')
            .evaluate((node) => (node as HTMLElement & { checked: boolean }).checked),
        ).toBe(true);
        await hub.locator(`[data-vault-card="${wikiHubPersonalId}"] .vaults__card-title`).click();
        await expect.poll(() => hub.locator(".wiki-hub__document-card").count()).toBe(2);
        expect(await hub.textContent()).not.toContain("Should each canary");
        await hub.getByRole("button", { name: wikiHubPersonalDocument.title, exact: true }).click();
        const reader = hub.locator("platformclaw-vault-reader");
        await expect.poll(() => reader.locator("[data-vault-document]").count()).toBe(1);
        const personalClasses = await reader
          .locator("[data-knowledge-document]")
          .getAttribute("class");
        const actionBounds = await reader
          .locator(".wiki-document__actions button")
          .evaluateAll((buttons) =>
            buttons.map((button) => {
              const rect = button.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
            }),
          );
        expect(
          actionBounds.every(
            (rect) => rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= 900,
          ),
        ).toBe(true);
        await screenshot(page, `${name}-personal-reader.png`, reader);
        await reader
          .getByRole("button", { name: owner ? "문서 편집" : "Edit document", exact: true })
          .click();
        const author = reader.locator("platformclaw-vault-author");
        expect(await author.locator("[name=content]").inputValue()).toBe(
          wikiHubPersonalDocument.editableContent,
        );
        expect(await author.locator("[name=path]").count()).toBe(0);
        await author.locator("[name=content]").fill("# Unsaved personal draft");
        await page.keyboard.press("Escape");
        await author
          .getByRole("button", { name: owner ? "계속 편집" : "Keep editing", exact: true })
          .click();
        expect(await author.locator("[name=content]").inputValue()).toBe(
          "# Unsaved personal draft",
        );
        await page.keyboard.press("Escape");
        await author
          .getByRole("button", { name: owner ? "변경 버리기" : "Discard changes", exact: true })
          .click();
        await page.keyboard.press("Escape");
        await hub.locator("#vault-documents-tab-graph").click();
        await expect.poll(() => hub.locator("[data-svg-graph-node]").count()).toBe(2);
        await screenshot(page, `${name}-personal-graph.png`, hub.locator(".vault-graph"));
        await hub.locator(".vaults__back").click();
        await phy.locator(".vaults__card-title").click();
        await expect.poll(() => hub.locator(".wiki-hub__document-card").count()).toBe(2);
        await hub.getByRole("button", { name: wikiHubSharedDocument.title, exact: true }).click();
        await expect.poll(() => reader.locator("[data-vault-document]").count()).toBe(1);
        expect(await reader.locator("[data-knowledge-document]").getAttribute("class")).toBe(
          personalClasses,
        );
        expect(
          await reader
            .getByRole("button", {
              name: owner ? "Markdown 다운로드" : "Download Markdown",
              exact: true,
            })
            .count(),
        ).toBe(1);
        await screenshot(page, `${name}-shared-reader.png`, reader);
        const bounds = await reader.locator("[data-knowledge-document]").boundingBox();
        expect(bounds!.width).toBeLessThanOrEqual(width);
        expect(bounds!.height).toBeLessThanOrEqual(900);
        await page.keyboard.press("Escape");
        if (owner) {
          await hub.locator("details.vaults__management > summary").click();
          await hub.getByRole("button", { name: "멤버 · 권한", exact: true }).click();
          const access = hub.locator("platformclaw-vault-access");
          await access.locator("select").first().selectOption("organization");
          await access.locator("input[name=query]").fill("PHY");
          await access
            .locator("form")
            .evaluate((form) => (form as HTMLFormElement).requestSubmit());
          await access.getByRole("button", { name: "선택한 역할 부여", exact: true }).click();
          await gateway.waitForRequest(`${rpc}grant.set`);
          await expect
            .poll(() => hub.getByRole("button", { name: "대화상자 닫기", exact: true }).isEnabled())
            .toBe(true);
          await screenshot(page, "owner-organization-grant.png", access);
          await page.keyboard.press("Escape");
          await expect.poll(() => access.count()).toBe(0);
          await hub.getByRole("button", { name: "지식 추가", exact: true }).click();
          const draft = hub.locator("platformclaw-vault-author");
          await draft.locator("[name=title]").fill("Draft title");
          await draft.locator("[name=content]").fill("# Unsaved content");
          await draft.locator("#vault-author-source-tab-upload").click();
          await draft.getByRole("button", { name: "계속 편집", exact: true }).click();
          expect(await draft.locator("[name=content]").inputValue()).toBe("# Unsaved content");
          await draft.locator("#vault-author-source-tab-upload").click();
          await draft.getByRole("button", { name: "변경 버리기", exact: true }).click();
          const raw = "\uFEFF---\r\ntitle: Original\r\n---\r\n# Original\r\n  Keep spaces.  \r\n";
          await draft.locator("input[type=file]").setInputFiles({
            name: "source.markdown",
            mimeType: "text/markdown",
            buffer: Buffer.from(raw),
          });
          await expect
            .poll(() => draft.locator("[name=title]").inputValue())
            .toBe("Reviewed title");
          await draft.locator("[data-vault-editor] button.primary").click();
          await expect
            .poll(async () => (await gateway.getRequests(`${rpc}document.save`)).at(-1)?.params)
            .toEqual({
              vaultId: "vault-phy",
              title: "Reviewed title",
              filename: "source.markdown",
              content: raw,
            });
          await reader.getByRole("button", { name: "문서 닫기", exact: true }).click();
          await expect.poll(() => reader.count()).toBe(0);
        }
        await tabs.locator("#platformclaw-memory-tab-memory").click();
        const search = page.locator("#memory-search-input");
        await search.fill("release");
        await search.press("Enter");
        await page.locator('[data-memory-source="wiki"] > button.settings-row').click();
        await expect
          .poll(() => page.locator("platformclaw-vault-reader [data-vault-document]").count())
          .toBe(1);
        await page.keyboard.press("Escape");
        expect(await search.inputValue()).toBe("release");
        await page.locator('[data-memory-source="memory"] > button.settings-row').first().click();
        await expect.poll(() => page.locator("[data-knowledge-document]").count()).toBe(1);
        await page.keyboard.press("Escape");
        expect(await search.inputValue()).toBe("release");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      } catch (error) {
        await screenshot(page, `${name}-failure.png`);
        throw error;
      } finally {
        await context.close();
      }
    },
  );
  it.each(["personal", "shared"] as const)(
    "inserts current-Wiki links and opens the saved target: %s",
    async (type) => {
      const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
        locale: "en-US",
        mode: "light",
        viewport: { width: type === "personal" ? 390 : 1440, height: 900 },
      });
      const page = await context.newPage();
      try {
        await installPlatformClawMemoryDocument(page, server.baseUrl);
        const vaultId = type === "personal" ? wikiHubPersonalId : "vault-phy";
        const target = {
          ...(type === "personal" ? wikiHubPersonalDocument : wikiHubSharedDocument),
          id: "target",
          logicalPath: "guides/Setup #%.md",
          title: "Setup guide",
          content: "# Setup guide\nTarget body",
          links: [],
        };
        const link = `[[${type === "personal" ? "/" : ""}guides/Setup%20%23%25.md|Setup guide]]`;
        const saved = {
          ...target,
          id: "source",
          logicalPath: "sources/new.md",
          title: "Linked draft",
          content: "Before " + link + " after",
          links: [
            {
              target: `${type === "personal" ? "/" : ""}${target.logicalPath}`,
              documentId: target.id,
              logicalPath: target.logicalPath,
              title: target.title,
            },
          ],
        };
        const gateway = await installMockGateway(page, {
          basePath: "/platformclaw/app",
          defaultAgentId: platformClawMemoryAgentId,
          featureMethods: [...platformClawMemoryMethods, ...wikiHubMethods],
          methodResponses: {
            ...platformClawMemoryResponses,
            ...wikiHubResponses,
            [rpc + "document.targets"]: {
              items: [
                {
                  documentId: target.id,
                  title: target.title,
                  logicalPath: target.logicalPath,
                  link,
                },
              ],
              hasMore: false,
            },
            [rpc + "document.preview"]: { title: saved.title, logicalPath: saved.logicalPath },
            [rpc + "document.save"]: saved,
            [rpc + "document.get"]: target,
          },
        });
        await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/vaults`);
        const hub = page.locator("platformclaw-memory-vaults");
        await hub.locator(`[data-vault-card="${vaultId}"] .vaults__card-title`).click();
        const cards = hub.locator(".wiki-hub__document-card");
        await expect.poll(() => cards.count()).toBe(2);
        expect(await cards.first().textContent()).toContain(
          type === "personal" ? wikiHubPersonalDocument.snippet! : wikiHubSharedDocument.snippet!,
        );
        await screenshot(page, `${type}-body-snippets.png`, cards.first());
        await hub.getByRole("button", { name: "Add knowledge", exact: true }).click();
        const author = hub.locator("platformclaw-vault-author");
        const body = author.locator('textarea[name="content"]');
        await body.fill("Before replace after");
        await body.evaluate((node) => (node as HTMLTextAreaElement).setSelectionRange(7, 14));
        await gateway.deferNext(rpc + "document.targets");
        await author.getByRole("button", { name: "Document link", exact: true }).click();
        const picker = author.locator("platformclaw-vault-link-picker");
        await gateway.waitForRequest(rpc + "document.targets");
        await picker.getByRole("searchbox").fill("Setup");
        await picker.getByRole("searchbox").press("Enter");
        await expect
          .poll(async () => (await gateway.getRequests(rpc + "document.targets")).at(-1)?.params)
          .toEqual({ vaultId, query: "Setup" });
        await picker.getByRole("button", { name: /Setup guide/ }).waitFor();
        await gateway.resolveDeferred(rpc + "document.targets", { items: [], hasMore: false });
        await expect
          .poll(() => picker.getByRole("button", { name: /Setup guide/ }).count())
          .toBe(1);
        await screenshot(page, `${type}-link-picker.png`, picker);
        await picker.getByRole("button", { name: /Setup guide/ }).click();
        expect(await body.inputValue()).toBe(saved.content);
        expect(await body.evaluate((node) => document.activeElement === node)).toBe(true);
        expect(await body.evaluate((node) => (node as HTMLTextAreaElement).selectionStart)).toBe(
          7 + link.length,
        );
        await author.locator('input[name="title"]').fill(saved.title);
        await author.locator("[data-vault-editor] > .vaults__actions button.primary").click();
        await author.getByRole("button", { name: "Save document", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests(rpc + "document.save")).at(-1)?.params)
          .toMatchObject({ vaultId, title: saved.title, content: saved.content });
        const reader = hub.locator("platformclaw-vault-reader");
        await reader
          .locator("article")
          .getByRole("link", { name: "Setup guide", exact: true })
          .click();
        await expect
          .poll(async () => (await gateway.getRequests(rpc + "document.get")).at(-1)?.params)
          .toEqual({ vaultId, documentId: target.id });
        await expect.poll(() => reader.textContent()).toContain("Target body");
        await screenshot(page, `${type}-linked-reader.png`, reader);
      } finally {
        await context.close();
      }
    },
  );

  it("preserves a general Memory editor through reconnect and refreshes saved/deleted hits in place", async () => {
    const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
      locale: "en-US",
      mode: "light",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installPlatformClawMemoryDocument(page, server.baseUrl);
      const doc = wikiHubSharedDocument;
      const updated = {
        ...doc,
        title: "Training revised",
        content: "Revised training body",
        revision: 4,
      };
      const search = (deleted = false, revised = false) => ({
        agentId: platformClawMemoryAgentId,
        provider: "vault",
        searchMode: "fts-only",
        results: deleted
          ? []
          : [
              {
                path: doc.logicalPath,
                documentId: doc.id,
                vaultId: doc.vaultId,
                vaultName: "Ulysses PHY Spec",
                vaultType: "shared",
                source: "shared",
                title: revised ? updated.title : doc.title,
                snippet: revised ? updated.content : doc.content,
                revision: revised ? updated.revision : doc.revision,
                score: 1,
                startLine: 1,
                endLine: 3,
              },
            ],
      });
      const gateway = await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: platformClawMemoryAgentId,
        featureMethods: [...platformClawMemoryMethods, ...wikiHubMethods],
        methodResponses: {
          ...platformClawMemoryResponses,
          ...wikiHubResponses,
          "memory.search": search(),
          [rpc + "document.get"]: doc,
          [rpc + "document.preview"]: { title: updated.title, logicalPath: doc.logicalPath },
          [rpc + "document.save"]: updated,
          [rpc + "document.delete"]: {},
        },
      });
      await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/memories`);
      const input = page.locator("#memory-search-input");
      await input.fill("training");
      await input.press("Enter");
      await page.locator('[data-memory-source="shared"] > button.settings-row').click();
      const reader = page.locator("platformclaw-vault-reader");
      await reader.getByRole("button", { name: "Edit document", exact: true }).click();
      const author = reader.locator("platformclaw-vault-author");
      await author.locator('[name="title"]').fill(updated.title);
      await author.locator('[name="content"]').fill(updated.content);
      await gateway.setOnline(false);
      await gateway.closeLatest(1001, "draft transport proof");
      const primary = author.locator("[data-vault-editor] > .vaults__actions button.primary");
      await expect.poll(() => primary.isDisabled()).toBe(true);
      expect(await author.locator('[name="title"]').inputValue()).toBe(updated.title);
      expect(await author.locator('[name="content"]').inputValue()).toBe(updated.content);
      await screenshot(page, "general-memory-draft-offline.png", author);
      await gateway.setOnline(true);
      await expect.poll(() => primary.isEnabled(), { timeout: 10_000 }).toBe(true);
      expect(await author.locator('[name="title"]').inputValue()).toBe(updated.title);
      expect(await author.locator('[name="content"]').inputValue()).toBe(updated.content);
      await gateway.setMethodResponse("memory.search", search(false, true));
      await primary.click();
      await author.getByRole("button", { name: "Save document", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests(rpc + "document.save")).at(-1)?.params)
        .toMatchObject({
          expectedRevision: doc.revision,
          title: updated.title,
          content: updated.content,
        });
      await reader.locator("[data-vault-document]").waitFor();
      const hit = page.locator('[data-memory-source="shared"] > button.settings-row');
      await expect.poll(() => hit.textContent()).toContain(updated.title);
      expect(await input.inputValue()).toBe("training");
      await gateway.setMethodResponse("memory.search", search(true));
      await reader.getByRole("button", { name: "Delete document", exact: true }).click();
      await reader.locator(".vaults__actions .danger").click();
      await expect.poll(() => reader.count()).toBe(0);
      await expect.poll(() => hit.count()).toBe(0);
      expect(await input.inputValue()).toBe("training");
      expect(new URL(page.url()).pathname).toContain("/memory/memories");
      await screenshot(
        page,
        "general-memory-deleted-search.png",
        page.locator("openclaw-memory-memories"),
      );
    } finally {
      await context.close();
    }
  });

  it("Escape closes a pending document read and its delayed response cannot reopen it", async () => {
    const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
      locale: "en-US",
      mode: "light",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await installPlatformClawMemoryDocument(page, server.baseUrl);
      const gateway = await installMockGateway(page, {
        basePath: "/platformclaw/app",
        defaultAgentId: platformClawMemoryAgentId,
        featureMethods: [...platformClawMemoryMethods, ...wikiHubMethods],
        methodResponses: { ...platformClawMemoryResponses, ...wikiHubResponses },
      });
      await page.goto(`${server.baseUrl}platformclaw/app/settings/memory/vaults`);
      const hub = page.locator("platformclaw-memory-vaults");
      await hub.locator('[data-vault-card="vault-phy"] .vaults__card-title').click();
      await gateway.deferNext(rpc + "document.get");
      const card = hub.getByRole("button", { name: wikiHubSharedDocument.title, exact: true });
      await card.click();
      await gateway.waitForRequest(rpc + "document.get");
      const reader = hub.locator("platformclaw-vault-reader");
      await reader.getByRole("status").waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await expect.poll(() => reader.count()).toBe(0);
      await gateway.resolveDeferred(rpc + "document.get", wikiHubSharedDocument);
      await expect.poll(() => hub.locator("[data-vault-document]").count()).toBe(0);
      expect(await card.evaluate((node) => document.activeElement === node)).toBe(true);
      await card.click();
      await expect.poll(() => reader.locator("[data-vault-document]").count()).toBe(1);
    } finally {
      await context.close();
    }
  });
});
