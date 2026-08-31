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
