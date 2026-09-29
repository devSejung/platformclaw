/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT } from "../../platformclaw/i18n.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createElement, submit, typeQuery } from "./memory-memories.test-support.ts";
import "./memory-memories.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(async () => {
  await i18n.setLocale("en");
});

describe("server unified Vault search", () => {
  it("identifies retained Personal results and the recorded index failure", async () => {
    const request = vi.fn().mockResolvedValue({
      agentId: "main",
      provider: "local",
      results: [
        {
          path: "concepts/training.md",
          startLine: 1,
          endLine: 2,
          score: 1,
          snippet: "Last successfully indexed text",
          source: "wiki",
          vaultId: "personal:main",
          vaultName: "Personal",
          vaultType: "personal",
          documentId: "training",
          title: "Training",
          revision: "indexed-v2",
          indexStatus: "failed",
          indexError: "Compile unavailable",
          nextRetryAt: 1_788_163_200_000,
        },
      ],
    });
    const element = createElement(request);
    Object.assign(element, { unifiedSearch: true, translator: platformClawT });
    try {
      await typeQuery(element, "training");
      submit(element);
      await waitForFast(() =>
        expect(element.querySelector("[data-memory-index-warning]")).not.toBeNull(),
      );
      const warning = element.querySelector("[data-memory-index-warning]")!.textContent;
      expect(warning).toContain("Showing the last successful indexed version");
      expect(warning).toContain("Compile unavailable");
      expect(warning).toContain("Next retry");
      expect(element.querySelector("[data-vault-provenance]")?.textContent).toContain(
        "Revision indexed-v2",
      );
      expect(request).toHaveBeenCalledOnce();
    } finally {
      element.remove();
    }
  });

  it("routes Personal Wiki hits through the same Wiki Hub reader callback while raw Memory uses its own file owner", async () => {
    const hit = {
      source: "wiki",
      vaultId: "personal:main",
      vaultName: "Personal",
      vaultType: "personal",
      documentId: "concepts/a.md",
      path: "concepts/a.md",
      title: "Personal title",
      snippet: "Text",
      revision: "hash",
      score: 1,
      startLine: 1,
      endLine: 1,
    };
    const request = vi.fn().mockResolvedValue({ agentId: "main", results: [hit] });
    const open = vi.fn();
    const element = createElement(request);
    Object.assign(element, {
      unifiedSearch: true,
      vaultGetAdvertised: true,
      openVaultDocument: open,
    });
    try {
      await typeQuery(element, "text");
      submit(element);
      await waitForFast(() =>
        expect(element.querySelector(".wiki-hub__document-card button")).not.toBeNull(),
      );
      (element.querySelector(".wiki-hub__document-card button") as HTMLButtonElement).click();
      expect(open).toHaveBeenCalledWith("personal:main", "concepts/a.md");
      expect(request).toHaveBeenCalledOnce();
    } finally {
      element.remove();
    }
  });
  it.each(["en", "ko"] as const)(
    "uses connected search and localized shared provenance in %s",
    async (locale) => {
      await i18n.setLocale(locale);
      await loadPlatformClawLocale();
      const hit = {
        path: "shared/v1/d1",
        startLine: 1,
        endLine: 1,
        score: 0.2,
        snippet: "Training procedure",
        source: "shared",
        vaultId: "v1",
        vaultName: "PHY",
        vaultType: "shared",
        documentId: "d1",
        title: "Training",
        revision: 7,
      };
      const request = vi.fn(async (method: string) =>
        method === "memory.search"
          ? {
              agentId: "main",
              provider: "local",
              results: [hit, { ...hit, documentId: "d2", path: "shared/v1/d2", score: 0.9 }],
            }
          : { content: "# Shared training" },
      );
      const element = createElement(request, true, { wikiSearch: true });
      element.unifiedSearch = true;
      element.translator = platformClawT;
      element.vaultGetAdvertised = true;
      try {
        await typeQuery(element, "training");
        submit(element);
        await waitForFast(() =>
          expect(element.querySelectorAll("[data-vault-provenance]")).toHaveLength(2),
        );
        expect(request).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith("memory.search", {
          agentId: "main",
          query: "training",
        });
        expect(
          element.querySelector("[data-vault-provenance]")?.textContent?.replace(/\s+/gu, " "),
        ).toContain(
          `PHY · ${locale === "ko" ? "공유" : "Shared"} · ${locale === "ko" ? "버전" : "Revision"} 7`,
        );
        const provenance = element.querySelector<HTMLDetailsElement>(
          ".memory-memories__provenance-details",
        )!;
        expect(provenance.open).toBe(false);
        expect(provenance.closest("button")).toBeNull();
        expect(provenance.textContent).toContain("v1 · d1");
        expect(provenance.textContent).toContain(hit.path);
        expect(element.querySelector("[aria-controls=memory-detail-0]")?.textContent).not.toContain(
          hit.path,
        );
        provenance.querySelector("summary")!.click();
        expect(provenance.open).toBe(true);
        element.querySelector<HTMLButtonElement>("[aria-controls=memory-detail-0]")!.click();
        await waitForFast(() =>
          expect(element.querySelector("#memory-detail-0 h1")?.textContent).toBe("Shared training"),
        );
        expect(request).toHaveBeenLastCalledWith("platformclaw.vault.document.get", {
          vaultId: "v1",
          documentId: "d1",
        });
        element.searchScope = "all";
        await typeQuery(element, "training");
        submit(element);
        await waitForFast(() =>
          expect(request).toHaveBeenLastCalledWith("memory.search", {
            agentId: "main",
            query: "training",
            scope: "all",
          }),
        );
        element.searchScope = "connected";
        element.vaultId = "v1";
        await typeQuery(element, "training");
        submit(element);
        await waitForFast(() =>
          expect(request).toHaveBeenLastCalledWith("memory.search", {
            agentId: "main",
            query: "training",
            vaultId: "v1",
          }),
        );
      } finally {
        element.remove();
      }
    },
  );
});
