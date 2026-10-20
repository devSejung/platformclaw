import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
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

type MountedSpace = Awaited<ReturnType<typeof mount>>;

async function disconnect({ element, gateway }: MountedSpace) {
  gateway.snapshot.phase = "reconnecting";
  element.requestUpdate();
  await vi.waitFor(() => expect(element.querySelector("[data-title]")).toBeNull());
  expect(element.textContent).not.toContain("Private unfinished draft");
}

describe("Space draft authorization lifetime", () => {
  it.each(["refresh", "reconnect"])(
    "preserves a viewer's independent Space creation request through %s",
    async (recovery) => {
      const mounted = await mount("viewer");
      const { element, request, gateway } = mounted;
      const original = request.getMockImplementation()!;
      let revalidating = false;
      let release!: () => void;
      request.mockImplementation(async (method, params) => {
        if (method === "platformclaw.spaces.create") {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Synthetic creation unavailable",
          });
        }
        if (method === "platformclaw.spaces.get" && revalidating) {
          return new Promise((resolve) => {
            release = () => resolve(original(method, params));
          });
        }
        return original(method, params);
      });
      const create = button(element, "Create Space");
      expect(create.disabled).toBe(false);
      create.click();
      await element.updateComplete;
      input(element, "Title", "Private unfinished draft");
      button(element, "Save").click();
      await vi.waitFor(() =>
        expect(element.querySelector('[role="alert"]')?.textContent).toContain(
          "Synthetic creation unavailable",
        ),
      );
      const creations = () =>
        request.mock.calls.filter(([method]) => method === "platformclaw.spaces.create");
      expect(creations()).toHaveLength(1);
      const firstRequest = creations()[0]![1];
      expect(firstRequest).toEqual({
        name: "Private unfinished draft",
        requestId: expect.any(String),
      });
      revalidating = true;
      if (recovery === "refresh") {
        button(element, "Refresh").click();
      } else {
        await disconnect(mounted);
        gateway.snapshot.phase = "connected";
        element.requestUpdate();
      }
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(element.querySelector("[data-title]")).toBeNull();
      release();
      await vi.waitFor(() =>
        expect(element.querySelector<HTMLInputElement>("[data-title]")?.value).toBe(
          "Private unfinished draft",
        ),
      );
      await vi.waitFor(() => expect(button(element, "Refresh").disabled).toBe(false));
      button(element, "Save").click();
      await vi.waitFor(() => expect(creations()).toHaveLength(2));
      expect(creations()[1]![1]).toEqual(firstRequest);
    },
  );

  describe.each(["list", "get"])("%s revalidation failure", (method) => {
    it.each([
      { code: "UNAVAILABLE", retained: true },
      { code: "transport", retained: true },
      { code: "FORBIDDEN", retained: false },
      { code: "UNAUTHENTICATED", retained: false },
    ])(
      "keeps a hidden draft only when $code permits later revalidation",
      async ({ code, retained }) => {
        const mounted = await mount();
        const { element, request, gateway } = mounted;
        await beginEdit(element);
        input(element, "Title", "Private unfinished draft");
        input(element, "Issue description / notes", "Unsent local notes");
        await disconnect(mounted);
        const original = request.getMockImplementation()!;
        let rejected = false;
        request.mockImplementation(async (called, params) => {
          if (called === `platformclaw.spaces.${method}` && !rejected) {
            rejected = true;
            throw code === "transport"
              ? new Error("Synthetic reconnect failure")
              : new GatewayRequestError({ code, message: "Synthetic reconnect failure" });
          }
          return original(called, params);
        });
        gateway.snapshot.phase = "connected";
        element.requestUpdate();
        await vi.waitFor(() =>
          expect(element.querySelector('[role="alert"]')?.textContent).toContain(
            "Synthetic reconnect failure",
          ),
        );
        expect(element.querySelector("[data-title]")).toBeNull();
        expect(element.textContent).not.toContain("Unsent local notes");
        const refresh = button(element, "Refresh");
        expect(refresh.disabled).toBe(false);
        refresh.click();
        await vi.waitFor(() =>
          expect(element.textContent).not.toContain("Synthetic reconnect failure"),
        );
        await vi.waitFor(() => expect(button(element, "Refresh").disabled).toBe(false));
        if (retained) {
          expect(element.querySelector<HTMLInputElement>("[data-title]")?.value).toBe(
            "Private unfinished draft",
          );
          expect(
            element.querySelector<HTMLTextAreaElement>(".pc-space-editor textarea")?.value,
          ).toBe("Unsent local notes");
        } else {
          expect(element.querySelector("[data-title]")).toBeNull();
        }
        expect(element.textContent).not.toContain("Synthetic reconnect failure");
        expect(request.mock.calls.some(([called]) => called.endsWith("page.save"))).toBe(false);
      },
    );
  });

  it.each(["edit", "page", "space", "conversation"] as const)(
    "restores a %s draft only after reconnect revalidates its owner and selection",
    async (kind) => {
      const mounted = await mount();
      const { element, request, gateway } = mounted;
      if (kind === "edit") {
        await beginEdit(element);
      } else {
        button(
          element,
          kind === "page"
            ? "New issue page"
            : kind === "space"
              ? "Create Space"
              : "New conversation",
        ).click();
        await element.updateComplete;
      }
      input(element, "Title", "Private unfinished draft");
      if (kind === "edit" || kind === "page") {
        input(element, "Issue description / notes", "Unsent local notes");
      }
      await element.updateComplete;
      const retiredForm = element.querySelector<HTMLFormElement>(".pc-space-editor")!;
      await disconnect(mounted);
      retiredForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(request.mock.calls.some(([method]) => /(?:\.save|\.create)$/.test(method))).toBe(
        false,
      );
      const original = request.getMockImplementation()!;
      let release!: (value: unknown) => void;
      request.mockImplementation(async (method, params) =>
        method.endsWith(".get")
          ? new Promise((resolve) => {
              release = resolve;
            })
          : original(method, params),
      );
      gateway.snapshot.phase = "connected";
      element.requestUpdate();
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(element.querySelector("[data-title]")).toBeNull();
      expect(element.textContent).not.toContain("Unsent local notes");
      release({
        space,
        pages: [page],
        members: [member],
        conversations: [],
        currentUserId: "alice",
      });
      await vi.waitFor(() =>
        expect(element.querySelector<HTMLInputElement>("[data-title]")?.value).toBe(
          "Private unfinished draft",
        ),
      );
      if (kind === "edit" || kind === "page") {
        expect(element.querySelector<HTMLTextAreaElement>(".pc-space-editor textarea")?.value).toBe(
          "Unsent local notes",
        );
      }
    },
  );

  it.each(["alice", "bob"])(
    "revalidates a first-Space draft against the fresh hello identity %s",
    async (userId) => {
      const mounted = await mount();
      const { element, request, gateway } = mounted;
      request.mockImplementation(async () => []);
      history.replaceState(null, "", "/");
      element.routeSearch = "";
      element.requestUpdate();
      await vi.waitFor(() =>
        expect(element.querySelector(".pc-space-heading")?.textContent).not.toContain(page.title),
      );
      await vi.waitFor(() => expect(button(element, "Create Space").disabled).toBe(false));
      button(element, "Create Space").click();
      await element.updateComplete;
      input(element, "Title", "Private unfinished draft");
      await disconnect(mounted);
      await element.refresh(true);
      gateway.snapshot.selfUser = { id: userId };
      gateway.snapshot.phase = "connected";
      element.requestUpdate();
      await vi.waitFor(() => expect(button(element, "Refresh").disabled).toBe(false));
      if (userId === "alice") {
        expect(element.querySelector<HTMLInputElement>("[data-title]")?.value).toBe(
          "Private unfinished draft",
        );
      } else {
        expect(element.querySelector("[data-title]")).toBeNull();
      }
    },
  );

  it("discards a child-page draft when its parent disappears while offline", async () => {
    const mounted = await mount();
    const { element, request, gateway } = mounted;
    await beginEdit(element);
    button(element, "Cancel").click();
    await element.updateComplete;
    button(element, "New child issue").click();
    await element.updateComplete;
    input(element, "Title", "Private unfinished draft");
    await disconnect(mounted);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) =>
      method.endsWith(".get")
        ? { space, pages: [], members: [member], conversations: [], currentUserId: "alice" }
        : original(method, params),
    );
    gateway.snapshot.phase = "connected";
    element.requestUpdate();
    await vi.waitFor(() => expect(button(element, "Create Space").disabled).toBe(false));
    expect(element.querySelector("[data-title]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method.endsWith("page.create"))).toBe(false);
  });

  it("saves restored Notes with the original revision instead of rebasing a stale draft", async () => {
    const mounted = await mount();
    const { element, request, gateway } = mounted;
    await beginEdit(element);
    input(element, "Title", "Private unfinished draft");
    input(element, "Issue description / notes", "Unsent local notes");
    await disconnect(mounted);
    const original = request.getMockImplementation()!;
    const newer = { ...page, title: "Someone else's edit", revision: 2 };
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".get")) {
        return {
          space,
          pages: [newer],
          members: [member],
          conversations: [],
          currentUserId: "alice",
        };
      }
      if (method.endsWith("page.save")) {
        throw new Error("Space changed; reload before retrying");
      }
      return original(method, params);
    });
    gateway.snapshot.phase = "connected";
    element.requestUpdate();
    await vi.waitFor(() => expect(element.querySelector("[data-title]")).not.toBeNull());
    expect(element.textContent).toContain("Your draft is unchanged");
    button(element, "Save").click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("platformclaw.spaces.page.save", {
        spaceId: space.id,
        pageId: page.id,
        title: "Private unfinished draft",
        body: "Unsent local notes",
        expectedRevision: 1,
      }),
    );
    expect(element.querySelector<HTMLInputElement>("[data-title]")?.value).toBe(
      "Private unfinished draft",
    );
  });

  it.each([
    "membership",
    "viewer",
    "snapshot-user",
    "hello-user",
    "client",
    "context",
    "route",
    "page",
  ] as const)("discards a suspended draft after its %s changes", async (change) => {
    const mounted = await mount();
    const { element, request, gateway } = mounted;
    await beginEdit(element);
    input(element, "Title", "Private unfinished draft");
    await disconnect(mounted);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method.endsWith(".list") && change === "membership") {
        return [];
      }
      if (method.endsWith(".get")) {
        return {
          space: { ...space, role: change === "viewer" ? "viewer" : "owner" },
          pages: change === "page" ? [] : [page],
          members: [member],
          conversations: [],
          currentUserId: change === "snapshot-user" ? "bob" : "alice",
        };
      }
      return original(method, params);
    });
    if (change === "hello-user") {
      gateway.snapshot.selfUser = { id: "bob" };
    } else if (change === "client") {
      gateway.snapshot.client = { request };
    } else if (change === "context") {
      element.context = { gateway: { ...gateway }, replace: () => {} };
    } else if (change === "route") {
      history.replaceState(null, "", `/?space=${space.id}`);
      element.routeSearch = location.search;
      element.requestUpdate();
      await element.updateComplete;
    }
    gateway.snapshot.phase = "connected";
    element.requestUpdate();
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([method]) => method.endsWith(".list")).length,
      ).toBeGreaterThan(1),
    );
    await vi.waitFor(() => expect(element.textContent).not.toContain("Loading…"));
    expect(element.querySelector("[data-title]")).toBeNull();
    expect(element.textContent).not.toContain("Private unfinished draft");
    expect(request.mock.calls.some(([method]) => method.endsWith("page.save"))).toBe(false);
  });
});
