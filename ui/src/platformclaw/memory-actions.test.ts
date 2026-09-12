/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./memory-page.ts";
import { loadPlatformClawLocale } from "./i18n.ts";

type UpdatingElement = HTMLElement & { updateComplete: Promise<unknown> };
type MemoryPage = UpdatingElement & { agentId: string; initialTab: string };

beforeEach(async () => {
  await i18n.setLocale("en");
  await loadPlatformClawLocale();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function createPage(omitMethods: string[] = []) {
  let deleted = false;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "agents.workspace.get":
        return {
          file: {
            path: params.path,
            encoding: "utf8",
            content: "Private memory",
            contentHash: "reviewed-hash",
            missing: deleted,
          },
        };
      case "agents.workspace.list":
        return { entries: [] };
      case "memory.search":
        return { agentId: "personal", provider: "local", results: [] };
      case "wiki.search":
        return [
          {
            path: "concepts/runbook.md",
            title: "My runbook",
            kind: "concept",
            score: 1,
            snippet: "Approved source candidate",
          },
        ];
      case "wiki.document.get":
        return {
          path: "concepts/runbook.md",
          title: "My runbook",
          displayContent: "# My runbook\nCheck the service first.",
          sourceContent: "# My runbook\nCheck the service first.",
          editMode: "body",
        };
      case "platformclaw.memory.lifecycle":
        return {
          scopes: [
            { kind: "group", id: "group", name: "Platform", canRead: true, canAdminister: false },
          ],
          personalTargets: [
            { kind: "group", scopeId: "group", scopeName: "Platform", mode: "request" },
          ],
          claims: [],
          submitted: [],
          reviewable: [],
          canApproveGlobal: false,
        };
      case "memory.delete":
        deleted = true;
        return { deleted: true, indexesRefreshed: true, wikiRefreshed: true };
      default:
        throw new Error(`Unexpected request: ${method}`);
    }
  });
  const context = {
    basePath: "",
    navigate: vi.fn(),
    gateway: {
      snapshot: {
        client: { request },
        phase: "connected",
        hello: {
          features: {
            methods: [
              "memory.search",
              "memory.delete",
              "agents.workspace.list",
              "agents.workspace.get",
              "wiki.search",
              "wiki.get",
              "wiki.document.get",
              "wiki.delete",
              "platformclaw.memory.lifecycle",
              "platformclaw.memory.promotion.submit",
            ].filter((method) => !omitMethods.includes(method)),
          },
        },
      },
      subscribe: () => () => {},
    },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("platformclaw-memory-page") as MemoryPage;
  page.agentId = "personal";
  page.initialTab = "memory";
  provider.append(page);
  document.body.append(provider);
  return { page, request };
}

async function chooseMenuAction(page: Element, action = "share") {
  await waitForFast(() =>
    expect(page.querySelector("platformclaw-memory-item-menu wa-dropdown")).not.toBeNull(),
  );
  page.querySelector("platformclaw-memory-item-menu wa-dropdown")!.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      cancelable: true,
      detail: { item: page.querySelector(`wa-dropdown-item[value="${action}"]`) },
    }),
  );
}

describe("personal memory action integration", () => {
  it.each([
    { omitted: ["platformclaw.memory.promotion.submit"], expected: ["delete"] },
    { omitted: ["wiki.delete"], expected: ["share"] },
    { omitted: [], expected: ["share", "delete"] },
  ])("gates Wiki sharing and deletion independently ($expected)", async ({ omitted, expected }) => {
    const { page, request } = createPage(omitted);
    await waitForFast(() => expect(page.querySelector("#memory-search-input")).not.toBeNull());
    const input = page.querySelector<HTMLInputElement>("#memory-search-input")!;
    input.value = "runbook";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await (page.querySelector("openclaw-memory-memories") as UpdatingElement).updateComplete;
    page
      .querySelector("form")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(page.textContent).toContain("My runbook"));
    const row = Array.from(page.querySelectorAll("article")).find((entry) =>
      entry.textContent?.includes("My runbook"),
    )!;
    row.querySelector<HTMLButtonElement>(".memory-item-actions")!.click();
    await waitForFast(() =>
      expect(
        Array.from(page.querySelectorAll("wa-dropdown-item")).map((item) =>
          item.getAttribute("value"),
        ),
      ).toEqual(expected),
    );
    expect(
      request.mock.calls.some(
        ([method]) => method.endsWith(".delete") || method.includes("promotion.submit"),
      ),
    ).toBe(false);
  });

  it.each(["contextmenu", "ellipsis"])(
    "opens a prefilled application from %s without submitting",
    async (action) => {
      const { page, request } = createPage();
      await waitForFast(() => expect(page.querySelector("#memory-search-input")).not.toBeNull());
      const memories = page.querySelector("openclaw-memory-memories") as UpdatingElement;
      const input = page.querySelector<HTMLInputElement>("#memory-search-input")!;
      input.value = "runbook";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await memories.updateComplete;
      memories
        .querySelector("form")!
        .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() => expect(memories.textContent).toContain("My runbook"));
      const row = Array.from(memories.querySelectorAll("article")).find((entry) =>
        entry.textContent?.includes("My runbook"),
      )!;
      expect(row).toBeDefined();
      if (action === "contextmenu") {
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 30,
            clientY: 40,
          }),
        );
      } else {
        row.querySelector<HTMLButtonElement>(".memory-item-actions")!.click();
      }
      await chooseMenuAction(page);
      await waitForFast(() => {
        const form = page.querySelector("openclaw-modal-dialog openclaw-memory-promotions");
        expect(form).not.toBeNull();
        expect(
          Array.from(form!.querySelectorAll("textarea")).map((entry) => entry.value),
        ).toContain("# My runbook\nCheck the service first.");
      });
      expect(request).toHaveBeenCalledWith(
        "wiki.document.get",
        expect.objectContaining({ agentId: "personal", lookup: "concepts/runbook.md" }),
      );
      expect(
        request.mock.calls.some(
          ([method]) => method.includes("promotion.submit") || method.includes("promotion.publish"),
        ),
      ).toBe(false);
      expect(page.querySelector("platformclaw-memory-item-menu")).toBeNull();
    },
  );

  it("deletes only after preview confirmation and refreshes the browse list", async () => {
    const { page, request } = createPage();
    await waitForFast(() =>
      expect(page.querySelector("article .memory-item-actions")).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("article .memory-item-actions")!.click();
    await chooseMenuAction(page, "delete");
    await waitForFast(() =>
      expect(
        page
          .querySelector("platformclaw-memory-delete-dialog .wiki-document__reader")
          ?.textContent?.trim(),
      ).toBe("Private memory"),
    );
    expect(request.mock.calls.some(([method]) => method === "memory.delete")).toBe(false);
    const before = request.mock.calls.filter(
      ([method]) => method === "agents.workspace.list",
    ).length;
    page
      .querySelector<HTMLButtonElement>("platformclaw-memory-delete-dialog button.danger")!
      .click();
    await waitForFast(() => {
      expect(page.querySelector("platformclaw-memory-delete-dialog")).toBeNull();
      expect(
        request.mock.calls.filter(([method]) => method === "agents.workspace.list").length,
      ).toBeGreaterThan(before);
    });
    expect(request).toHaveBeenCalledWith("memory.delete", {
      agentId: "personal",
      path: "MEMORY.md",
      expectedContentHash: "reviewed-hash",
    });
    await waitForFast(() => expect(page.querySelector("article .memory-item-actions")).toBeNull());
  });
});
