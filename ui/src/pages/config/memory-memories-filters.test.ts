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

describe("Memory result source filters", () => {
  it("filters the returned set without another search and preserves detail identity", async () => {
    const request = vi.fn<Request>((method) => {
      if (method === "memory.search") {
        return Promise.resolve({
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          stale: true,
          results: [result],
        });
      }
      if (method === "wiki.search") {
        return Promise.resolve([
          {
            path: "concepts/review.md",
            title: "Review notes",
            kind: "concept",
            score: 0.5,
            snippet: "A separate Wiki document.",
            startLine: 1,
            endLine: 1,
          },
        ]);
      }
      return Promise.resolve({ displayContent: "# Wiki detail" });
    });
    const element = createElement(request, true, { wikiSearch: true, wikiGet: true });
    const select = async (value: string) => {
      const group = element.querySelector(
        ".memory-memories__filters wa-radio-group",
      ) as HTMLElement & { value: string };
      group.value = value;
      group.dispatchEvent(new Event("change", { bubbles: true }));
      await element.updateComplete;
    };
    try {
      await typeQuery(element, "review");
      submit(element);
      await waitForFast(() =>
        expect(element.querySelectorAll(".memory-memories__result")).toHaveLength(2),
      );
      expect(element.textContent).toContain("Filter within these results");
      await select("wiki");
      expect(element.querySelectorAll(".memory-memories__result")).toHaveLength(1);
      expect(element.textContent).not.toContain(result.snippet);
      expect(element.textContent).toContain("These results may be out of date");
      expect(request).toHaveBeenCalledTimes(2);
      const wiki = element.querySelector<HTMLButtonElement>('[aria-controls="memory-detail-1"]');
      expect(wiki).not.toBeNull();
      wiki!.click();
      await waitForFast(() =>
        expect(element.querySelector("#memory-detail-1 h1")?.textContent).toBe("Wiki detail"),
      );
      expect(request).toHaveBeenLastCalledWith("wiki.document.get", {
        agentId: "main",
        lookup: "concepts/review.md",
      });
      await select("memory");
      expect(element.querySelector("#memory-detail-1")).toBeNull();
      await select("all");
      expect(element.querySelector("#memory-detail-1 h1")?.textContent).toBe("Wiki detail");
      expect(request).toHaveBeenCalledTimes(3);

      await select("wiki");
      await typeQuery(element, "new query");
      submit(element);
      await waitForFast(() =>
        expect(element.querySelectorAll(".memory-memories__result")).toHaveLength(2),
      );
      expect(element.querySelector("#memory-detail-1")).toBeNull();
      expect(element.querySelector('wa-radio[value="all"]')?.getAttribute("class")).toContain(
        "--active",
      );
      element.agentId = "other";
      await element.updateComplete;
      expect(element.querySelector(".memory-memories__filters")).toBeNull();
      expect(element.textContent).not.toContain("Review notes");
    } finally {
      element.remove();
    }
  });

  it("keeps cached details offline, drops in-flight details, and does not refetch", async () => {
    const pendingMemoryDetail = deferred<{
      file: { path: string; name: string; encoding: "utf8"; content: string };
    }>();
    const memoryResult = {
      ...result,
      path: "memory/in-flight.md",
      snippet: "Detail still loading.",
      startLine: 1,
      endLine: 1,
    };
    const request = vi.fn<Request>((method) => {
      if (method === "memory.search") {
        return Promise.resolve({
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: [memoryResult],
        });
      }
      if (method === "wiki.search") {
        return Promise.resolve([
          {
            path: "concepts/cached.md",
            title: "Cached Wiki",
            kind: "concept",
            score: 0.5,
            snippet: "Cached before disconnect.",
            startLine: 1,
            endLine: 1,
          },
        ]);
      }
      if (method === "wiki.document.get") {
        return Promise.resolve({ displayContent: "# Cached detail" });
      }
      if (method === "agents.workspace.get") {
        return pendingMemoryDetail.promise;
      }
      return Promise.reject(new Error(`unexpected method: ${method}`));
    });
    const element = createElement(request, true, { wikiSearch: true, wikiGet: true });
    const select = async (value: string) => {
      const group = element.querySelector(
        ".memory-memories__filters wa-radio-group",
      ) as HTMLElement & { value: string };
      group.value = value;
      group.dispatchEvent(new Event("change", { bubbles: true }));
      await element.updateComplete;
    };
    try {
      await typeQuery(element, "offline");
      submit(element);
      await waitForFast(() =>
        expect(element.querySelectorAll(".memory-memories__result")).toHaveLength(2),
      );

      await select("wiki");
      element.querySelector<HTMLButtonElement>('[aria-controls="memory-detail-1"]')?.click();
      await waitForFast(() =>
        expect(element.querySelector("#memory-detail-1 h1")?.textContent).toBe("Cached detail"),
      );
      expect(request.mock.calls.filter(([method]) => method === "wiki.document.get")).toHaveLength(
        1,
      );

      await select("memory");
      element.querySelector<HTMLButtonElement>('[aria-controls="memory-detail-0"]')?.click();
      await waitForFast(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
        ).toHaveLength(1),
      );
      expect(element.querySelector("#memory-detail-0")?.textContent).toContain("Loading");

      element.connected = false;
      element.connectionPhase = "offline";
      await element.updateComplete;
      expect(element.querySelector("#memory-detail-0")).toBeNull();
      expect(element.querySelector('[aria-controls="memory-detail-0"]')).toBeNull();

      const callsAtDisconnect = request.mock.calls.length;
      pendingMemoryDetail.resolve({
        file: {
          path: memoryResult.path,
          name: "in-flight.md",
          encoding: "utf8",
          content: "# Late detail",
        },
      });
      await Promise.resolve();
      await element.updateComplete;
      expect(element.textContent).not.toContain("Late detail");
      expect(request).toHaveBeenCalledTimes(callsAtDisconnect);

      await select("all");
      const cachedWiki = element.querySelector<HTMLButtonElement>(
        '[aria-controls="memory-detail-1"]',
      );
      expect(cachedWiki).not.toBeNull();
      cachedWiki!.click();
      await element.updateComplete;
      expect(element.querySelector("#memory-detail-1 h1")?.textContent).toBe("Cached detail");
      expect(request).toHaveBeenCalledTimes(callsAtDisconnect);
      expect(request.mock.calls.filter(([method]) => method === "wiki.document.get")).toHaveLength(
        1,
      );
    } finally {
      element.remove();
    }
  });

  it("uses existing browse timestamps without prefetching daily files", async () => {
    const request = vi.fn<Request>((method) =>
      Promise.resolve(
        method === "agents.workspace.list"
          ? {
              entries: [
                {
                  path: "memory/2026-08-31.md",
                  name: "2026-08-31.md",
                  updatedAtMs: 1_788_163_200_000,
                },
                { path: "memory/2026-08-30.md", name: "2026-08-30.md" },
              ],
            }
          : {
              file: {
                path: "MEMORY.md",
                name: "MEMORY.md",
                encoding: "utf8",
                content: "Durable context",
                updatedAtMs: 1_788_163_200_000,
              },
            },
      ),
    );
    const element = createElement(request, true, { browse: true, browseList: true });
    try {
      await waitForFast(() => expect(element.textContent).toContain("2026-08-30.md"));
      expect(
        element.querySelector('[aria-controls="memory-long-term-detail"]')?.textContent,
      ).toContain("Updated");
      expect(
        element.querySelector('[aria-controls="memory-browse-detail-2"]')?.textContent,
      ).toContain("Updated");
      expect(
        element.querySelector('[aria-controls="memory-browse-detail-3"]')?.textContent,
      ).not.toContain("Updated");
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(1);
    } finally {
      element.remove();
    }
  });
});
