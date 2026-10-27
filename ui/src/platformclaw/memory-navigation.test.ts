/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { deferred } from "../pages/config/memory-memories.test-support.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { loadPlatformClawLocale } from "./i18n.ts";
import "./memory-page.ts";

type MemoryPage = HTMLElement & { agentId: string; updateComplete: Promise<unknown> };

const hit = {
  source: "memory",
  path: "memory/release.md",
  score: 1,
  startLine: 1,
  endLine: 2,
  snippet: "Release checklist",
};
const response = (snippet = "Release checklist") => ({
  agentId: "personal",
  provider: "local",
  searchMode: "fts-only",
  results: [
    { ...hit, snippet },
    { ...hit, source: "wiki", path: "concepts/release.md", snippet: "Wiki result" },
  ],
});

function harness() {
  let revision = 1;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "agents.workspace.list") {
      return { entries: [] };
    }
    if (method === "agents.workspace.get") {
      return {
        file: {
          path: params.path,
          name: params.path,
          encoding: "utf8",
          content: `Private detail ${revision}`,
        },
      };
    }
    if (method === "memory.search") {
      return response();
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot = {
    client,
    phase: "connected",
    selfUser: { id: "user-a", name: "User A" },
    hello: {
      features: {
        methods: [
          "memory.search",
          "agents.workspace.get",
          "agents.workspace.list",
          "platformclaw.vault.snapshot",
        ],
      },
    },
  } as unknown as ApplicationGatewaySnapshot;
  const listeners = new Set<(value: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener: (value: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies Pick<ApplicationGateway, "snapshot" | "subscribe">;
  const context = { basePath: "", gateway, navigate: vi.fn() } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const scroller = document.createElement("main");
  scroller.id = "control-ui-main";
  scroller.append(provider);
  document.body.append(scroller);
  return {
    request,
    scroller,
    client,
    hello: snapshot.hello,
    revision: (value: number) => {
      revision = value;
    },
    update: (patch: Partial<ApplicationGatewaySnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    mount: (agentId = "personal") => {
      const page = document.createElement("platformclaw-memory-page") as MemoryPage;
      page.agentId = agentId;
      provider.append(page);
      return page;
    },
  };
}

async function search(page: MemoryPage, query: string, submit = true) {
  await waitForFast(() => expect(page.querySelector("#memory-search-input")).not.toBeNull());
  const input = page.querySelector<HTMLInputElement>("#memory-search-input")!;
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await (page.querySelector("openclaw-memory-memories") as MemoryPage).updateComplete;
  if (submit) {
    page
      .querySelector("form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(page.textContent).toContain("Release checklist"));
  }
}

beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Memory navigation intent", () => {
  it("restores query, filter, fresh selected document and scroll after page recreation", async () => {
    const h = harness();
    const original = h.mount();
    await search(original, "release");
    const filters = original.querySelector("wa-radio-group") as HTMLElement & { value: string };
    filters.value = "memory";
    filters.dispatchEvent(new Event("change", { bubbles: true }));
    await (original.querySelector("openclaw-memory-memories") as MemoryPage).updateComplete;
    original
      .querySelector<HTMLButtonElement>(
        'button[aria-haspopup="dialog"][aria-label="Release checklist"]',
      )!
      .click();
    await waitForFast(() => expect(original.textContent).toContain("Private detail 1"));
    h.scroller.scrollTop = 180;
    original.remove();
    h.scroller.scrollTop = 0;
    h.revision(2);
    const pending = deferred<ReturnType<typeof response>>();
    h.request.mockImplementationOnce(async (method) => {
      expect(method).toBe("memory.search");
      return pending.promise;
    });
    const returned = h.mount();
    await waitForFast(() =>
      expect(returned.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe(
        "release",
      ),
    );
    expect(returned.textContent).not.toContain("Private detail 1");
    expect(returned.textContent).not.toContain("Release checklist");
    pending.resolve(response("Fresh release result"));
    await waitForFast(() => expect(returned.textContent).toContain("Private detail 2"));
    expect(
      returned.querySelectorAll(".memory-memories__results .memory-memories__result"),
    ).toHaveLength(1);
    expect(
      (returned.querySelector("wa-radio-group") as HTMLElement & { value: string }).value,
    ).toBe("memory");
    expect(returned.textContent).toContain("Fresh release result");
    expect(h.request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(2);
    expect(
      h.request.mock.calls.filter(
        ([method, params]) => method === "agents.workspace.get" && params.path === hit.path,
      ),
    ).toHaveLength(2);
    expect(h.scroller.scrollTop).toBe(180);
  });

  it.each([false, true])(
    "retains an unsubmitted draft without sending a search (previous result: %s)",
    async (previousResult) => {
      const h = harness();
      const original = h.mount();
      if (previousResult) {
        await search(original, "release");
      }
      await search(original, "unfinished query", false);
      original.remove();
      const returned = h.mount();
      await waitForFast(() =>
        expect(returned.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe(
          "unfinished query",
        ),
      );
      expect(h.request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(
        previousResult ? 1 : 0,
      );
    },
  );

  it("shows a fresh requery failure without restoring old result or document bytes", async () => {
    const h = harness();
    const original = h.mount();
    await search(original, "release");
    original.remove();
    h.request.mockImplementationOnce(async (method) => {
      expect(method).toBe("memory.search");
      throw new Error("Access revoked");
    });
    const returned = h.mount();
    await waitForFast(() => expect(returned.textContent).toContain("Access revoked"));
    expect(returned.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("release");
    expect(returned.textContent).not.toContain("Release checklist");
    expect(returned.querySelector("[data-knowledge-document]")).toBeNull();
  });

  it("does not reopen a selected result outside the restored source filter", async () => {
    const h = harness();
    const original = h.mount();
    await search(original, "release");
    original
      .querySelector<HTMLButtonElement>(
        'button[aria-haspopup="dialog"][aria-label="Release checklist"]',
      )!
      .click();
    await waitForFast(() => expect(original.textContent).toContain("Private detail 1"));
    const filters = original.querySelector("wa-radio-group") as HTMLElement & { value: string };
    filters.value = "wiki";
    filters.dispatchEvent(new Event("change", { bubbles: true }));
    await (original.querySelector("openclaw-memory-memories") as MemoryPage).updateComplete;
    original.remove();
    const returned = h.mount();
    await waitForFast(() => expect(returned.textContent).toContain("Wiki result"));
    expect(
      returned.querySelectorAll(".memory-memories__results .memory-memories__result"),
    ).toHaveLength(1);
    expect(returned.textContent).not.toContain("Private detail 1");
    expect(returned.querySelector("#memory-detail-0")).toBeNull();
    expect(
      h.request.mock.calls.filter(
        ([method, params]) => method === "agents.workspace.get" && params.path === hit.path,
      ),
    ).toHaveLength(1);
  });

  it.each(["available", "denied"] as const)(
    "waits for the same owner's delayed capabilities before restoring results (%s)",
    async (capability) => {
      const h = harness();
      const original = h.mount();
      await search(original, "release");
      const filters = original.querySelector("wa-radio-group") as HTMLElement & { value: string };
      filters.value = "memory";
      filters.dispatchEvent(new Event("change", { bubbles: true }));
      await (original.querySelector("openclaw-memory-memories") as MemoryPage).updateComplete;
      original.remove();
      h.update({ hello: null, advertisedMethods: null });

      const returned = h.mount();
      await waitForFast(() =>
        expect(returned.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe(
          "release",
        ),
      );
      expect(returned.querySelector(".memory-memories__results")).toBeNull();
      expect(h.request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(1);
      h.update(
        capability === "available" ? { hello: h.hello } : { hello: null, advertisedMethods: [] },
      );
      if (capability === "available") {
        await waitForFast(() => expect(returned.textContent).toContain("Release checklist"));
        expect(
          returned.querySelectorAll(".memory-memories__results .memory-memories__result"),
        ).toHaveLength(1);
        expect(
          (returned.querySelector("wa-radio-group") as HTMLElement & { value: string }).value,
        ).toBe("memory");
        expect(h.request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(
          2,
        );
      } else {
        await waitForFast(() =>
          expect(returned.textContent).toContain("Update the gateway to search memories"),
        );
        expect(returned.querySelector(".memory-memories__results")).toBeNull();
        expect(h.request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(
          1,
        );
      }
    },
  );

  it.each(["agent", "client", "account", "logout"] as const)(
    "drops the intent when %s changes while unmounted",
    async (scope) => {
      const h = harness();
      const original = h.mount();
      await search(original, "release");
      original.remove();
      if (scope === "client") {
        h.update({ client: { request: h.request } as unknown as GatewayBrowserClient });
      } else if (scope === "account") {
        h.update({ selfUser: { id: "user-b", name: "User B" } });
      } else if (scope === "logout") {
        h.update({ client: null, phase: "stopped", selfUser: null });
        h.update({
          client: { request: h.request } as unknown as GatewayBrowserClient,
          phase: "connected",
          selfUser: { id: "user-a", name: "User A" },
        });
      }
      const returned = h.mount(scope === "agent" ? "another-agent" : "personal");
      await waitForFast(() =>
        expect(returned.querySelector("#memory-search-input")).not.toBeNull(),
      );
      expect(returned.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe("");
      expect(returned.textContent).not.toContain("Release checklist");
      expect(h.request.mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(1);
      if (scope === "agent") {
        returned.remove();
        const initialAgent = h.mount();
        await waitForFast(() =>
          expect(initialAgent.querySelector("#memory-search-input")).not.toBeNull(),
        );
        expect(initialAgent.querySelector<HTMLInputElement>("#memory-search-input")?.value).toBe(
          "",
        );
      }
    },
  );
});
