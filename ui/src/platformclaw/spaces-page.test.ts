import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import "./spaces-page.ts";
const space = {
  id: "work-a",
  name: "Mixed Signal Project",
  role: "owner",
  revision: 1,
  agentId: "space-one",
};
const page = {
  id: "issue-a",
  spaceId: space.id,
  parentId: null,
  title: "Timing issue",
  body: "Shared notes",
  revision: 1,
  createdBy: "alice",
  updatedAt: 100,
};
const member = { userId: "alice", accountId: "alice", displayName: "Alice", role: "owner" };
const roots: HTMLElement[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});
beforeEach(async () => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  await i18n.setLocale("en");
  await loadAllPlatformClawLocales();
});
type Element = HTMLElement & {
  context: unknown;
  updateComplete: Promise<unknown>;
  selectSpace: (id: string) => Promise<void>;
  selectPage: (page: unknown) => void;
  refresh: () => Promise<void>;
};
async function mount(role = "owner") {
  const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method.endsWith(".list")) {
      return [{ ...space, role }];
    }
    if (method.endsWith(".get")) {
      return { space: { ...space, role }, pages: [page], members: [member] };
    }
    if (method.endsWith(".history")) {
      return {
        messages: [
          { id: "m1", role: "user", text: "Earlier question", timestamp: 100, authorName: "Alice" },
        ],
      };
    }
    if (method.endsWith(".people")) {
      return [{ userId: "bob", accountId: "bob", displayName: "Bob" }];
    }
    if (method.endsWith(".search")) {
      return { results: [] };
    }
    return { updated: true };
  });
  const gateway = {
    snapshot: { phase: "connected", client: { request } },
    subscribe: () => () => {},
    subscribeEvents: (fn: (event: { event: string; payload?: unknown }) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const element = document.createElement("platformclaw-spaces-page") as Element;
  element.context = { gateway };
  document.body.append(element);
  roots.push(element);
  await element.updateComplete;
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("platformclaw.spaces.list", {}));
  await element.selectSpace(space.id);
  element.selectPage(page);
  await element.updateComplete;
  await vi.waitFor(() => expect(element.textContent).toContain("Earlier question"));
  return {
    element,
    request,
    gateway,
    emit: (event: { event: string; payload?: unknown }) => listeners.forEach((fn) => fn(event)),
  };
}
function button(element: HTMLElement, text: string) {
  const found = [...element.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text,
  );
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}
async function beginEdit(element: Element) {
  if (
    ![...element.querySelectorAll("button")].some(
      (item) => item.textContent?.trim() === "Edit page",
    )
  ) {
    button(element, "Notes").click();
    await element.updateComplete;
  }
  button(element, "Edit page").click();
  await element.updateComplete;
}
function input(element: HTMLElement, label: string, value: string) {
  const field = [...element.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(label))
    ?.querySelector("input,textarea") as HTMLInputElement;
  expect(field).toBeDefined();
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
describe("Space issue page UX", () => {
  it("keeps a rejected answer visible across invalidation, a late acknowledgment, and another final", async () => {
    const { element, request, emit } = await mount();
    const original = request.getMockImplementation()!;
    let release!: (value: unknown) => void;
    request.mockImplementation(async (method) =>
      method.endsWith(".send")
        ? await new Promise((resolve) => {
            release = resolve;
          })
        : original(method),
    );
    const draft = element.querySelector<HTMLTextAreaElement>("#pc-space-draft")!;
    draft.value = "One more shared question";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    button(element, "Send to Space").click();
    await vi.waitFor(() => expect(release).toBeDefined());
    emit({
      event: "platformclaw.space.changed",
      payload: { spaceId: space.id, pageId: page.id, state: "error" },
    });
    await element.updateComplete;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "The shared answer failed. Retry your question.",
    );
    const gets = request.mock.calls.filter(([method]) => method.endsWith(".get")).length;
    emit({ event: "platformclaw.spaces.invalidated", payload: {} });
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method.endsWith(".get")).length,
      ).toBeGreaterThan(gets),
    );
    await vi.waitFor(() => expect(element.textContent).toContain("Earlier question"));
    const histories = request.mock.calls.filter(([method]) => method.endsWith(".history")).length;
    release({ status: "started" });
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method.endsWith(".history")).length,
      ).toBeGreaterThan(histories),
    );
    await element.updateComplete;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "The shared answer failed. Retry your question.",
    );
    expect(element.querySelector('[role="status"]')).toBeNull();
    emit({
      event: "platformclaw.space.changed",
      payload: { spaceId: space.id, pageId: page.id, state: "final" },
    });
    await element.updateComplete;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "The shared answer failed. Retry your question.",
    );
  });
  it("renders assistant markdown without unsafe HTML, remote images, or inert code-copy controls", async () => {
    const { element, request } = await mount();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method.endsWith(".history")
        ? {
            messages: [
              {
                id: "markdown",
                role: "assistant",
                text: "**Shared decision**\n\n```ts\nconst shared = true;\n```\n\n<script>alert(1)</script>\n\n![tracking](https://example.invalid/tracking.png)",
              },
            ],
          }
        : original(method),
    );
    element.selectPage(page);
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-message-body strong")?.textContent).toBe(
        "Shared decision",
      ),
    );
    expect(element.querySelector(".pc-space-message-body pre")?.textContent).toContain(
      "const shared = true;",
    );
    expect(element.querySelector(".pc-space-message-body script")).toBeNull();
    expect(element.querySelector(".pc-space-message-body img")).toBeNull();
    expect(element.querySelector(".pc-space-message-body button")).toBeNull();
  });
  it("opens notes and members beside the conversation and returns focus when dismissed", async () => {
    const { element } = await mount();
    expect(element.querySelector(".pc-space-conversation")).not.toBeNull();
    expect(element.querySelector(".pc-space-composer-dock textarea")).not.toBeNull();
    expect(element.querySelector(".pc-space-panel")).toBeNull();
    expect(element.textContent).not.toContain("Shared notes");
    button(element, "Notes").click();
    await element.updateComplete;
    expect(element.querySelector(".pc-space-panel")?.textContent).toContain("Shared notes");
    expect(element.querySelector(".pc-space-conversation")).not.toBeNull();
    button(element, "Members and access").click();
    await element.updateComplete;
    expect(element.querySelector(".pc-space-panel")?.textContent).toContain(
      "Exact employee account ID",
    );
    expect(element.querySelector(".pc-space-notes")).toBeNull();
    button(element, "Close panel").click();
    await element.updateComplete;
    expect(element.querySelector(".pc-space-panel")).toBeNull();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(button(element, "Members and access")),
    );
  });
  it("sends on Enter once while preserving Shift+Enter and composition input", async () => {
    const { element, request } = await mount();
    let release!: (value: unknown) => void;
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method.endsWith(".send")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original(method),
    );
    const composer = element.querySelector<HTMLTextAreaElement>("#pc-space-draft")!;
    composer.value = "A shared question";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(request.mock.calls.some(([method]) => method.endsWith(".send"))).toBe(false);
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(request.mock.calls.filter(([method]) => method.endsWith(".send"))).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      "platformclaw.spaces.chat.send",
      expect.objectContaining({ pageId: page.id, message: "A shared question" }),
    );
    release({ accepted: true });
    await vi.waitFor(() => expect(composer.value).toBe(""));
  });
  it("cancels an editor panel on Escape without saving", async () => {
    const { element, request } = await mount();
    await beginEdit(element);
    input(element, "Title", "Cancelled panel draft");
    element
      .querySelector(".pc-spaces")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await element.updateComplete;
    expect(element.querySelector(".pc-space-panel")).toBeNull();
    expect(element.querySelector(".pc-space-conversation")).not.toBeNull();
    expect(request.mock.calls.some(([method]) => method.endsWith("page.save"))).toBe(false);
  });
  it("shows per-issue shared context and cancels page edits without mutation", async () => {
    const { element, request } = await mount();
    expect(element.textContent).toContain("all Space members");
    expect(element.querySelector(".pc-space-panel")).toBeNull();
    await beginEdit(element);
    input(element, "Title", "Unsaved");
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(element.textContent).toContain("Timing issue");
    expect(request.mock.calls.some(([method]) => method.endsWith("page.save"))).toBe(false);
  });
  it("preserves the draft's base revision across revalidation and keeps a rejected draft editable", async () => {
    const { element, request, emit } = await mount();
    await beginEdit(element);
    input(element, "Title", "My draft");
    input(element, "Issue description / notes", "My notes");
    const remotePage = { ...page, title: "Remote title", body: "Remote notes", revision: 2 };
    const original = request.getMockImplementation()!;
    let saves = 0;
    request.mockImplementation(async (method) => {
      if (method.endsWith(".get")) {
        return { space, pages: [remotePage], members: [member] };
      }
      if (method.endsWith(".save")) {
        if (saves++ === 0) {
          throw new Error("Page revision conflict");
        }
        return { ...remotePage, revision: 3 };
      }
      return original(method);
    });
    emit({ event: "platformclaw.spaces.invalidated", payload: {} });
    await vi.waitFor(() => expect(element.textContent).toContain("Remote title"));
    expect(element.querySelector<HTMLInputElement>("[data-title]")!.value).toBe("My draft");
    button(element, "Save").click();
    await vi.waitFor(() =>
      expect(element.querySelector("[role=alert]")?.textContent).toContain(
        "Page revision conflict",
      ),
    );
    expect(request).toHaveBeenCalledWith("platformclaw.spaces.page.save", {
      spaceId: space.id,
      pageId: page.id,
      title: "My draft",
      body: "My notes",
      expectedRevision: 1,
    });
    expect(element.querySelector<HTMLInputElement>("[data-title]")!.value).toBe("My draft");
    expect(element.querySelector<HTMLTextAreaElement>(".pc-space-editor textarea")!.value).toBe(
      "My notes",
    );
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(element.textContent).toContain("Remote notes");
    await beginEdit(element);
    button(element, "Save").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.spaces.page.save", {
        spaceId: space.id,
        pageId: page.id,
        title: "Remote title",
        body: "Remote notes",
        expectedRevision: 2,
      }),
    );
    await vi.waitFor(() => expect(element.querySelector("[data-title]")).toBeNull());
  });
  it("starts a fresh edit base after explicit Space navigation", async () => {
    const { element, request } = await mount();
    await beginEdit(element);
    input(element, "Title", "Discarded draft");
    const otherSpace = { ...space, id: "work-b", name: "Other project" };
    const otherPage = {
      ...page,
      id: "issue-b",
      spaceId: otherSpace.id,
      title: "Other issue",
      revision: 7,
    };
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) => {
      if (method.endsWith(".get")) {
        return { space: otherSpace, pages: [otherPage], members: [member] };
      }
      if (method.endsWith(".save")) {
        return { ...otherPage, revision: 8 };
      }
      return original(method);
    });
    await element.selectSpace(otherSpace.id);
    element.selectPage(otherPage);
    await element.updateComplete;
    expect(element.querySelector("[data-title]")).toBeNull();
    await beginEdit(element);
    expect(element.querySelector<HTMLInputElement>("[data-title]")!.value).toBe(otherPage.title);
    button(element, "Save").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.spaces.page.save", {
        spaceId: otherSpace.id,
        pageId: otherPage.id,
        title: otherPage.title,
        body: otherPage.body,
        expectedRevision: 7,
      }),
    );
    await vi.waitFor(() => expect(element.querySelector("[data-title]")).toBeNull());
  });
  it("clears an editor draft when revalidation downgrades access to viewer", async () => {
    const { element, request, emit } = await mount();
    await beginEdit(element);
    input(element, "Title", "Private unfinished draft");
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method.endsWith(".get")
        ? { space: { ...space, role: "viewer" }, pages: [page], members: [member] }
        : original(method),
    );
    emit({ event: "platformclaw.spaces.invalidated", payload: {} });
    await vi.waitFor(() => expect(element.querySelector("[data-title]")).toBeNull());
    expect(element.textContent).not.toContain("Private unfinished draft");
    expect(request.mock.calls.some(([method]) => method.endsWith("page.save"))).toBe(false);
  });
  it("keeps viewers read-only and clears content after membership loss", async () => {
    const { element, request, emit } = await mount("viewer");
    expect(
      [...element.querySelectorAll("button")].some(
        (item) => item.textContent?.trim() === "Send to Space",
      ),
    ).toBe(false);
    request.mockImplementation(async (method: string) =>
      method.endsWith(".list") ? [] : Promise.reject(new Error("Space unavailable")),
    );
    emit({ event: "platformclaw.spaces.invalidated", payload: {} });
    await vi.waitFor(() => expect(element.textContent).not.toContain("Earlier question"));
    expect(element.textContent).toContain("no longer available");
  });
  it("requires visible employee confirmation before inviting and lets the user cancel", async () => {
    const { element, request } = await mount();
    button(element, "Members and access").click();
    await element.updateComplete;
    input(element, "Exact employee account ID", "bob");
    button(element, "Find employee").click();
    await vi.waitFor(() => expect(element.textContent).toContain("Invite Bob"));
    button(element, "Invite Bob (bob)").click();
    await element.updateComplete;
    expect(element.textContent).toContain("existing and future");
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(request.mock.calls.some(([method]) => method.endsWith("member.set"))).toBe(false);
  });
  it("does not render a retired browser identity's late history response", async () => {
    const { element, request, gateway } = await mount();
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          release = resolve;
        }),
    );
    element.selectPage(page);
    await element.updateComplete;
    gateway.snapshot.client = { request: vi.fn(async () => []) };
    gateway.snapshot.phase = "stopped";
    release({ messages: [{ id: "m2", role: "assistant", text: "Old identity secret" }] });
    await element.updateComplete;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(element.textContent).not.toContain("Old identity secret");
  });
  it("keeps the committed role selected after cancelling a role change", async () => {
    const { element, request } = await mount();
    button(element, "Members and access").click();
    await element.updateComplete;
    const select = element.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("owner");
    select.value = "viewer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(select.value).toBe("owner");
    expect(request.mock.calls.some(([method]) => method.endsWith("member.set"))).toBe(false);
  });
  it("offers a root issue even when another issue is selected", async () => {
    const { element } = await mount();
    expect(button(element, "New issue page")).toBeDefined();
    button(element, "Notes").click();
    await element.updateComplete;
    expect(button(element, "New child issue")).toBeDefined();
  });
});
