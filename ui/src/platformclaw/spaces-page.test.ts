import { assert, describe, expect, it, vi } from "vitest";
import type { SpaceConversation } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import {
  beginEdit,
  button,
  input,
  member,
  mount,
  page,
  setupSpacePageTests,
  space,
} from "./spaces-page.test-support.ts";
setupSpacePageTests();
describe("Space issue page UX", () => {
  it("preserves only authored whitespace in user message bubbles", async () => {
    const { element, request } = await mount();
    expect(
      element.querySelector(".pc-space-message--user .pc-space-message-body")?.textContent,
    ).toBe("Earlier question");
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method.endsWith(".history")
        ? {
            messages: [
              {
                id: "multiline",
                role: "user",
                authorName: "Alice",
                text: "First line\n  Indented second line",
              },
            ],
          }
        : original(method),
    );
    element.selectPage(page);
    await vi.waitFor(() =>
      expect(
        element.querySelector(".pc-space-message--user .pc-space-message-body")?.textContent,
      ).toBe("First line\n  Indented second line"),
    );
  });
  it.each(["owner", "editor", "viewer"])("keeps legacy Q&A read-only for a %s", async (role) => {
    const { element, request } = await mount(role);
    expect(element.querySelector(".pc-space-conversation textarea")).toBeNull();
    expect(element.querySelector("openclaw-chat-pane")).toBeNull();
    expect(element.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      "Shared Q&A",
    );
    expect(request.mock.calls.some(([method]) => method.endsWith(".send"))).toBe(false);
  });
  it.each(["owner", "viewer"])(
    "preserves %s read-only conversations through shared tabs",
    async (role) => {
      const own: SpaceConversation = {
        id: "own-conversation",
        spaceId: space.id,
        pageId: page.id,
        title: "Own investigation",
        ownerId: "alice",
        ownerName: "Alice",
        agentId: "personal-alice",
        sessionKey: "agent:personal-alice:space-session:00000000-0000-4000-8000-000000000004",
        createdAt: 100,
        canWrite: role === "viewer",
      };
      const { element, request } = await mount(role, [
        own,
        { ...own, id: "peer-conversation", title: "Private peer conversation", ownerId: "bob" },
        { ...own, id: "other-page-conversation", pageId: "other-page", title: "Other issue" },
      ]);
      const group = element.querySelector("wa-tab-group.pc-space-conversation-tabs")!;
      const personalTab = group.querySelector<HTMLElement>('wa-tab[panel="own-conversation"]')!;
      const sharedTab = group.querySelector<HTMLElement>('wa-tab[panel="shared"]')!;
      const panel = element.querySelector('[role="tabpanel"]')!;
      expect(group.querySelectorAll("wa-tab")).toHaveLength(2);
      expect(personalTab.getAttribute("aria-controls")).toBe(panel.id);
      expect(panel.getAttribute("aria-labelledby")).toBe(personalTab.id);
      expect(personalTab.textContent).toContain("Read-only");
      expect(button(element, "New conversation").disabled).toBe(role === "viewer");
      const pane = element.querySelector("platformclaw-space-conversation-history");
      expect(pane).not.toBeNull();
      expect(element.querySelector("openclaw-chat-pane")).toBeNull();

      const calls = request.mock.calls.length;
      personalTab.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      group.dispatchEvent(
        new CustomEvent("wa-tab-show", { detail: { name: "shared" }, bubbles: true }),
      );
      sharedTab.click();
      await element.updateComplete;
      expect(request.mock.calls).toHaveLength(calls);
      expect(element.querySelector("platformclaw-space-conversation-history")).toBe(pane);
      expect(panel.getAttribute("aria-labelledby")).toBe(personalTab.id);

      sharedTab.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await element.updateComplete;
      await vi.waitFor(() => expect(element.textContent).toContain("Earlier question"));
      expect(element.querySelector("openclaw-chat-pane")).toBeNull();
      expect(element.querySelector("platformclaw-space-conversation-history")).toBeNull();
      expect(panel.getAttribute("aria-labelledby")).toBe(sharedTab.id);
      expect(new URL(location.href).searchParams.get("conversation")).toBe("shared");

      personalTab.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
      await element.updateComplete;
      expect(panel.getAttribute("aria-labelledby")).toBe(personalTab.id);
      expect(new URL(location.href).searchParams.get("conversation")).toBe(own.id);
      expect(element.querySelector("platformclaw-space-conversation-history")).not.toBeNull();
      expect(element.querySelector("openclaw-chat-pane")).toBeNull();
      if (role === "owner") {
        await beginEdit(element);
        expect(
          [...group.querySelectorAll("wa-tab")].every((tab) => tab.hasAttribute("disabled")),
        ).toBe(true);
        sharedTab.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
        );
        sharedTab.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
        await element.updateComplete;
        expect(new URL(location.href).searchParams.get("conversation")).toBe(own.id);
        button(element, "Cancel").click();
        await element.updateComplete;
        expect(group.querySelector("wa-tab[disabled]")).toBeNull();
      }
    },
  );
  it("loads older own read-only history once per click and rejects late pages after navigation", async () => {
    const own: SpaceConversation = {
      id: "own-conversation",
      spaceId: space.id,
      pageId: page.id,
      title: "Own investigation",
      ownerId: "alice",
      ownerName: "Alice",
      agentId: "personal-alice",
      sessionKey: "agent:personal-alice:space-session:00000000-0000-4000-8000-000000000004",
      createdAt: 100,
      canWrite: false,
    };
    const { element, request } = await mount("viewer", [own]);
    const original = request.getMockImplementation()!;
    const message = (id: number) => ({
      role: "user",
      content: [{ type: "text", text: `Own message ${id}` }],
      __openclaw: { seq: id },
    });
    let release!: (value: unknown) => void;
    request.mockImplementation(async (method, params) => {
      if (!method.endsWith("conversation.history")) {
        return original(method, params);
      }
      if (params?.offset !== undefined) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return {
        messages: [message(3)],
        hasMore: true,
        nextOffset: 100,
        totalMessages: 201,
        sessionId: "session-a",
      };
    });
    element.selectPage(page);
    await vi.waitFor(() => expect(button(element, "Load older messages")).toBeDefined());
    const older = button(element, "Load older messages");
    older.click();
    older.click();
    await vi.waitFor(() => expect(release).toBeDefined());
    const olderRequests = () =>
      request.mock.calls.filter(
        ([method, params]) =>
          method.endsWith("conversation.history") && params?.offset !== undefined,
      );
    expect(olderRequests()).toHaveLength(1);
    expect(olderRequests()[0]?.[1]).toEqual({
      spaceId: space.id,
      conversationId: own.id,
      offset: 100,
    });
    release({
      messages: [message(2), message(3)],
      hasMore: true,
      nextOffset: 200,
      totalMessages: 201,
      sessionId: "session-a",
    });
    await vi.waitFor(() =>
      expect(element.querySelector("platformclaw-space-conversation-history")).toHaveProperty(
        "messages",
        [message(2), message(3)],
      ),
    );
    button(element, "Load older messages").click();
    expect(olderRequests()).toHaveLength(2);
    const shared = element.querySelector<HTMLElement>('wa-tab[panel="shared"]')!;
    shared.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    release({ messages: [message(1)], hasMore: false, sessionId: "session-a" });
    await vi.waitFor(() => expect(element.textContent).toContain("Earlier question"));
    expect(element.querySelector("platformclaw-space-conversation-history")).toBeNull();
    expect(element.querySelector("openclaw-chat-pane")).toBeNull();
    expect(
      request.mock.calls.some(([method]) => /(?:send|abort|reset|rewind|delete)$/.test(method)),
    ).toBe(false);
  });
  it("reuses a creation request after an ambiguous failure and blocks repeated pending submits", async () => {
    const { element, request } = await mount();
    const original = request.getMockImplementation()!;
    let rejectCreation!: (error: Error) => void;
    request.mockImplementation(async (method) =>
      method.endsWith("conversation.create")
        ? new Promise((_resolve, reject) => {
            rejectCreation = reject;
          })
        : original(method),
    );
    button(element, "New conversation").click();
    await element.updateComplete;
    input(element, "Title", "Trace investigation");
    await element.updateComplete;
    const form = element.querySelector<HTMLFormElement>(".pc-space-editor")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const creations = () =>
      request.mock.calls.filter(([method]) => method.endsWith("conversation.create"));
    expect(creations()).toHaveLength(1);
    const firstCall = creations()[0];
    assert.isDefined(firstCall);
    const first = firstCall[1];
    expect(first).toMatchObject({
      spaceId: space.id,
      pageId: page.id,
      title: "Trace investigation",
      requestId: expect.any(String),
    });
    rejectCreation(new Error("Connection lost before acknowledgment"));
    await vi.waitFor(() =>
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(
        "Connection lost before acknowledgment",
      ),
    );
    expect(element.querySelector<HTMLInputElement>("[data-title]")!.value).toBe(
      "Trace investigation",
    );
    button(element, "Create conversation").click();
    await vi.waitFor(() => expect(creations()).toHaveLength(2));
    const retryCall = creations()[1];
    assert.isDefined(retryCall);
    expect(retryCall[1]).toEqual(first);
    rejectCreation(new Error("Service still unavailable"));
    await vi.waitFor(() =>
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(
        "Service still unavailable",
      ),
    );
  });
  it("does not adopt a late conversation creation after navigating to a different Space", async () => {
    const { element, request } = await mount();
    const original = request.getMockImplementation()!;
    const otherSpace = { ...space, id: "work-b", name: "Other project" };
    let release!: (value: unknown) => void;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith("conversation.create")) {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      if (method.endsWith(".get") && params?.spaceId === otherSpace.id) {
        return {
          space: otherSpace,
          pages: [],
          members: [member],
          conversations: [],
          currentUserId: "alice",
        };
      }
      return original(method, params);
    });
    button(element, "New conversation").click();
    await element.updateComplete;
    button(element, "Create conversation").click();
    await vi.waitFor(() => expect(release).toBeDefined());
    await element.selectSpace(otherSpace.id);
    release({
      id: "late-conversation",
      spaceId: space.id,
      pageId: page.id,
      title: "Old Space conversation",
      ownerId: "alice",
      ownerName: "Alice",
      agentId: "personal-alice",
      sessionKey: "agent:personal-alice:space-session:00000000-0000-4000-8000-000000000002",
      createdAt: 100,
      canWrite: true,
    });
    await element.updateComplete;
    await vi.waitFor(() => expect(button(element, "Create Space").disabled).toBe(false));
    expect(element.textContent).toContain("Other project");
    expect(element.textContent).not.toContain("Old Space conversation");
    expect(element.querySelector("openclaw-chat-pane")).toBeNull();
  });
  it("does not expose another user's personal tab even if a snapshot contains it", async () => {
    const { element, request } = await mount();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method.endsWith(".get")
        ? {
            space,
            pages: [page],
            members: [member],
            currentUserId: "alice",
            conversations: [
              {
                id: "peer-conversation",
                spaceId: space.id,
                pageId: page.id,
                title: "Bob's personal conversation",
                ownerId: "bob",
                ownerName: "Bob",
                agentId: "personal-bob",
                sessionKey: "agent:personal-bob:space-session:00000000-0000-4000-8000-000000000003",
                createdAt: 100,
                canWrite: true,
              },
            ],
          }
        : original(method),
    );
    history.replaceState(
      null,
      "",
      `/?space=${space.id}&page=${page.id}&conversation=peer-conversation`,
    );
    await element.selectSpace(space.id);
    await element.updateComplete;
    expect(element.textContent).toContain("Earlier question");
    expect(element.textContent).not.toContain("Bob's personal conversation");
    expect(element.querySelector("openclaw-chat-pane")).toBeNull();
    expect(request.mock.calls.some(([method]) => method.endsWith("conversation.history"))).toBe(
      false,
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
    expect(element.querySelector(".pc-space-conversation textarea")).toBeNull();
    expect(element.querySelector(".pc-space-panel")).toBeNull();
    expect(element.textContent).not.toContain("Shared notes");
    button(element, "Notes").click();
    await element.updateComplete;
    expect(element.querySelector(".pc-space-panel")?.textContent).toContain("Shared notes");
    expect(element.querySelector(".pc-space-conversation")).not.toBeNull();
    button(element, "Members and access").click();
    await element.updateComplete;
    expect(element.querySelector(".pc-space-panel")?.textContent).toContain(
      "Employee name or account ID",
    );
    expect(element.querySelector(".pc-space-notes")).toBeNull();
    button(element, "Close panel").click();
    await element.updateComplete;
    expect(element.querySelector(".pc-space-panel")).toBeNull();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(button(element, "Members and access")),
    );
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
    expect(element.textContent).toContain("Earlier shared Q&A is read-only");
    expect(element.querySelector(".pc-space-panel")).toBeNull();
    await beginEdit(element);
    input(element, "Title", "Unsaved");
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(element.textContent).toContain("Timing issue");
    expect(request.mock.calls.some(([method]) => method.endsWith("page.save"))).toBe(false);
  });
  it("retains a rejected draft across Refresh until explicit saved-revision replacement", async () => {
    const { element, request } = await mount();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await beginEdit(element);
    input(element, "Title", "My draft");
    input(element, "Issue description / notes", "My notes");
    let remotePage = { ...page, title: "Remote title", body: "Remote notes", revision: 2 };
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".get")) {
        return {
          space,
          pages: [remotePage],
          members: [member],
          conversations: [],
          currentUserId: "alice",
        };
      }
      if (method.endsWith(".save")) {
        if (params?.expectedRevision !== remotePage.revision) {
          throw new Error("Space changed; reload before retrying");
        }
        remotePage = {
          ...remotePage,
          title: String(params.title),
          body: String(params.body),
          revision: remotePage.revision + 1,
        };
        return remotePage;
      }
      return original(method, params);
    });
    button(element, "Save").click();
    await vi.waitFor(() =>
      expect(element.querySelector("[role=alert]")?.textContent).toContain(
        "reload before retrying",
      ),
    );
    button(element, "Refresh").click();
    await vi.waitFor(() =>
      expect(element.querySelector(".pc-space-heading")?.textContent).toContain("Remote title"),
    );
    expect(element.querySelector<HTMLInputElement>("[data-title]")!.value).toBe("My draft");
    expect(element.querySelector<HTMLTextAreaElement>(".pc-space-editor textarea")!.value).toBe(
      "My notes",
    );
    button(element, "Save").click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method.endsWith("page.save"))).toHaveLength(2),
    );
    expect(
      request.mock.calls
        .filter(([method]) => method.endsWith("page.save"))
        .every(([, params]) => params?.expectedRevision === 1),
    ).toBe(true);
    await vi.waitFor(() => expect(button(element, "Save").disabled).toBe(false));
    button(element, "Copy draft").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("My draft\n\nMy notes"));
    const details = element.querySelector<HTMLDetailsElement>(".pc-space-draft-recovery details")!;
    details.open = true;
    expect(details.textContent).toContain("Remote notes");
    button(element, "Keep editing").click();
    expect(details.open).toBe(false);
    expect(element.querySelector<HTMLInputElement>("[data-title]")!.value).toBe("My draft");
    details.open = true;
    details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(details.open).toBe(false);
    expect(element.querySelector(".pc-space-editor")).not.toBeNull();
    details.open = true;
    const replace = button(element, "Discard draft and use saved revision");
    replace.click();
    replace.click();
    await element.updateComplete;
    expect(element.querySelector<HTMLInputElement>("[data-title]")!.value).toBe("Remote title");
    expect(element.querySelector<HTMLTextAreaElement>(".pc-space-editor textarea")!.value).toBe(
      "Remote notes",
    );
    expect(request.mock.calls.filter(([method]) => method.endsWith("page.save"))).toHaveLength(2);
    input(element, "Issue description / notes", "Remote notes\nMy notes");
    button(element, "Save").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.spaces.page.save", {
        spaceId: space.id,
        pageId: page.id,
        title: "Remote title",
        body: "Remote notes\nMy notes",
        expectedRevision: 2,
      }),
    );
    await vi.waitFor(() => expect(element.querySelector("[data-title]")).toBeNull());
    expect(remotePage.body).toBe("Remote notes\nMy notes");
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
        return {
          space: otherSpace,
          pages: [otherPage],
          members: [member],
          conversations: [],
          currentUserId: "alice",
        };
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
        ? {
            space: { ...space, role: "viewer" },
            pages: [page],
            members: [member],
            conversations: [],
            currentUserId: "alice",
          }
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
    input(element, "Employee name or account ID", "bob");
    button(element, "Find employee").click();
    await vi.waitFor(() => expect(element.textContent).toContain("Invite Bob"));
    button(element, "Invite Bob (bob)").click();
    await element.updateComplete;
    const notice = element.querySelector('[role="alertdialog"]')?.textContent;
    expect(notice).toContain("read shared pages and earlier shared Q&A");
    expect(notice).toContain("only their own agent tabs");
    expect(notice).toContain("Space agents can recall questions and final answers");
    button(element, "Cancel").click();
    await element.updateComplete;
    expect(request.mock.calls.some(([method]) => method.endsWith("member.set"))).toBe(false);
  });
  it("suggests partial names, supports keyboard selection, and ignores out-of-order results", async () => {
    const { element, request } = await mount();
    const original = request.getMockImplementation()!;
    const pending = new Map<string, (value: unknown) => void>();
    request.mockImplementation(async (method, params) =>
      method.endsWith(".people")
        ? new Promise((resolve) => {
            pending.set(params?.query as string, resolve);
          })
        : original(method, params),
    );
    button(element, "Members and access").click();
    await element.updateComplete;
    input(element, "Employee name or account ID", "bo");
    await vi.waitFor(() => expect(pending.has("bo")).toBe(true));
    expect(element.querySelector('[role="status"]')?.textContent).toContain("Loading");
    input(element, "Employee name or account ID", "ca");
    pending.get("bo")!([{ userId: "bob", accountId: "bob", displayName: "Bob" }]);
    await vi.waitFor(() => expect(pending.has("ca")).toBe(true));
    expect(element.textContent).not.toContain("Invite Bob");
    pending.get("ca")!([{ userId: "carol", accountId: "carol", displayName: "Carol" }]);
    await vi.waitFor(() =>
      expect(element.querySelector('[role="option"]')?.textContent).toContain("Carol"),
    );
    const field = element.querySelector<HTMLInputElement>('[role="combobox"]')!;
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    expect(field.getAttribute("aria-activedescendant")).toBe(
      element.querySelector('[role="option"]')!.id,
    );
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await element.updateComplete;
    expect(element.querySelector('[role="alertdialog"]')?.textContent).toContain("Carol (carol)");
    button(element, "Confirm").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.spaces.member.set", {
        spaceId: space.id,
        userId: "carol",
        role: "editor",
        expectedRevision: 1,
      }),
    );
  });
  it("shows empty results and recoverable search failures", async () => {
    const { element, request } = await mount();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".people")) {
        if (params?.query === "missing") {
          return [];
        }
        throw new Error("Directory unavailable; try again");
      }
      return original(method, params);
    });
    button(element, "Members and access").click();
    await element.updateComplete;
    input(element, "Employee name or account ID", "missing");
    await vi.waitFor(() => expect(element.textContent).toContain("No matching active employees"));
    input(element, "Employee name or account ID", "failure");
    await vi.waitFor(() =>
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(
        "Directory unavailable; try again",
      ),
    );
    expect(element.textContent).not.toContain("No matching active employees");
  });
  it.each(["space", "permission", "client"])(
    "clears member suggestions and late responses on %s change",
    async (change) => {
      const { element, request, gateway, emit } = await mount();
      const original = request.getMockImplementation()!;
      let release!: (value: unknown) => void;
      let role = "owner";
      request.mockImplementation(async (method, params) => {
        if (method.endsWith(".people")) {
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        if (method.endsWith(".get")) {
          return {
            space: { ...space, role },
            pages: [page],
            members: [member],
            conversations: [],
            currentUserId: "alice",
          };
        }
        return original(method, params);
      });
      button(element, "Members and access").click();
      await element.updateComplete;
      input(element, "Employee name or account ID", "bo");
      await vi.waitFor(() => expect(release).toBeDefined());
      if (change === "space") {
        await element.selectSpace("other");
      }
      if (change === "permission") {
        role = "viewer";
        emit({ event: "platformclaw.spaces.invalidated" });
        await vi.waitFor(() => expect(element.querySelector('[role="combobox"]')).toBeNull());
      }
      if (change === "client") {
        gateway.snapshot.client = { request: vi.fn(async () => []) };
        gateway.snapshot.phase = "stopped";
        emit({ event: "platformclaw.spaces.invalidated" });
        await element.updateComplete;
      }
      release([{ userId: "bob", accountId: "bob", displayName: "Bob" }]);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      await element.updateComplete;
      expect(element.querySelector('[role="option"]')).toBeNull();
      expect(element.querySelector('[role="alertdialog"]')).toBeNull();
    },
  );
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
