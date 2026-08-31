/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./memory-memories.ts";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type MemoryMemoriesTestElement = HTMLElement & {
  client: GatewayBrowserClient | null;
  connected: boolean;
  connectionPhase: "stopped" | "connecting" | "connected" | "reconnecting" | "offline" | "";
  methodAdvertised: boolean | null;
  wikiSearchAdvertised: boolean | null;
  browseEnabled: boolean;
  browseListAdvertised: boolean | null;
  personalDetailAdvertised: boolean | null;
  wikiGetAdvertised: boolean | null;
  organizationGetAdvertised: boolean | null;
  agentId: string | null;
  updateComplete: Promise<unknown>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createElement(
  request: Request,
  advertised = true,
  options: {
    browse?: boolean;
    browseList?: boolean | null;
    connectionPhase?: MemoryMemoriesTestElement["connectionPhase"];
    organizationGet?: boolean | null;
    personalDetail?: boolean | null;
    wikiGet?: boolean | null;
    wikiSearch?: boolean | null;
  } = {},
) {
  const element = document.createElement("openclaw-memory-memories") as MemoryMemoriesTestElement;
  element.client = { request } as unknown as GatewayBrowserClient;
  element.connected = true;
  element.connectionPhase = options.connectionPhase ?? "connected";
  element.methodAdvertised = advertised;
  element.wikiSearchAdvertised = options.wikiSearch ?? false;
  element.browseEnabled = options.browse ?? false;
  element.browseListAdvertised = options.browseList ?? false;
  element.personalDetailAdvertised = options.personalDetail ?? true;
  element.wikiGetAdvertised = options.wikiGet ?? false;
  element.organizationGetAdvertised = options.organizationGet ?? false;
  element.agentId = "main";
  document.body.append(element);
  return element;
}

async function typeQuery(element: MemoryMemoriesTestElement, query: string) {
  await element.updateComplete;
  const input = element.querySelector<HTMLInputElement>("#memory-search-input");
  if (!input) {
    throw new Error("missing memory search input");
  }
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await element.updateComplete;
}

function submit(element: MemoryMemoriesTestElement) {
  element
    .querySelector("form")
    ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}

const result = {
  path: "memory/people/ada.md",
  startLine: 2,
  endLine: 3,
  score: 0.876,
  snippet: "Ada prefers careful reviews.",
  source: "memory" as const,
};

describe("MemoryMemoriesElement", () => {
  it("renders idle and gateway-update-required states", async () => {
    const current = createElement(vi.fn(() => Promise.resolve({})));
    await current.updateComplete;
    expect(current.textContent?.match(/organization knowledge you can access/gu)).toHaveLength(1);
    expect(current.querySelector("form")).not.toBeNull();
    current.remove();

    const old = createElement(
      vi.fn(() => Promise.resolve({})),
      false,
    );
    await old.updateComplete;
    expect(old.textContent).toContain("Update the gateway to search memories");
    expect(old.querySelector("form")).toBeNull();
    old.remove();
  });

  it("keeps search disabled when no agent is available", async () => {
    const request = vi.fn(() => Promise.resolve({}));
    const element = createElement(request);
    try {
      element.agentId = null;
      await typeQuery(element, "Ada");
      expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
        true,
      );
      submit(element);
      expect(request).not.toHaveBeenCalled();
    } finally {
      element.remove();
    }
  });

  it("browses MEMORY.md and seven newest top-level daily files before search", async () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      path: `memory/2026-08-${String(index + 1).padStart(2, "0")}.md`,
      name: `2026-08-${String(index + 1).padStart(2, "0")}.md`,
      kind: "file" as const,
      updatedAtMs: index + 1,
    }));
    const request = vi.fn<Request>((method, params) => {
      if (method === "agents.workspace.list") {
        return Promise.resolve({ entries, hasAdditionalFolders: true });
      }
      return Promise.resolve({
        agentId: "main",
        file: {
          path: params.path,
          name: String(params.path).split("/").at(-1),
          encoding: "utf8",
          content:
            params.path === "MEMORY.md" ? "# Durable\nLong-term context." : "# Daily\nRecent note.",
        },
      });
    });
    const element = createElement(request, true, {
      browse: true,
      browseList: true,
      personalDetail: true,
    });
    try {
      await waitForFast(() => expect(element.textContent).toContain("2026-08-09.md"));
      expect(request).toHaveBeenCalledWith("agents.workspace.get", {
        agentId: "main",
        path: "MEMORY.md",
      });
      expect(request).toHaveBeenCalledWith("agents.workspace.list", {
        agentId: "main",
        path: "memory",
      });
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.list"),
      ).toHaveLength(1);
      expect(element.textContent).not.toContain("Long-term context.");
      const recentSection = element.querySelectorAll(".settings-section")[1]!;
      const recentTitles = [
        ...recentSection.querySelectorAll(".memory-memories__result .settings-row__title"),
      ].map((node) => node.textContent?.trim());
      expect(recentTitles).toHaveLength(7);
      expect(recentTitles[0]).toBe("2026-08-09.md");
      expect(recentTitles).not.toContain("2026-08-01.md");
      expect(recentSection.textContent).not.toContain("memory/2026-08-09.md");
      expect(recentSection.querySelectorAll(".settings-row__chevron")).toHaveLength(7);

      const memoryRow = [...element.querySelectorAll<HTMLButtonElement>("article > button")].find(
        (button) => button.textContent?.includes("MEMORY.md"),
      );
      memoryRow?.click();
      await waitForFast(() => expect(element.textContent).toContain("Long-term context."));
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "agents.workspace.get" && params.path === "MEMORY.md",
        ),
      ).toHaveLength(1);

      expect(element.textContent).toContain("This is a partial list");
      expect(element.textContent).toContain("Additional top-level entries");
      expect(element.textContent).not.toContain("older top-level entries");
      const searchMore = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Search",
      );
      searchMore?.click();
      expect(document.activeElement?.id).toBe("memory-search-input");
    } finally {
      element.remove();
    }
  });

  it("keeps missing and partial browse failures local to their owning section", async () => {
    const missing = createElement(
      vi.fn<Request>((method) =>
        Promise.resolve(
          method === "agents.workspace.get"
            ? {
                file: {
                  path: "MEMORY.md",
                  name: "MEMORY.md",
                  encoding: "utf8",
                  content: "",
                  missing: true,
                },
              }
            : { entries: [] },
        ),
      ),
      true,
      { browse: true, browseList: true, personalDetail: true },
    );
    try {
      await waitForFast(() => expect(missing.textContent).toContain("MEMORY.md is empty"));
      expect(missing.textContent).toContain("No daily memory entries yet");
      expect(missing.querySelector('[role="alert"]')).toBeNull();
    } finally {
      missing.remove();
    }

    const nestedOnly = createElement(
      vi.fn<Request>((method) =>
        Promise.resolve(
          method === "agents.workspace.get"
            ? {
                file: {
                  path: "MEMORY.md",
                  name: "MEMORY.md",
                  encoding: "utf8",
                  content: "",
                  missing: true,
                },
              }
            : { entries: [], hasAdditionalFolders: true },
        ),
      ),
      true,
      { browse: true, browseList: true, personalDetail: true },
    );
    try {
      await waitForFast(() =>
        expect(nestedOnly.textContent).toContain("More memory is searchable"),
      );
      expect(nestedOnly.textContent).not.toContain("No daily memory entries yet");
    } finally {
      nestedOnly.remove();
    }

    const partial = createElement(
      vi.fn<Request>((method) =>
        method === "agents.workspace.get"
          ? Promise.reject(new Error("long-term read unavailable"))
          : Promise.resolve({
              entries: [
                {
                  path: "memory/2026-08-31.md",
                  name: "2026-08-31.md",
                  kind: "file",
                  updatedAtMs: 1,
                },
              ],
            }),
      ),
      true,
      { browse: true, browseList: true, personalDetail: true },
    );
    try {
      await waitForFast(() => expect(partial.textContent).toContain("long-term read unavailable"));
      expect(partial.textContent).toContain("2026-08-31.md");
      expect(partial.textContent).not.toContain("Recent daily memory could not be refreshed");
    } finally {
      partial.remove();
    }

    for (const bothFail of [false, true]) {
      const listFailure = createElement(
        vi.fn<Request>((method) =>
          method === "agents.workspace.get"
            ? bothFail
              ? Promise.reject(new Error("long-term owner unavailable"))
              : Promise.resolve({
                  file: {
                    path: "MEMORY.md",
                    name: "MEMORY.md",
                    encoding: "utf8",
                    content: "# Available long-term memory",
                  },
                })
            : Promise.reject(new Error("daily owner unavailable")),
        ),
        true,
        { browse: true, browseList: true, personalDetail: true },
      );
      try {
        await waitForFast(() =>
          expect(listFailure.textContent).toContain("daily owner unavailable"),
        );
        expect(listFailure.textContent).toContain("Recent daily memory could not be refreshed");
        expect(listFailure.textContent).toContain(
          bothFail ? "long-term owner unavailable" : "MEMORY.md",
        );
        expect(listFailure.querySelectorAll('[role="alert"]')).toHaveLength(bothFail ? 2 : 1);
      } finally {
        listFailure.remove();
      }
    }
  });

  it("distinguishes capability discovery, connecting, offline, and confirmed absence", async () => {
    const request = vi.fn<Request>(() => Promise.resolve({}));
    const element = createElement(request, true, {
      browse: true,
      browseList: null,
      connectionPhase: "connecting",
      personalDetail: null,
      wikiSearch: null,
    });
    try {
      await element.updateComplete;
      expect(element.textContent).toContain("Connecting to the Gateway");
      expect(element.textContent?.match(/Connecting to the Gateway/g)).toHaveLength(1);
      expect(element.textContent).not.toContain("Gateway offline");
      expect(element.textContent).not.toContain("Update the Gateway");
      expect(request).not.toHaveBeenCalled();

      element.connectionPhase = "reconnecting";
      element.connected = false;
      await element.updateComplete;
      expect(element.textContent).toContain("Reconnecting to the Gateway");
      expect(element.textContent?.match(/Reconnecting to the Gateway/g)).toHaveLength(1);
      expect(element.textContent).not.toContain("Gateway offline");

      element.connectionPhase = "offline";
      await element.updateComplete;
      expect(element.textContent).toContain("Gateway offline");
      expect(element.textContent?.match(/Gateway offline/g)).toHaveLength(1);
      expect(element.textContent).not.toContain("Update the Gateway");

      element.connectionPhase = "connected";
      element.connected = true;
      element.methodAdvertised = false;
      element.wikiSearchAdvertised = false;
      element.personalDetailAdvertised = false;
      element.browseListAdvertised = false;
      await element.updateComplete;
      expect(element.textContent).toContain("Update the Gateway");
      expect(element.querySelector('button[type="submit"]')).toBeNull();
    } finally {
      element.remove();
    }
  });

  it("retains rows while refresh is busy and replaces an open preview after completion", async () => {
    const refreshMemory = deferred<unknown>();
    const refreshList = deferred<unknown>();
    let round = 0;
    const request = vi.fn<Request>((method) => {
      if (method === "agents.workspace.get") {
        round += 1;
        if (round === 1) {
          return Promise.resolve({
            file: {
              path: "MEMORY.md",
              name: "MEMORY.md",
              encoding: "utf8",
              content: "old long-term content",
            },
          });
        }
        return round === 2
          ? refreshMemory.promise
          : Promise.reject(new Error("long-term refresh unavailable"));
      }
      if (round === 1) {
        return Promise.resolve({
          entries: [
            {
              path: "memory/old.md",
              name: "old.md",
              kind: "file",
              updatedAtMs: 1,
            },
          ],
        });
      }
      return round === 2
        ? refreshList.promise
        : Promise.resolve({
            entries: [{ path: "memory/new.md", name: "new.md", kind: "file", updatedAtMs: 2 }],
          });
    });
    const element = createElement(request, true, {
      browse: true,
      browseList: true,
      personalDetail: true,
    });
    try {
      await waitForFast(() => expect(element.textContent).toContain("old.md"));
      element
        .querySelector<HTMLButtonElement>('button[aria-controls="memory-long-term-detail"]')
        ?.click();
      await waitForFast(() => expect(element.textContent).toContain("old long-term content"));
      const refresh = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Refresh personal memory",
      );
      refresh?.click();
      await waitForFast(() => expect(element.textContent).toContain("Refreshing…"));
      expect(element.textContent).toContain("old.md");
      expect(element.textContent).not.toContain("old long-term content");
      expect(refresh?.disabled).toBe(true);

      refreshMemory.resolve({
        file: {
          path: "MEMORY.md",
          name: "MEMORY.md",
          encoding: "utf8",
          content: "new long-term content",
        },
      });
      refreshList.resolve({
        entries: [{ path: "memory/new.md", name: "new.md", kind: "file", updatedAtMs: 2 }],
      });
      await waitForFast(() => expect(element.textContent).toContain("Personal memory refreshed"));
      expect(element.textContent).toContain("new.md");
      expect(element.textContent).not.toContain("old.md");

      const failedRefresh = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Refresh personal memory",
      );
      failedRefresh?.click();
      await waitForFast(() =>
        expect(element.textContent).toContain("long-term refresh unavailable"),
      );
      expect(element.textContent).toContain("MEMORY.md");
      expect(element.textContent).toContain("new.md");
      element
        .querySelector<HTMLButtonElement>('button[aria-controls="memory-long-term-detail"]')
        ?.click();
      await waitForFast(() => expect(element.textContent).toContain("new long-term content"));
    } finally {
      element.remove();
    }
  });

  it("ignores delayed browse responses after the bound Agent changes", async () => {
    const oldMemory = deferred<unknown>();
    const oldList = deferred<unknown>();
    const request = vi.fn<Request>((method, params) => {
      if (params.agentId === "main") {
        return method === "agents.workspace.get" ? oldMemory.promise : oldList.promise;
      }
      return Promise.resolve(
        method === "agents.workspace.get"
          ? {
              file: {
                path: "MEMORY.md",
                name: "MEMORY.md",
                encoding: "utf8",
                content: "current Agent memory",
              },
            }
          : {
              entries: [
                {
                  path: "memory/current.md",
                  name: "current.md",
                  kind: "file",
                  updatedAtMs: 2,
                },
                {
                  path: "memory/fresh.md",
                  name: "fresh.md",
                  kind: "file",
                  updatedAtMs: 1,
                },
              ],
            },
      );
    });
    const element = createElement(request, true, {
      browse: true,
      browseList: true,
      personalDetail: true,
    });
    try {
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      element.agentId = "research";
      await waitForFast(() => expect(element.textContent).toContain("current.md"));
      oldMemory.resolve({
        file: {
          path: "MEMORY.md",
          name: "MEMORY.md",
          encoding: "utf8",
          content: "foreign Agent memory",
        },
      });
      oldList.resolve({
        entries: [{ path: "memory/foreign.md", name: "foreign.md", kind: "file", updatedAtMs: 3 }],
      });
      await Promise.resolve();
      await element.updateComplete;
      expect(element.textContent).toContain("current.md");
      expect(element.textContent).not.toContain("foreign.md");
      expect(element.textContent).not.toContain("foreign Agent memory");
      const cachedRecent = element.querySelector<HTMLButtonElement>(
        'button[aria-controls="memory-browse-detail-2"]',
      );
      cachedRecent?.click();
      await waitForFast(() => expect(element.textContent).toContain("current Agent memory"));
      cachedRecent?.click();
      await element.updateComplete;
      element.personalDetailAdvertised = null;
      element.browseListAdvertised = null;
      element.connectionPhase = "offline";
      element.connected = false;
      await element.updateComplete;
      const cachedOffline = element.querySelector('.settings-empty[role="status"]');
      expect(cachedOffline?.textContent).toContain("Reconnect to load or refresh personal memory");
      expect(element.textContent).toContain("current.md");
      expect(element.querySelector(".settings-status")).toBeNull();
      expect(
        element.querySelector('button[aria-controls="memory-browse-detail-2"]'),
      ).not.toBeNull();
      expect(element.querySelector('button[aria-controls="memory-browse-detail-3"]')).toBeNull();
      element
        .querySelector<HTMLButtonElement>('button[aria-controls="memory-browse-detail-2"]')
        ?.click();
      await element.updateComplete;
      expect(element.textContent).toContain("current Agent memory");
      element
        .querySelector<HTMLButtonElement>('button[aria-controls="memory-long-term-detail"]')
        ?.click();
      await element.updateComplete;
      expect(element.textContent).toContain("current Agent memory");

      element.connectionPhase = "connected";
      element.connected = true;
      element.personalDetailAdvertised = false;
      element.browseListAdvertised = false;
      await element.updateComplete;
      expect(element.textContent).not.toContain("current.md");
      expect(element.textContent).toContain("Update the Gateway");
    } finally {
      element.remove();
    }
  });

  it("searches only on submit and renders loading, ready, mode, and result metadata", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      expect(request).not.toHaveBeenCalled();

      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("Searching memories"));
      expect(request).toHaveBeenCalledWith("memory.search", { query: "Ada", agentId: "main" });

      pending.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [result],
      });
      await waitForFast(() => expect(element.textContent).toContain(result.snippet));
      expect(element.textContent).toContain("hybrid search");
      expect(element.textContent?.replace(/\s+/g, " ")).toContain(
        "memory/people/ada.md · lines 2–3",
      );
      expect(element.textContent).toContain("score 0.88");
      expect(element.textContent).toContain("memory");
      const summary = element.querySelector('.memory-memories__results-heading[role="status"]');
      expect(summary?.getAttribute("aria-live")).toBe("polite");
      expect(summary?.getAttribute("aria-atomic")).toBe("true");
      expect(summary?.textContent).toContain("1 results");
      expect(summary?.getAttribute("aria-label")).toContain("1 results");
    } finally {
      element.remove();
    }
  });

  it("keeps one search corpus visible when another fails and explains stale results", async () => {
    const partialRequest = vi.fn<Request>((method) =>
      method === "memory.search"
        ? Promise.reject(new Error("personal index unavailable"))
        : Promise.resolve([
            {
              path: "concepts/releases.md",
              title: "Release notes",
              kind: "concept",
              score: 0.9,
              snippet: "Personal Wiki result remains visible.",
            },
          ]),
    );
    const partial = createElement(partialRequest, true, { wikiSearch: true });
    try {
      await typeQuery(partial, "release");
      submit(partial);
      await waitForFast(() => expect(partial.textContent).toContain("Wiki result remains visible"));
      expect(partial.querySelectorAll('[role="status"]')).toHaveLength(1);
      const notices = partial.querySelector(".memory-memories__state");
      expect(notices?.textContent).toContain("Personal memory search is temporarily unavailable");
      expect(notices?.textContent).toContain("Organization memory is temporarily unavailable");
      const partialSummary = partial.querySelector(
        '.memory-memories__results-heading[role="status"]',
      );
      expect(partialSummary?.getAttribute("aria-label")).toContain(
        "Personal memory search is temporarily unavailable",
      );
      expect(partialSummary?.getAttribute("aria-label")).toContain(
        "Organization memory is temporarily unavailable",
      );
      expect(partial.textContent).not.toContain("Memory search failed");
    } finally {
      partial.remove();
    }

    const stale = createElement(
      vi.fn<Request>((method) =>
        Promise.resolve(
          method === "memory.search"
            ? {
                agentId: "main",
                provider: "local",
                searchMode: "hybrid",
                stale: true,
                results: [result],
              }
            : [],
        ),
      ),
      true,
      { wikiSearch: true },
    );
    try {
      await typeQuery(stale, "Ada");
      submit(stale);
      await waitForFast(() => expect(stale.textContent).toContain("results may be out of date"));
      expect(stale.textContent).toContain(result.snippet);
      expect(
        stale
          .querySelector('.memory-memories__results-heading[role="status"]')
          ?.getAttribute("aria-label"),
      ).toContain("results may be out of date");
    } finally {
      stale.remove();
    }
  });

  it("labels organization results by authorized scope without workspace expansion", async () => {
    const request = vi.fn<Request>(() =>
      Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "fts-only",
        organizationMemoryUnavailable: true,
        results: [
          {
            ...result,
            source: "organization",
            corpus: "platformclaw-organization",
            path: "organization/part/release-policy",
            title: "Release policy",
            kind: "part",
            provenanceLabel: "Runtime",
            snippet: "Two approvals are required.",
            startLine: 1,
            endLine: 1,
          },
        ],
      }),
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "release");
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("Two approvals are required."));
      expect(element.textContent?.replace(/\s+/g, " ")).toContain("organization · Runtime");
      expect(element.textContent).toContain("Organization memory is temporarily unavailable.");
      expect(element.querySelector("article > button")).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      element.remove();
    }
  });

  it("searches personal memory, Personal Wiki, and organization knowledge together and opens each", async () => {
    const request = vi.fn<Request>((method) => {
      if (method === "memory.search") {
        return Promise.resolve({
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: [
            result,
            {
              ...result,
              source: "organization",
              path: "organization/group/release-policy",
              title: "Group release policy",
              kind: "group",
              provenanceLabel: "Platform",
              snippet: "Use the group checklist.",
              startLine: 1,
              endLine: 1,
            },
          ],
        });
      }
      if (method === "wiki.search") {
        return Promise.resolve([
          {
            path: "concepts/release-policy.md",
            title: "Personal release notes",
            kind: "concept",
            score: 0.95,
            snippet: "My release checklist.",
          },
        ]);
      }
      if (method === "wiki.get") {
        return Promise.resolve({
          content: "# Personal\nMy release checklist.",
          fromLine: 1,
          lineCount: 2,
        });
      }
      if (method === "platformclaw.memory.get") {
        return Promise.resolve({
          content: "# Group\nUse the group checklist.",
          fromLine: 1,
          lineCount: 2,
        });
      }
      return Promise.resolve({
        agentId: "main",
        file: {
          path: result.path,
          encoding: "utf8",
          content: "# Ada\nAda prefers careful reviews.",
        },
      });
    });
    const element = createElement(request, true, {
      wikiSearch: true,
      wikiGet: true,
      organizationGet: true,
    });
    try {
      await typeQuery(element, "release");
      submit(element);
      await waitForFast(() => expect(element.querySelectorAll("article")).toHaveLength(3));
      expect(element.textContent).toContain("Personal release notes");
      expect(element.textContent).toContain("Group release policy");
      expect(element.textContent).toContain("Personal Wiki");
      expect(element.textContent).toContain("organization · Platform");

      const articles = [...element.querySelectorAll("article")];
      const wiki = articles.find((article) =>
        article.textContent?.includes("Personal release notes"),
      );
      wiki?.querySelector<HTMLButtonElement>("button")?.click();
      await waitForFast(() => expect(element.textContent).toContain("# Personal"));
      const organization = articles.find((article) =>
        article.textContent?.includes("Group release policy"),
      );
      organization?.querySelector<HTMLButtonElement>("button")?.click();
      await waitForFast(() => expect(element.textContent).toContain("# Group"));

      expect(request).toHaveBeenCalledWith("wiki.search", {
        query: "release",
        agentId: "main",
        maxResults: 50,
      });
      expect(request).toHaveBeenCalledWith("wiki.get", {
        agentId: "main",
        lookup: "concepts/release-policy.md",
      });
      expect(request).toHaveBeenCalledWith("platformclaw.memory.get", {
        agentId: "main",
        path: "organization/group/release-policy",
      });
    } finally {
      element.remove();
    }
  });

  it("gates personal, Wiki, and organization detail RPCs independently", async () => {
    const cases = [
      {
        label: result.snippet,
        method: "agents.workspace.get",
        options: { personalDetail: true, wikiGet: false, organizationGet: false },
      },
      {
        label: "Wiki detail",
        method: "wiki.get",
        options: { personalDetail: false, wikiGet: true, organizationGet: false },
      },
      {
        label: "Organization detail",
        method: "platformclaw.memory.get",
        options: { personalDetail: false, wikiGet: false, organizationGet: true },
      },
    ] as const;
    for (const testCase of cases) {
      const request = vi.fn<Request>((method) => {
        if (method === "memory.search") {
          return Promise.resolve({
            agentId: "main",
            provider: "local",
            searchMode: "hybrid",
            results: [
              result,
              {
                ...result,
                source: "organization",
                path: "organization/group/policy",
                title: "Organization detail",
                provenanceLabel: "Platform",
              },
            ],
          });
        }
        if (method === "wiki.search") {
          return Promise.resolve([
            {
              path: "concepts/wiki.md",
              title: "Wiki detail",
              kind: "concept",
              score: 0.99,
              snippet: "Wiki snippet",
            },
          ]);
        }
        return Promise.resolve(
          method === "agents.workspace.get"
            ? { file: { path: result.path, encoding: "utf8", content: "personal detail" } }
            : { content: `${method} content`, fromLine: 1, lineCount: 1 },
        );
      });
      const element = createElement(request, true, {
        wikiSearch: true,
        ...testCase.options,
      });
      try {
        await typeQuery(element, "detail");
        submit(element);
        await waitForFast(() => expect(element.querySelectorAll("article")).toHaveLength(3));
        const buttons = [...element.querySelectorAll<HTMLButtonElement>("article > button")];
        expect(buttons).toHaveLength(1);
        expect(buttons[0]?.textContent).toContain(testCase.label);
        buttons[0]?.click();
        await waitForFast(() =>
          expect(request.mock.calls.some(([method]) => method === testCase.method)).toBe(true),
        );
        const getCalls = request.mock.calls.filter(([method]) =>
          ["agents.workspace.get", "wiki.get", "platformclaw.memory.get"].includes(method),
        );
        expect(getCalls.map(([method]) => method)).toEqual([testCase.method]);
      } finally {
        element.remove();
      }
    }
  });

  it("renders empty and retryable error states", async () => {
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce({
        agentId: "main",
        provider: "none",
        searchMode: "fts-only",
        results: [],
      });
    const element = createElement(request);
    try {
      await typeQuery(element, "missing");
      submit(element);
      await waitForFast(() => expect(element.textContent).toContain("index unavailable"));

      const retry = [...element.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      );
      retry?.click();
      await waitForFast(() => expect(element.textContent).toContain("No memories matched"));
      expect(element.textContent).toContain("keyword search");
      const summary = element.querySelector('.memory-memories__results-heading[role="status"]');
      expect(summary?.textContent).toContain("0 results");
      expect(summary?.getAttribute("aria-label")).toContain("0 results");
      expect(summary?.getAttribute("aria-live")).toBe("polite");
      expect(summary?.getAttribute("aria-atomic")).toBe("true");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      element.remove();
    }
  });

  it("loads a row file once, highlights the matched range, and keeps one row open", async () => {
    const second = { ...result, path: "memory/projects/Open Claw.md", startLine: 1, endLine: 1 };
    const request = vi.fn((method: string) => {
      if (method === "memory.search") {
        return Promise.resolve({
          agentId: "main",
          provider: "local",
          searchMode: "hybrid",
          results: [result, second],
        });
      }
      return Promise.resolve({
        agentId: "main",
        file: {
          path: result.path,
          name: "ada.md",
          size: 30,
          updatedAtMs: 1,
          mimeType: "text/plain",
          encoding: "utf8",
          content: "first\nmatched two\nmatched three\nfourth",
        },
      });
    });
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.querySelectorAll("article")).toHaveLength(2));

      const rows = element.querySelectorAll<HTMLButtonElement>("article > button");
      rows[0]?.click();
      await waitForFast(() =>
        expect(element.querySelector('[data-memory-match="true"]')).toBeTruthy(),
      );
      expect(element.querySelector('[data-memory-match="true"]')?.textContent).toBe(
        "matched two\nmatched three",
      );

      rows[0]?.click();
      rows[0]?.click();
      await element.updateComplete;
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(1);
      expect(request).toHaveBeenCalledWith("agents.workspace.get", {
        agentId: "main",
        path: result.path,
      });

      rows[1]?.click();
      await element.updateComplete;
      expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
      expect(rows[1]?.getAttribute("aria-expanded")).toBe("true");
      expect(rows[1]?.getAttribute("aria-controls")).toBe("memory-detail-1");
      expect(element.querySelector("#memory-detail-1")).not.toBeNull();
    } finally {
      element.remove();
    }
  });

  it("keeps session, QMD, absolute, and escaping paths non-expandable", async () => {
    const nonExpandable = [
      { ...result, path: "sessions/main/session-1.jsonl", source: "sessions" as const },
      { ...result, path: "sessions/main/mislabeled.jsonl" },
      { ...result, path: "qmd/workspace-main/memory/notes.md" },
      { ...result, path: "/external/MEMORY.md" },
      { ...result, path: "C:\\external\\MEMORY.md" },
      { ...result, path: "memory/../outside.md" },
    ];
    const request = vi.fn<Request>(() =>
      Promise.resolve({
        agentId: "main",
        provider: "local",
        searchMode: "hybrid",
        results: [{ ...result, path: "MEMORY.md" }, ...nonExpandable],
      }),
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "memory");
      submit(element);
      await waitForFast(() => expect(element.querySelectorAll("article")).toHaveLength(7));

      expect(element.querySelectorAll("article > button")).toHaveLength(1);
      expect(element.querySelectorAll("article > div.settings-row")).toHaveLength(6);
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.get"),
      ).toHaveLength(0);
    } finally {
      element.remove();
    }
  });

  it("keeps workspace read failures on the expanded row", async () => {
    const request = vi.fn((method: string) =>
      method === "memory.search"
        ? Promise.resolve({
            agentId: "main",
            provider: "local",
            searchMode: "hybrid",
            results: [result],
          })
        : Promise.reject(new Error("workspace file not found")),
    );
    const element = createElement(request);
    try {
      await typeQuery(element, "Ada");
      submit(element);
      await waitForFast(() => expect(element.querySelector("article > button")).not.toBeNull());
      element.querySelector<HTMLButtonElement>("article > button")?.click();

      await waitForFast(() =>
        expect(element.textContent).toContain(
          "Could not load this memory file: workspace file not found",
        ),
      );
      expect(element.textContent).toContain(result.snippet);
      expect(element.textContent).not.toContain("Memory search failed");
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
