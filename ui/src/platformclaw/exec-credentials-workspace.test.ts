import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  response,
  secretInput,
  enterSecret,
  clickAction,
  deferredResponse,
  snapshot,
  mount,
  save,
} from "./exec-credentials.test-support.ts";
import type { PlatformClawExecCredentialsElement } from "./exec-credentials.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";

beforeAll(loadAllPlatformClawLocales);
afterEach(async () => {
  document.querySelectorAll("platformclaw-exec-credentials").forEach((element) => element.remove());
  await i18n.setLocale("en");
});
describe("Credential workspace state", () => {
  it("blocks the reloaded editor while preserving another editor's input and caret", async () => {
    const definitions = [
      { envName: "API_TOKEN", configured: false },
      { envName: "TOKEN_B", configured: false },
    ];
    const pending = deferredResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions }))
      .mockReturnValueOnce(pending.promise);
    const element = await mount(fetchImpl);
    enterSecret(element, "API_TOKEN", "discard-this-input");
    clickAction(element, "reload", "API_TOKEN");
    expect(secretInput(element, "API_TOKEN").disabled).toBe(true);
    expect(
      element.querySelector<HTMLButtonElement>("[data-action='save'][data-env='API_TOKEN']")!
        .disabled,
    ).toBe(true);

    clickAction(element, "select", "TOKEN_B");
    const sibling = secretInput(element, "TOKEN_B");
    expect(sibling.disabled).toBe(false);
    enterSecret(element, "TOKEN_B", "keep-this-input");
    sibling.focus();
    sibling.setSelectionRange(2, 6);
    pending.resolve(
      response({
        accountId: "account-a",
        definitions: [
          {
            envName: "API_TOKEN",
            configured: true,
            revision: 8,
            credentialToken: "credential-refreshed",
          },
          definitions[1]!,
        ],
      }),
    );

    await vi.waitFor(() => expect(secretInput(element, "API_TOKEN").disabled).toBe(false));
    expect(secretInput(element, "API_TOKEN").value).toBe("");
    expect(secretInput(element, "API_TOKEN").placeholder).toBe("••••••••");
    expect(secretInput(element, "TOKEN_B")).toBe(sibling);
    expect(sibling.value).toBe("keep-this-input");
    expect(document.activeElement).toBe(sibling);
    expect([sibling.selectionStart, sibling.selectionEnd]).toEqual([2, 6]);
    expect(fetchImpl.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET", "GET"]);
  });
  it("keeps the requested key confirmed after saving an unrelated key", async () => {
    const initial = [
      { envName: "API_TOKEN", configured: false },
      { envName: "TOKEN_B", configured: false },
    ];
    const savedA = [{ envName: "API_TOKEN", configured: true, revision: 4 }, initial[1]!];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: initial }))
      .mockResolvedValueOnce(response({ envName: "API_TOKEN", revision: 4 }))
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: savedA }))
      .mockResolvedValueOnce(response({ envName: "TOKEN_B", revision: 1 }))
      .mockResolvedValueOnce(
        response({
          accountId: "account-a",
          definitions: [savedA[0]!, { envName: "TOKEN_B", configured: true, revision: 1 }],
        }),
      );
    const element = await mount(fetchImpl, true);
    const onSaved = vi.fn();
    element.onPersonalSaved = onSaved;
    save(element);
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onSaved).toHaveBeenCalledWith({
      requestId: "request-a",
      envName: "API_TOKEN",
      revision: 4,
      definitionToken: "definition-API_TOKEN",
      credentialToken: "credential-API_TOKEN-4",
    });
    expect(element.target).toBeUndefined();
    expect(secretInput(element, "API_TOKEN").value).toBe("");
    clickAction(element, "select", "TOKEN_B");
    enterSecret(element, "TOKEN_B", "synthetic-b");
    clickAction(element, "save", "TOKEN_B");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_B").value).toBe(""));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(element.target).toBeUndefined();
  });

  it("pins a dirty draft across sibling refresh and reloads changed tokens only after explicit discard", async () => {
    const initial = [
      { envName: "API_TOKEN", configured: false },
      { envName: "TOKEN_B", configured: false },
    ];
    const changed = [
      {
        envName: "API_TOKEN",
        configured: true,
        revision: 7,
        definitionToken: "definition-recreated",
        credentialToken: "credential-other",
      },
      { envName: "TOKEN_B", configured: true, revision: 1 },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: initial }))
      .mockResolvedValueOnce(response({ envName: "TOKEN_B", revision: 1 }))
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: changed }))
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: changed }))
      .mockResolvedValueOnce(
        response({
          envName: "API_TOKEN",
          revision: 8,
          definitionToken: "definition-recreated",
          credentialToken: "credential-new",
        }),
      )
      .mockResolvedValueOnce(
        response({
          accountId: "account-a",
          definitions: [
            { ...changed[0]!, revision: 8, credentialToken: "credential-new" },
            changed[1]!,
          ],
        }),
      );
    const element = await mount(fetchImpl);
    enterSecret(element, "API_TOKEN", "old-unsaved-input");
    clickAction(element, "select", "TOKEN_B");
    enterSecret(element, "TOKEN_B", "sibling-input");
    clickAction(element, "save", "TOKEN_B");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(element.textContent).toContain("This key changed elsewhere."));
    expect(secretInput(element, "API_TOKEN").value).toBe("old-unsaved-input");
    expect(
      element.querySelector<HTMLButtonElement>("[data-action='save'][data-env='API_TOKEN']")!
        .disabled,
    ).toBe(true);
    clickAction(element, "select", "API_TOKEN");
    clickAction(element, "reload", "API_TOKEN");
    await vi.waitFor(() => expect(secretInput(element, "API_TOKEN").value).toBe(""));
    enterSecret(element, "API_TOKEN", "replacement-after-reload");
    clickAction(element, "save", "API_TOKEN");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(6));
    expect(JSON.parse(fetchImpl.mock.calls[4]![1]!.body as string)).toMatchObject({
      expectedDefinitionToken: "definition-recreated",
      expectedCredentialToken: "credential-other",
      value: "replacement-after-reload",
    });
  });

  it("retains a conflicting input and makes no further write before Reload", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(response({ code: "credential-changed" }, 409))
      .mockResolvedValueOnce(snapshot(true, 5));
    const element = await mount(fetchImpl);
    save(element, "stale-input");
    await vi.waitFor(() => expect(element.textContent).toContain("This key changed elsewhere."));
    expect(secretInput(element, "API_TOKEN").value).toBe("stale-input");
    clickAction(element, "save", "API_TOKEN");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clickAction(element, "reload", "API_TOKEN");
    await vi.waitFor(() => expect(secretInput(element, "API_TOKEN").value).toBe(""));
    expect(fetchImpl.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("keeps named pending verification visible while another editor is selected", async () => {
    const definitions = [
      { envName: "API_TOKEN", configured: false },
      { envName: "TOKEN_B", configured: false },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions }))
      .mockResolvedValueOnce(response({ envName: "API_TOKEN", revision: 4 }))
      .mockRejectedValueOnce(new Error("synthetic transport error"))
      .mockResolvedValueOnce(
        response({
          accountId: "account-a",
          definitions: [{ envName: "API_TOKEN", configured: true, revision: 4 }, definitions[1]!],
        }),
      );
    const element = await mount(fetchImpl, true);
    const onSaved = vi.fn();
    element.onPersonalSaved = onSaved;
    save(element);
    await vi.waitFor(() => expect(element.querySelector("[data-recheck]")).not.toBeNull());
    clickAction(element, "select", "TOKEN_B");
    enterSecret(element, "TOKEN_B", "keep-b");
    expect(element.querySelector("[data-pending-env='API_TOKEN']")?.textContent).toContain(
      "API_TOKEN",
    );
    expect(
      element.querySelector<HTMLButtonElement>("[data-action='save'][data-env='TOKEN_B']")!
        .disabled,
    ).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    expect(element.target?.envName).toBe("API_TOKEN");
    element.querySelector<HTMLButtonElement>("[data-recheck]")!.click();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(onSaved).toHaveBeenCalledWith({
      requestId: "request-a",
      envName: "API_TOKEN",
      revision: 4,
      definitionToken: "definition-API_TOKEN",
      credentialToken: "credential-API_TOKEN-4",
    });
    expect(element.target).toBeUndefined();
    expect(element.querySelector("[data-pending-env='API_TOKEN']")).toBeNull();
    expect(secretInput(element, "TOKEN_B").value).toBe("keep-b");
    expect(element.querySelector("[data-editor='TOKEN_B']")!.hasAttribute("hidden")).toBe(false);
  });

  it("reveals a requested key on the last page without moving focus again", async () => {
    const definitions = [
      ...Array.from({ length: 31 }, (_, index) => ({ envName: `KEY_${index}` })),
      { envName: "API_TOKEN" },
    ];
    const element = await mount(
      vi.fn<typeof fetch>(async () => response({ accountId: "account-a", definitions })),
      true,
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(secretInput(element, "API_TOKEN")));
    expect(element.querySelectorAll("[data-action='select']")).toHaveLength(8);
    expect(
      element
        .querySelector("[data-action='select'][data-env='API_TOKEN']")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    const search = element.querySelector<HTMLInputElement>("[name='credentialSearch']")!;
    search.focus();
    search.value = "KEY_0";
    search.dispatchEvent(new Event("input"));
    expect(document.activeElement).toBe(search);
    expect(element.querySelector("[data-editor='API_TOKEN']")!.hasAttribute("hidden")).toBe(false);
  });
  it("reloads a changed allowed key and requires a fresh deletion confirmation", async () => {
    const before = [{ envName: "API_TOKEN", definitionToken: "definition-old" }];
    const after = [{ envName: "API_TOKEN", definitionToken: "definition-new" }];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: before }))
      .mockResolvedValueOnce(response({ definitions: before }))
      .mockResolvedValueOnce(response({ code: "credential-changed" }, 409))
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: after }))
      .mockResolvedValueOnce(response({ definitions: after }))
      .mockResolvedValueOnce(response({ definitions: [] }))
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: [] }))
      .mockResolvedValueOnce(response({ definitions: [] }));
    const element = document.createElement(
      "platformclaw-exec-credentials",
    ) as PlatformClawExecCredentialsElement;
    element.admin = true;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(element.querySelector("[data-action='select']")).not.toBeNull());
    element
      .querySelector("wa-tab-group")!
      .dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name: "administration" } }));
    clickAction(element, "remove-definition", "API_TOKEN");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    element.querySelector<HTMLButtonElement>("[data-action='confirm-remove-definition']")!.click();
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-modal-dialog")?.textContent).toContain(
        "This allowed key changed elsewhere.",
      ),
    );
    element
      .querySelector<HTMLButtonElement>("openclaw-modal-dialog [data-action='reload-definitions']")!
      .click();
    await vi.waitFor(() => expect(element.querySelector("openclaw-modal-dialog")).toBeNull());
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    clickAction(element, "remove-definition", "API_TOKEN");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    element.querySelector<HTMLButtonElement>("[data-action='confirm-remove-definition']")!.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(8));
    expect(JSON.parse(fetchImpl.mock.calls[2]![1]!.body as string)).toMatchObject({
      expectedDefinitionToken: "definition-old",
      expectedAccountId: "account-a",
    });
    expect(JSON.parse(fetchImpl.mock.calls[5]![1]!.body as string)).toMatchObject({
      expectedDefinitionToken: "definition-new",
      expectedAccountId: "account-a",
    });
  });
});
