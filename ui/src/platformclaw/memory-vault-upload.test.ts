/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  KnowledgeVaultDocumentImportInput,
  KnowledgeVaultDocumentImportResult,
  KnowledgeVaultSnapshot,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  wikiHubPersonalDocument,
  wikiHubPersonalId,
  wikiHubSnapshot,
} from "../test-helpers/platformclaw-wiki-hub-fixture.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import type { PlatformClawVaultUpload } from "./memory-vault-upload.ts";
import { button, mount, rpc, setupVaultTests } from "./memory-vaults.test-support.ts";
import "./memory-vault-upload.ts";

setupVaultTests();
type ImportRequest = Omit<KnowledgeVaultDocumentImportInput, "userId">;
const IMPORT = `${rpc}document.import`;

function markdownFile(name: string, content = "# Plain Markdown", relativePath = "") {
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], name, { type: "text/markdown" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer,
    configurable: true,
  });
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}
function chooseFiles(element: Element, files: File[], folder = false) {
  const input = element.querySelector<HTMLInputElement>(
    folder ? "input[webkitdirectory]" : 'input[accept=".md,.markdown,text/markdown"]',
  )!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function saved(params: ImportRequest): KnowledgeVaultDocumentImportResult {
  const rootPath = `concepts/imports/${params.importId}`;
  return {
    importId: params.importId,
    rootPath,
    indexesRefreshed: true,
    documents: params.documents.map(({ relativePath }) => ({
      relativePath,
      path: `${rootPath}/${relativePath.replace(/\.(?:md|markdown)$/iu, ".md")}`,
      status: "saved",
      title: relativePath,
      revision: "a".repeat(64),
    })),
  };
}
async function uploadPane(request: ReturnType<typeof vi.fn>) {
  const element = document.createElement("platformclaw-vault-upload") as PlatformClawVaultUpload;
  Object.assign(element, {
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    vaultId: wikiHubPersonalId,
  });
  document.body.append(element);
  await element.updateComplete;
  await element.updateComplete;
  return element;
}

describe("Personal Wiki Markdown upload", () => {
  it("opens upload directly, preserves folder source bytes, and keeps the completed result until Done", async () => {
    // Company HTTP origins may provide getRandomValues without randomUUID.
    vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const current = wikiHubSnapshot({ selectedId: wikiHubPersonalId });
    const request = vi.fn(async (method: string, params: ImportRequest) =>
      method === IMPORT ? saved(params) : current,
    );
    const element = mount(request);
    element.methods = [...element.methods, IMPORT];
    await waitForFast(() => expect(button(element, "Upload files")).toBeDefined());
    button(element, "Upload files").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-upload]")).not.toBeNull());
    const content = "\uFEFF# Overview\r\n\r\n[Next](guide/start.md)\r\n  Exact spaces.  \r\n";
    chooseFiles(
      element,
      [
        markdownFile("index.md", content, "Notes/index.md"),
        markdownFile("start.markdown", "# Next\n[[index]]", "Notes/guide/start.markdown"),
        markdownFile("figure.png", "image"),
      ],
      true,
    );
    await waitForFast(() =>
      expect(element.querySelectorAll("[data-upload-status]")).toHaveLength(3),
    );
    expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(2);
    expect(element.querySelectorAll('[data-upload-status="excluded"]')).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === IMPORT)).toHaveLength(0);
    button(element, "Preview index.md").click();
    await waitForFast(() =>
      expect(element.querySelector(".vaults__source")?.textContent).toBe(content),
    );
    const initialSnapshots = request.mock.calls.filter(
      ([method]) => method === `${rpc}snapshot`,
    ).length;
    button(element, "Upload 2 files").click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="saved"]')).toHaveLength(2),
    );
    expect(request).toHaveBeenCalledWith(IMPORT, {
      vaultId: wikiHubPersonalId,
      importId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      documents: [
        { relativePath: "index.md", content },
        { relativePath: "guide/start.markdown", content: "# Next\n[[index]]" },
      ],
    });
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === `${rpc}snapshot`)).toHaveLength(
        initialSnapshots + 1,
      ),
    );
    expect(element.querySelector("platformclaw-vault-upload")).not.toBeNull();
    expect(
      request.mock.calls.some(
        ([method]) => method === `${rpc}document.preview` || method === `${rpc}document.save`,
      ),
    ).toBe(false);
    button(element, "Done").click();
    await waitForFast(() => expect(element.querySelector("platformclaw-vault-author")).toBeNull());
    expect(element.textContent).toContain("2 uploaded");
  });

  it("refreshes again when another upload completes during a slow parent snapshot", async () => {
    let current = wikiHubSnapshot({ selectedId: wikiHubPersonalId });
    let firstRefresh: KnowledgeVaultSnapshot | null = null;
    let resolveRefresh!: (value: KnowledgeVaultSnapshot) => void;
    const delayedRefresh = new Promise<KnowledgeVaultSnapshot>((resolve) => {
      resolveRefresh = resolve;
    });
    let imports = 0;
    let snapshots = 0;
    const request = vi.fn(async (method: string, params: ImportRequest) => {
      if (method === IMPORT) {
        const result = saved(params);
        imports++;
        current = {
          ...current,
          selected: {
            ...current.selected!,
            documents: [
              ...current.selected!.documents,
              ...result.documents.map((entry) => ({
                ...wikiHubPersonalDocument,
                id: entry.path,
                logicalPath: entry.path,
                title: entry.relativePath,
              })),
            ],
          },
        };
        return result;
      }
      if (method === `${rpc}snapshot`) {
        snapshots++;
        if (imports === 1 && !firstRefresh) {
          firstRefresh = current;
          return delayedRefresh;
        }
      }
      return current;
    });
    const element = mount(request);
    element.methods = [...element.methods, IMPORT];
    await waitForFast(() => expect(button(element, "Upload files")).toBeDefined());
    const initialSnapshots = snapshots;
    button(element, "Upload files").click();
    await waitForFast(() => expect(element.querySelector("[data-vault-upload]")).not.toBeNull());
    chooseFiles(element, [markdownFile("first.md")]);
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(1),
    );
    button(element, "Upload 1 files").click();
    await waitForFast(() => expect(firstRefresh).not.toBeNull());
    chooseFiles(element, [markdownFile("second.md")]);
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(1),
    );
    button(element, "Retry pending files").click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="saved"]')).toHaveLength(2),
    );
    expect(snapshots).toBe(initialSnapshots + 1);
    button(element, "Done").click();
    await waitForFast(() => expect(element.querySelector("platformclaw-vault-author")).toBeNull());

    resolveRefresh(firstRefresh!);
    await waitForFast(() => {
      expect(snapshots).toBe(initialSnapshots + 2);
      expect(element.textContent).toContain("first.md");
      expect(element.textContent).toContain("second.md");
    });
  });

  it("accounts for invalid inputs before upload and preserves a cancelled selection", async () => {
    const request = vi.fn(async (_method: string, params: ImportRequest) => saved(params));
    const element = await uploadPane(request);
    const invalidUtf8 = markdownFile("invalid.md");
    Object.defineProperty(invalidUtf8, "arrayBuffer", {
      value: async () => Uint8Array.of(0xff).buffer,
    });
    chooseFiles(element, [
      markdownFile("A.MD"),
      markdownFile("a.markdown"),
      markdownFile("é.md"),
      markdownFile("e\u0301.md"),
      markdownFile("guide.md", "# Unsafe", "Notes/../guide.md"),
      markdownFile("con.md"),
      invalidUtf8,
      markdownFile("large.md", "a".repeat(1024 * 1024 + 1)),
      markdownFile("notes.txt"),
    ]);
    await waitForFast(() =>
      expect(element.querySelectorAll("[data-upload-status]")).toHaveLength(9),
    );
    expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(2);
    expect(element.querySelectorAll('[data-upload-status="invalid"]')).toHaveLength(6);
    expect(element.querySelectorAll('[data-upload-status="excluded"]')).toHaveLength(1);
    expect(request).not.toHaveBeenCalled();
    const leave = vi.fn();
    expect(element.requestLeave(leave)).toBe(false);
    await element.updateComplete;
    button(element, "Keep editing").click();
    await element.updateComplete;
    expect(leave).not.toHaveBeenCalled();
    expect(element.querySelectorAll("[data-upload-status]")).toHaveLength(9);
    button(element, "Upload 2 files").click();
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(
      request.mock.calls[0]![1].documents.map(
        (entry: { relativePath: string }) => entry.relativePath,
      ),
    ).toEqual(["A.MD", "é.md"]);
  });

  it.each([
    { count: 101, bytes: 16, chunks: [100, 1] },
    { count: 5, bytes: 1024 * 1024, chunks: [4, 1] },
  ])(
    "bounds $count files to count and byte limits under one import root",
    async ({ count, bytes, chunks }) => {
      const request = vi.fn(async (_method: string, params: ImportRequest) => saved(params));
      const element = await uploadPane(request);
      const content = "# " + "a".repeat(bytes - 2);
      chooseFiles(
        element,
        Array.from({ length: count }, (_, index) => markdownFile(`note-${index}.md`, content)),
      );
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(count),
      );
      button(element, `Upload ${count} files`).click();
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-upload-status="saved"]')).toHaveLength(count),
      );
      expect(request.mock.calls.map(([, params]) => params.documents.length)).toEqual(chunks);
      expect(new Set(request.mock.calls.map(([, params]) => params.importId)).size).toBe(1);
      expect(
        request.mock.calls.every(
          ([, params]) =>
            params.documents.reduce(
              (sum: number, entry: { content: string }) =>
                sum + new TextEncoder().encode(entry.content).length,
              0,
            ) <=
            4 * 1024 * 1024,
        ),
      ).toBe(true);
    },
  );

  it.each([true, false])(
    "retries only failed files and preserves confirmed index state (%s) until another compile",
    async (indexed) => {
      let attempt = 0;
      const request = vi.fn(async (_method: string, params: ImportRequest) => {
        const result = saved(params);
        attempt++;
        if (attempt === 1) {
          result.indexesRefreshed = indexed;
          result.documents[1] = {
            relativePath: "retry.md",
            path: `${result.rootPath}/retry.md`,
            status: "failed",
            error: "unavailable",
          };
          result.documents[2] = {
            relativePath: "fix.md",
            path: `${result.rootPath}/fix.md`,
            status: "failed",
            error: "invalid",
          };
        } else if (attempt === 2) {
          result.indexesRefreshed = false;
          result.documents = [
            {
              relativePath: "retry.md",
              path: `${result.rootPath}/retry.md`,
              status: "failed",
              error: "unavailable",
            },
          ];
        }
        return result;
      });
      const element = await uploadPane(request);
      chooseFiles(
        element,
        ["saved.md", "retry.md", "fix.md"].map((name) => markdownFile(name)),
      );
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(3),
      );
      button(element, "Upload 3 files").click();
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-upload-status="failed"]')).toHaveLength(2),
      );
      const indexPending = "search and links still need an update";
      expect(element.textContent?.includes(indexPending)).toBe(!indexed);
      // The failed-row count is unchanged by this retry. Wait for its completion,
      // so the previous render cannot satisfy the assertion while the RPC is pending.
      const retryCompleted = vi.fn();
      element.addEventListener("upload-complete", retryCompleted, { once: true });
      button(element, "Retry pending files").click();
      await waitForFast(() => expect(retryCompleted).toHaveBeenCalledOnce());
      await element.updateComplete;
      expect(request).toHaveBeenCalledTimes(2);
      expect(element.querySelectorAll('[data-upload-status="failed"]')).toHaveLength(2);
      expect(
        request.mock.calls[1]![1].documents.map(
          (entry: { relativePath: string }) => entry.relativePath,
        ),
      ).toEqual(["retry.md"]);
      expect(element.textContent?.includes(indexPending)).toBe(!indexed);
      button(element, "Retry pending files").click();
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-upload-status="saved"]')).toHaveLength(2),
      );
      expect(element.textContent).not.toContain(indexPending);
      button(element, "Remove fix.md from selection").click();
      await element.updateComplete;
      chooseFiles(element, [markdownFile("fix.md", "# Corrected\nExact body")]);
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(1),
      );
      button(element, "Retry pending files").click();
      await waitForFast(() =>
        expect(element.querySelectorAll('[data-upload-status="saved"]')).toHaveLength(3),
      );
      expect(request.mock.calls[3]![1].documents).toEqual([
        { relativePath: "fix.md", content: "# Corrected\nExact body" },
      ]);
      expect(new Set(request.mock.calls.map(([, params]) => params.importId)).size).toBe(1);
    },
  );

  it("marks interrupted saves unconfirmed and ignores a late result while retrying the same root", async () => {
    let resolveFirst!: (result: KnowledgeVaultDocumentImportResult) => void;
    const first = new Promise<KnowledgeVaultDocumentImportResult>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn(async (_method: string, params: ImportRequest) => {
      if (request.mock.calls.length === 1) {
        return first;
      }
      const result = saved(params);
      result.documents = result.documents.map((entry) => ({
        ...entry,
        status: "unchanged",
        title: entry.relativePath,
        revision: "b".repeat(64),
      }));
      return result;
    });
    const element = await uploadPane(request);
    chooseFiles(element, [markdownFile("a.md"), markdownFile("b.md")]);
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="ready"]')).toHaveLength(2),
    );
    button(element, "Upload 2 files").click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="uploading"]')).toHaveLength(2),
    );
    expect(element.requestLeave(vi.fn())).toBe(false);
    element.connected = false;
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="uncertain"]')).toHaveLength(2),
    );
    element.connected = true;
    await element.updateComplete;
    button(element, "Retry pending files").click();
    await waitForFast(() =>
      expect(element.querySelectorAll('[data-upload-status="unchanged"]')).toHaveLength(2),
    );
    resolveFirst(saved(request.mock.calls[0]![1]));
    await first;
    await element.updateComplete;
    expect(element.querySelectorAll('[data-upload-status="unchanged"]')).toHaveLength(2);
    expect(new Set(request.mock.calls.map(([, params]) => params.importId)).size).toBe(1);
  });
});
