/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createElement,
  deferred,
  type Request,
  result,
  submit,
  typeQuery,
} from "./memory-memories.test-support.ts";
import "./memory-memories.ts";

describe("MemoryMemoriesElement async invalidation", () => {
  it("refreshes mutations without losing query or filter and rejects an older search response", async () => {
    const stale = deferred<unknown>();
    const hit = {
      ...result,
      source: "shared",
      vaultId: "shared",
      vaultName: "PHY",
      vaultType: "shared",
      documentId: "doc",
      title: "Old title",
      revision: 1,
    };
    const response = (results: unknown[]) => ({
      agentId: "main",
      provider: "local",
      searchMode: "fts-only",
      results,
    });
    const request = vi
      .fn<Request>()
      .mockResolvedValueOnce(response([hit, result]))
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce(
        response([
          { ...hit, title: "Updated title", snippet: "Updated body", revision: 2 },
          result,
        ]),
      )
      .mockResolvedValueOnce(response([result]));
    const element = createElement(request);
    try {
      element.unifiedSearch = true;
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("Old title"));
      const filters = element.querySelector("wa-radio-group") as HTMLElement & { value: string };
      filters.value = "shared";
      filters.dispatchEvent(new Event("change", { bubbles: true }));
      await element.updateComplete;
      element.refreshRevision++;
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      element.refreshRevision++;
      await waitForFast(() => expect(element.textContent).toContain("Updated body"));
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("Ada");
      expect(
        (element.querySelector("wa-radio-group") as HTMLElement & { value: string }).value,
      ).toBe("shared");
      expect(element.textContent).not.toContain(result.snippet);
      stale.resolve(response([hit]));
      await Promise.resolve();
      await element.updateComplete;
      expect(element.textContent).not.toContain("Old title");
      expect(element.textContent).toContain("Updated title");
      expect(element.textContent).toContain("2");
      element.refreshRevision++;
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
      await waitForFast(() => expect(element.textContent).not.toContain("Updated title"));
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("Ada");
    } finally {
      element.remove();
    }
  });
  it("keeps cached browse content independent of search scope and transport availability", async () => {
    const request = vi.fn<Request>(async () => ({
      file: { path: "MEMORY.md", encoding: "utf8", content: "Cached owner notes" },
    }));
    const element = createElement(request, true, { browse: true });
    try {
      await waitForFast(() => expect(element.textContent).toContain("MEMORY.md"));
      element.searchScope = "all";
      element.unifiedSearch = true;
      await element.updateComplete;
      expect(element.textContent).toContain("MEMORY.md");
      await typeQuery(element, "pending query");
      element.connectionPhase = "offline";
      element.connected = false;
      await element.updateComplete;
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe(
        "pending query",
      );
      const count = request.mock.calls.length;
      const card = [...element.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("MEMORY.md"),
      );
      expect(card).toBeDefined();
      card!.click();
      await waitForFast(() => expect(element.textContent).toContain("Cached owner notes"));
      expect(request).toHaveBeenCalledTimes(count);
      element.agentId = "other";
      await element.updateComplete;
      expect(element.textContent).not.toContain("Cached owner notes");
    } finally {
      element.remove();
    }
  });

  it("ignores a delayed detail response after the bound Agent changes", async () => {
    const detail = deferred<unknown>();
    const request = vi.fn<Request>((method) =>
      method === "memory.search"
        ? Promise.resolve({
            agentId: "main",
            provider: "local",
            searchMode: "hybrid",
            results: [result],
          })
        : detail.promise,
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.querySelector("article > button")).not.toBeNull());
      element.querySelector<HTMLButtonElement>("article > button")?.click();
      await waitForFast(() => expect(element.textContent).toContain("Loading the full memory"));
      element.agentId = "research";
      await element.updateComplete;
      detail.resolve({
        agentId: "main",
        file: { path: result.path, encoding: "utf8", content: "foreign delayed detail" },
      });
      await Promise.resolve();
      await element.updateComplete;
      expect(element.textContent).not.toContain("foreign delayed detail");
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("");
      expect(element.querySelector(".memory-memories__results")).toBeNull();
    } finally {
      element.remove();
    }
  });

  it("drops an in-flight detail on disconnect and can load it after reconnect", async () => {
    const delayed = deferred<unknown>();
    let detailRequests = 0;
    const request = vi.fn<Request>((method) => {
      if (method === "memory.search") {
        return Promise.resolve({
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: [result],
        });
      }
      detailRequests += 1;
      return detailRequests === 1
        ? delayed.promise
        : Promise.resolve({
            agentId: "main",
            file: { path: result.path, encoding: "utf8", content: "current detail" },
          });
    });
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.querySelector("article > button")).not.toBeNull());
      element.querySelector<HTMLButtonElement>("article > button")?.click();
      await waitForFast(() => expect(element.textContent).toContain("Loading the full memory"));

      element.connectionPhase = "reconnecting";
      element.connected = false;
      await element.updateComplete;
      expect(element.textContent).not.toContain("Loading the full memory");
      expect(element.querySelector("article > button")).toBeNull();
      delayed.resolve({
        agentId: "main",
        file: { path: result.path, encoding: "utf8", content: "stale detail" },
      });
      await Promise.resolve();
      await element.updateComplete;
      expect(element.textContent).not.toContain("stale detail");

      element.connectionPhase = "connected";
      element.connected = true;
      await element.updateComplete;
      element.querySelector<HTMLButtonElement>("article > button")?.click();
      await waitForFast(() => expect(element.textContent).toContain("current detail"));
      expect(detailRequests).toBe(2);
    } finally {
      element.remove();
    }
  });

  it("invalidates delayed searches across input, reconnect, and capability changes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let searches = 0;
    const request = vi.fn<Request>((method) => {
      if (method !== "memory.search") {
        return Promise.resolve([]);
      }
      searches += 1;
      if (searches === 1) {
        return first.promise;
      }
      if (searches === 2) {
        return second.promise;
      }
      return Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "fts-only",
        results: [{ ...result, snippet: "Current result" }],
      });
    });
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("Searching memories"));
      await typeQuery(element, "Grace");
      expect(element.querySelector(".memory-memories__results")).toBeNull();
      expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        false,
      );
      first.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "fts-only",
        results: [{ ...result, snippet: "Stale input result" }],
      });
      await Promise.resolve();
      await element.updateComplete;
      expect(element.textContent).not.toContain("Stale input result");

      submit(element);
      await waitForFast(() => expect(searches).toBe(2));
      element.connectionPhase = "reconnecting";
      element.connected = false;
      await element.updateComplete;
      second.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "fts-only",
        results: [{ ...result, snippet: "Stale reconnect result" }],
      });
      await Promise.resolve();
      await element.updateComplete;
      expect(element.textContent).not.toContain("Stale reconnect result");

      element.connectionPhase = "connected";
      element.connected = true;
      await element.updateComplete;
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("Current result"));
      element.methodAdvertised = null;
      await element.updateComplete;
      expect(element.textContent).not.toContain("Current result");
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("");
    } finally {
      element.remove();
    }
  });

  it("resets results when the selected agent changes", async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [result],
      }),
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain(result.snippet));

      element.agentId = "research";
      await waitForFast(() =>
        expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe(""),
      );
      expect(element.textContent).not.toContain(result.snippet);
      expect(element.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("");
    } finally {
      element.remove();
    }
  });
});
