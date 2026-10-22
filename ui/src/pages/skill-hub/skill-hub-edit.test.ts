/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./skill-hub-page.ts";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString();
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function button(scope: ParentNode, label: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  )!;
}

function change(scope: ParentNode, selector: string, value: string, event = "input") {
  const field = scope.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    selector,
  )!;
  field.value = value;
  field.dispatchEvent(new Event(event, { bubbles: true }));
}

function setup(
  options: {
    admin?: boolean;
    canManage?: boolean;
    revision?: string | null;
    editFailure?: boolean;
    networkFailure?: boolean;
    editFailureStatus?: 400 | 404 | 409 | 422 | 503;
    editPending?: boolean;
    review?: boolean;
    publicationPending?: boolean;
    refreshFailure?: "search" | "detail";
  } = {},
) {
  let moved = false;
  let published = false;
  let fail = options.editFailure;
  let registryRevision = options.revision ?? "registry-revision-1";
  let ownerRevision = 42;
  const cancelledOperations = new Set<unknown>();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/config")) {
      return jsonResponse({
        namespaces: ["platform"],
        defaultNamespace: "platform",
        namespaceOptions: [{ namespace: "platform", scopeKind: "global" }],
        maxPackageBytes: 1024,
        admin: options.admin,
      });
    }
    if (url.includes("/publish/upload?")) {
      published = true;
      return jsonResponse({ namespace: "engineering", slug: "demo", version: "2.0.0" });
    }
    if (url.endsWith("/edit")) {
      expect(init?.method).toBe("POST");
      const operationId = requestBody(init).operationId;
      if (cancelledOperations.has(operationId)) {
        return jsonResponse(
          { error: "Operation cancelled; reload the detail before saving." },
          409,
        );
      }
      if (fail) {
        if (options.networkFailure) {
          throw new TypeError("Network connection interrupted. Try again.");
        }
        const status = options.editFailureStatus ?? 409;
        if ([400, 404, 409, 422].includes(status) && !options.editPending) {
          cancelledOperations.add(operationId);
          registryRevision = "registry-revision-2";
          ownerRevision = 43;
        }
        return jsonResponse(
          {
            error:
              status === 422
                ? "Publish a new Private version before sharing this skill. Reload the detail before saving."
                : "Skill changed. Reload the detail before saving.",
            ...(options.editPending ? { details: { code: "skill-hub-edit-pending" } } : {}),
          },
          status,
        );
      }
      moved = true;
      return jsonResponse({
        ok: true,
        namespace: "platform",
        slug: "demo",
        ownershipReviewRequired: options.review || undefined,
        publicationPending: options.publicationPending || undefined,
      });
    }
    if (url.includes("/skills/")) {
      if ((moved || published) && options.refreshFailure === "detail") {
        return jsonResponse({ error: "Detail refresh unavailable" }, 503);
      }
      return jsonResponse({
        skill: {
          namespace: moved ? "platform" : "engineering",
          slug: "demo",
          displayName: moved ? "Updated Demo" : "Demo Skill",
          summary: moved ? "Updated summary" : "Original summary",
          visibility: moved ? "PRIVATE" : "NAMESPACE_ONLY",
          status: "PUBLISHED",
          revision: options.revision === null ? undefined : registryRevision,
        },
        owner: {
          assigned: true,
          isMine: !options.admin,
          unassigned: false,
          revision: ownerRevision,
        },
        canManage: options.canManage ?? true,
        versions: [{ version: "1.0.0", status: "PUBLISHED", downloadAvailable: true }],
        access: [],
      });
    }
    if ((moved || published) && options.refreshFailure === "search") {
      return jsonResponse({ error: "Catalog refresh unavailable" }, 503);
    }
    return jsonResponse({
      total: 1,
      items: [
        {
          namespace: moved ? "platform" : "engineering",
          slug: "demo",
          summary: "Original summary",
          latestVersion: "1.0.0",
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const page = document.createElement("openclaw-skill-hub-page");
  document.body.append(page);
  return {
    page,
    fetchMock,
    allowSave: () => {
      fail = false;
    },
  };
}

async function openDetail(page: HTMLElement) {
  await waitForFast(() => expect(page.querySelector(".skill-hub-card")).not.toBeNull());
  page.querySelector<HTMLButtonElement>(".skill-hub-card")!.click();
  await waitForFast(() => expect(page.textContent).toContain("Demo Skill"));
}

describe("published Skill Hub editing", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each([false, true])(
    "allows an owner or administrator (admin=%s) to edit and follows the moved identity",
    async (admin) => {
      const { page, fetchMock } = setup({ admin });
      await openDetail(page);
      button(page, "Edit skill").click();
      await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
      const form = page.querySelector<HTMLFormElement>(".skill-hub-edit")!;
      expect(form.querySelector<HTMLInputElement>('[name="displayName"]')?.value).toBe(
        "Demo Skill",
      );
      expect(form.querySelector<HTMLSelectElement>('[name="namespace"]')?.value).toBe(
        "engineering",
      );
      expect(form.querySelector<HTMLTextAreaElement>('[name="summary"]')?.value).toBe(
        "Original summary",
      );
      expect(form.querySelector<HTMLSelectElement>('[name="visibility"]')?.value).toBe(
        "NAMESPACE_ONLY",
      );
      expect(form.textContent).toContain("Package identity: demo");
      change(form, '[name="displayName"]', "Updated Demo");
      change(form, '[name="summary"]', "Updated summary");
      change(form, '[name="namespace"]', "platform", "change");
      change(form, '[name="visibility"]', "PRIVATE", "change");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() => expect(page.textContent).toContain("Updated platform/demo."));
      expect(page.querySelector(".skill-hub-edit")).toBeNull();
      expect(page.querySelector(".skill-hub-detail .skill-hub-card__namespace")?.textContent).toBe(
        "platform",
      );
      const editCall = fetchMock.mock.calls.find(([input]) => requestUrl(input).endsWith("/edit"))!;
      expect(requestUrl(editCall[0])).toContain("/skills/engineering/demo/edit");
      expect(editCall[1]?.method).toBe("POST");
      expect(requestBody(editCall[1])).toEqual({
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        namespace: "platform",
        displayName: "Updated Demo",
        summary: "Updated summary",
        visibility: "PRIVATE",
        expectedOwnerUpdatedAt: 42,
        expectedRegistryRevision: "registry-revision-1",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/skills/platform/demo"),
        expect.any(Object),
      );
    },
  );

  it("hides editing and publication actions from non-managers", async () => {
    const { page } = setup({ canManage: false });
    await openDetail(page);
    expect(button(page, "Edit skill")).toBeUndefined();
    expect(button(page, "Publish new version")).toBeUndefined();
  });

  it("hides metadata editing when the registry has no revision contract", async () => {
    const { page } = setup({ revision: null });
    await openDetail(page);
    expect(button(page, "Edit skill")).toBeUndefined();
    expect(button(page, "Publish new version")).toBeDefined();
  });

  it.each([400, 404, 409, 422] as const)(
    "reloads revisions and starts a fresh edit after definitive %s cancellation",
    async (status) => {
      const { page, fetchMock, allowSave } = setup({
        editFailure: true,
        editFailureStatus: status,
        review: true,
      });
      const submissions = () =>
        fetchMock.mock.calls
          .filter(([input]) => requestUrl(input).endsWith("/edit"))
          .map(([, init]) => requestBody(init));
      await openDetail(page);
      button(page, "Edit skill").click();
      await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
      const form = page.querySelector<HTMLFormElement>(".skill-hub-edit")!;
      change(form, '[name="displayName"]', "Updated Demo");
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() =>
        expect(form.querySelector('[role="alert"]')?.textContent).toContain("Reload the detail"),
      );
      expect(form.querySelector<HTMLInputElement>('[name="displayName"]')?.value).toBe(
        "Updated Demo",
      );
      if (status === 422) {
        expect(form.querySelector('[role="alert"]')?.textContent).toContain(
          "Publish a new Private version",
        );
      }
      expect(button(form, "Save changes")).toBeUndefined();
      expect(button(form, "Reload").disabled).toBe(false);
      const cancelledId = submissions()[0]!.operationId;
      allowSave();
      button(form, "Reload").click();
      await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).toBeNull());
      expect(submissions()).toHaveLength(1);
      button(page, "Edit skill").click();
      await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
      const freshForm = page.querySelector<HTMLFormElement>(".skill-hub-edit")!;
      change(freshForm, '[name="displayName"]', "Updated Demo");
      freshForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() =>
        expect(page.querySelector(".callout.warning")?.textContent).toContain(
          "private until an administrator",
        ),
      );
      expect(submissions()).toHaveLength(2);
      expect(submissions()[1]).toMatchObject({
        expectedRegistryRevision: "registry-revision-2",
        expectedOwnerUpdatedAt: 43,
      });
      expect(submissions()[1]!.operationId).not.toBe(cancelledId);
    },
  );

  it("prepopulates the existing package identity for a new immutable version", async () => {
    const { page } = setup();
    await openDetail(page);
    button(page, "Publish new version").click();
    await waitForFast(() => expect(page.querySelector(".skill-hub-upload")).not.toBeNull());
    const upload = page.querySelector(".skill-hub-upload")!;
    const inputs = upload.querySelectorAll<HTMLInputElement>(".skill-hub-upload__fields input");
    expect(inputs[0]?.value).toBe("demo");
    expect(inputs[0]?.disabled).toBe(true);
    expect(inputs[1]?.value).toBe("");
    const selects = upload.querySelectorAll<HTMLSelectElement>("select");
    expect(selects[0]?.value).toBe("engineering");
    expect(selects[0]?.disabled).toBe(true);
    expect(selects[1]?.value).toBe("NAMESPACE_ONLY");
    expect(selects[1]?.disabled).toBe(true);
    expect(upload.textContent).toContain("Previously published versions remain unchanged");
    expect(button(upload, "Scan and publish ZIP").disabled).toBe(true);
  });

  it.each(["network", "unavailable", "pending"] as const)(
    "retries an uncertain %s response with the same operation until the draft changes",
    async (failure) => {
      const { page, fetchMock, allowSave } = setup({
        editFailure: true,
        networkFailure: failure === "network",
        editFailureStatus: failure === "unavailable" ? 503 : 409,
        editPending: failure === "pending",
      });
      const submissions = () =>
        fetchMock.mock.calls
          .filter(([input]) => requestUrl(input).endsWith("/edit"))
          .map(([, init]) => requestBody(init));
      await openDetail(page);
      button(page, "Edit skill").click();
      await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
      const form = page.querySelector<HTMLFormElement>(".skill-hub-edit")!;
      const submit = () =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      submit();
      await waitForFast(() =>
        expect(form.querySelector('[role="alert"]')?.textContent).toContain(
          failure === "network" ? "Network connection interrupted" : "Reload the detail",
        ),
      );
      const firstId = submissions()[0]!.operationId;
      submit();
      await waitForFast(() => expect(submissions()).toHaveLength(2));
      await waitForFast(() => expect(button(form, "Save changes").disabled).toBe(false));
      expect(submissions()[1]!.operationId).toBe(firstId);
      change(form, '[name="displayName"]', "Updated Demo");
      allowSave();
      submit();
      await waitForFast(() => expect(page.textContent).toContain("Updated platform/demo."));
      expect(submissions()[2]!.operationId).not.toBe(firstId);
    },
  );

  it.each([false, true])(
    "shows pending publication and prioritizes ownership review (review=%s)",
    async (review) => {
      const { page } = setup({ publicationPending: true, review });
      await openDetail(page);
      button(page, "Edit skill").click();
      await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
      page
        .querySelector<HTMLFormElement>(".skill-hub-edit")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await waitForFast(() =>
        expect(page.querySelector(".callout.warning")?.textContent).toContain(
          review
            ? "private until an administrator"
            : "sharing awaits security scanning and publication",
        ),
      );
    },
  );

  it.each([
    { operation: "edit", refreshFailure: "search" },
    { operation: "edit", refreshFailure: "detail" },
    { operation: "upload", refreshFailure: "search" },
    { operation: "upload", refreshFailure: "detail" },
  ] as const)(
    "shows committed $operation success and $refreshFailure refresh failure inside the active detail",
    async ({ operation, refreshFailure }) => {
      const { page, fetchMock } = setup({ refreshFailure });
      await openDetail(page);
      if (operation === "edit") {
        button(page, "Edit skill").click();
        await waitForFast(() => expect(page.querySelector(".skill-hub-edit")).not.toBeNull());
        page
          .querySelector<HTMLFormElement>(".skill-hub-edit")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      } else {
        button(page, "Publish new version").click();
        await waitForFast(() => expect(page.querySelector(".skill-hub-upload")).not.toBeNull());
        const upload = page.querySelector(".skill-hub-upload")!;
        const file = upload.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(file, "files", {
          value: [new File(["zip"], "demo.zip", { type: "application/zip" })],
        });
        file.dispatchEvent(new Event("change", { bubbles: true }));
        const version = upload.querySelectorAll<HTMLInputElement>(
          ".skill-hub-upload__fields input",
        )[1]!;
        version.value = "2.0.0";
        version.dispatchEvent(new Event("input", { bubbles: true }));
        await waitForFast(() =>
          expect(button(upload, "Scan and publish ZIP").disabled).toBe(false),
        );
        button(upload, "Scan and publish ZIP").click();
      }
      const success =
        operation === "edit"
          ? "Updated platform/demo."
          : "Published engineering/demo@2.0.0 from ZIP.";
      await waitForFast(() =>
        expect(page.querySelector(".skill-hub-detail .callout.success")?.textContent).toContain(
          success,
        ),
      );
      expect(page.querySelector(".skill-hub-edit, .skill-hub-upload")).toBeNull();
      expect(page.querySelector('.skill-hub-detail [role="alert"]')?.textContent).toContain(
        refreshFailure === "search" ? "Catalog refresh unavailable" : "Detail refresh unavailable",
      );
      expect(
        fetchMock.mock.calls.filter(
          ([input, init]) =>
            init?.method === "POST" &&
            (requestUrl(input).endsWith("/edit") || requestUrl(input).includes("/publish/upload?")),
        ),
      ).toHaveLength(1);
      if (refreshFailure === "detail") {
        expect(button(page, "Install to Basic Workspace").disabled).toBe(true);
        expect(button(page, "Install to My VM Workspace").disabled).toBe(true);
      }
    },
  );
});
