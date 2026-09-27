/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT } from "../../platformclaw/i18n.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createElement, submit, typeQuery } from "./memory-memories.test-support.ts";
import "./memory-memories.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
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
          vaultName: "Personal Wiki",
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
      expect(element.querySelector("[data-vault-provenance]")?.textContent).toContain("indexed-v2");
      expect(request).toHaveBeenCalledOnce();
    } finally {
      element.remove();
    }
  });

  it("uses connected search by default, preserves server ordering and opens shared provenance", async () => {
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
    element.vaultGetAdvertised = true;
    try {
      await typeQuery(element, "training");
      submit(element);
      await waitForFast(() =>
        expect(element.querySelectorAll("[data-vault-provenance]")).toHaveLength(2),
      );
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith("memory.search", { agentId: "main", query: "training" });
      expect(
        element.querySelector("[data-vault-provenance]")?.textContent?.replace(/\s+/gu, " "),
      ).toContain("PHY · shared · v1 · d1 · r7");
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
  });
});
