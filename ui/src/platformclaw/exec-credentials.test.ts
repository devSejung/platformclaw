import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import type { PlatformClawExecCredentialsElement } from "./exec-credentials.ts";
import { loadAllPlatformClawLocales, platformClawT as t } from "./i18n.ts";
import "./exec-credentials.ts";

beforeAll(loadAllPlatformClawLocales);

import {
  response,
  secretInput,
  enterSecret,
  clickAction,
  snapshot,
  deferredResponse,
  mount,
  save,
  credentialRequestTarget as target,
} from "./exec-credentials.test-support.ts";
type CredentialElement = PlatformClawExecCredentialsElement;

describe("PlatformClaw exec credentials", () => {
  afterEach(async () => {
    document
      .querySelectorAll("platformclaw-exec-credentials")
      .forEach((element) => element.remove());
    await i18n.setLocale("en");
  });

  it("shows metadata only and replaces a personal value without retaining it", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          accountId: "account-a",
          definitions: [{ envName: "API_TOKEN", configured: false, revision: 1 }],
        }),
      )
      .mockResolvedValueOnce(response({ envName: "API_TOKEN", revision: 1 }))
      .mockResolvedValueOnce(
        response({
          accountId: "account-a",
          definitions: [{ envName: "API_TOKEN", configured: true, revision: 1 }],
        }),
      );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(element.textContent).toContain("API_TOKEN"));

    const input = element.querySelector<HTMLInputElement>("[data-value='API_TOKEN']");
    expect(input?.value).toBe("");
    enterSecret(element, "API_TOKEN", "  personal-secret  ");
    element.querySelector<HTMLButtonElement>("[data-action='save']")?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        action: "replace",
        envName: "API_TOKEN",
        value: "  personal-secret  ",
        expectedDefinitionToken: "definition-API_TOKEN",
        expectedCredentialToken: null,
        expectedAccountId: "account-a",
      }),
    });
    expect(element.innerHTML).not.toContain("personal-secret");
    await vi.waitFor(() => expect(element.textContent).toContain("Saved."));
    expect(secretInput(element, "API_TOKEN").value).toBe("");
    expect(secretInput(element, "API_TOKEN").placeholder).toBe("••••••••");
    expect(element.textContent).toContain("Enter a new value and save to replace it.");
    clickAction(element, "save", "API_TOKEN");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("preserves another credential's draft and caret through saving and refreshing", async () => {
    const definitions = [
      { envName: "TOKEN_A", configured: false, revision: 1 },
      { envName: "TOKEN_B", configured: false, revision: 1 },
    ];
    let resolvePost!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    let resolveRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions }))
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(refresh)
      .mockResolvedValueOnce(response({ envName: "TOKEN_B", revision: 1 }))
      .mockResolvedValueOnce(
        response({
          accountId: "account-a",
          definitions: definitions.map((item) => ({
            envName: item.envName,
            configured: true,
            revision: 1,
          })),
        }),
      );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_B")).not.toBeNull());

    enterSecret(element, "TOKEN_A", "secret-a");
    enterSecret(element, "TOKEN_B", "secret-b");
    clickAction(element, "save", "TOKEN_A");
    const siblingInput = secretInput(element, "TOKEN_B");
    expect(secretInput(element, "TOKEN_B").value).toBe("secret-b");
    expect(secretInput(element, "TOKEN_A").disabled).toBe(true);
    enterSecret(element, "TOKEN_B", "new-secret-b");
    secretInput(element, "TOKEN_B").focus();
    secretInput(element, "TOKEN_B").setSelectionRange(4, 7, "backward");
    resolvePost(response({ envName: "TOKEN_A", revision: 1 }));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(document.activeElement).toBe(secretInput(element, "TOKEN_B"));
    expect(secretInput(element, "TOKEN_B")).toBe(siblingInput);
    expect(secretInput(element, "TOKEN_B").selectionStart).toBe(4);
    expect(secretInput(element, "TOKEN_B").selectionEnd).toBe(7);
    expect(secretInput(element, "TOKEN_B").selectionDirection).toBe("backward");
    enterSecret(element, "TOKEN_B", "newer-secret-b");
    secretInput(element, "TOKEN_B").setSelectionRange(6, 6);
    resolveRefresh(
      response({
        accountId: "account-a",
        definitions: [{ ...definitions[0], configured: true, revision: 1 }, definitions[1]],
      }),
    );
    await vi.waitFor(() =>
      expect(
        element.querySelector<HTMLButtonElement>("[data-action='save'][data-env='TOKEN_B']")
          ?.disabled,
      ).toBe(false),
    );
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_A").placeholder).toBe("••••••••"));
    expect(secretInput(element, "TOKEN_A").value).toBe("");
    expect(secretInput(element, "TOKEN_B").value).toBe("newer-secret-b");
    expect(document.activeElement).toBe(secretInput(element, "TOKEN_B"));
    expect(secretInput(element, "TOKEN_B").selectionStart).toBe(6);
    expect(element.innerHTML).not.toContain("newer-secret-b");
    clickAction(element, "save", "TOKEN_B");

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
    expect(fetchImpl.mock.calls[3]?.[1]?.body).toBe(
      JSON.stringify({
        action: "replace",
        envName: "TOKEN_B",
        value: "newer-secret-b",
        expectedDefinitionToken: "definition-TOKEN_B",
        expectedCredentialToken: null,
        expectedAccountId: "account-a",
      }),
    );
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_B").placeholder).toBe("••••••••"));
    expect(secretInput(element, "TOKEN_B").value).toBe("");
  });

  it.each([false, true])(
    "keeps the correct drafts after a request failure (save acknowledged: %s)",
    async (saved) => {
      const definitions = [
        { envName: "TOKEN_A", configured: false, revision: 1 },
        { envName: "TOKEN_B", configured: false, revision: 1 },
      ];
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response({ accountId: "account-a", definitions }));
      if (saved) {
        fetchImpl.mockResolvedValueOnce(response({ envName: "TOKEN_A", revision: 1 }));
      }
      fetchImpl.mockResolvedValueOnce(response({ error: "Service unavailable" }, 503));
      const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
      element.fetchImpl = fetchImpl;
      document.body.append(element);
      await vi.waitFor(() => expect(secretInput(element, "TOKEN_B")).not.toBeNull());
      enterSecret(element, "TOKEN_A", "retry-secret-a");
      enterSecret(element, "TOKEN_B", "secret-b");
      clickAction(element, "save", "TOKEN_A");

      await vi.waitFor(() => {
        if (saved) {
          expect(element.querySelector("[data-pending-env='TOKEN_A']")?.textContent).toContain(
            "TOKEN_A",
          );
        } else {
          expect(element.textContent).toContain(t("platformClaw.execCredentials.failed"));
        }
      });
      expect(element.textContent).not.toContain("Service unavailable");
      expect(secretInput(element, "TOKEN_A").value).toBe(saved ? "" : "retry-secret-a");
      expect(secretInput(element, "TOKEN_B").value).toBe("secret-b");
      if (saved) {
        expect(element.querySelector("[data-pending-env='TOKEN_A']")).not.toBeNull();
        expect(secretInput(element, "TOKEN_A").disabled).toBe(true);
        expect(
          element.querySelector<HTMLButtonElement>("[data-action='save'][data-env='TOKEN_A']")!
            .disabled,
        ).toBe(true);
      }
    },
  );

  it("keeps sibling drafts on removal and locale changes, then clears them when leaving", async () => {
    const definitions = [
      { envName: "TOKEN_A", configured: true, revision: 1 },
      { envName: "TOKEN_B", configured: false, revision: 1 },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions }))
      .mockResolvedValueOnce(response({ deleted: true }))
      .mockResolvedValueOnce(
        response({
          accountId: "account-a",
          definitions: definitions.map((item) => ({
            envName: item.envName,
            configured: false,
            revision: 1,
          })),
        }),
      );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_B")).not.toBeNull());
    enterSecret(element, "TOKEN_B", "unsaved-b");
    await i18n.setLocale("ko");
    await vi.waitFor(() =>
      expect(element.textContent).toContain(t("platformClaw.execCredentials.title")),
    );
    expect(secretInput(element, "TOKEN_B").value).toBe("unsaved-b");
    clickAction(element, "remove", "TOKEN_A");
    await vi.waitFor(() =>
      expect(secretInput(element, "TOKEN_A").placeholder).toBe(
        t("platformClaw.execCredentials.valuePlaceholder"),
      ),
    );
    expect(secretInput(element, "TOKEN_B").value).toBe("unsaved-b");
    const draftInput = secretInput(element, "TOKEN_B");
    element.remove();
    expect(draftInput.value).toBe("");
    expect(element.querySelector("[data-value]")).toBeNull();
  });

  it("shows allowlist administration only to administrators", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ accountId: "account-a", definitions: [] }),
    );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.admin = true;
    element.fetchImpl = fetchImpl;
    document.body.append(element);

    await vi.waitFor(() => expect(element.querySelector("wa-tab-group")).not.toBeNull());
    element
      .querySelector("wa-tab-group")!
      .dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name: "administration" } }));
    await vi.waitFor(() => expect(element.textContent).toContain("Allowed environment variables"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("disables allowlist removal while its request is pending", async () => {
    let resolveMutation!: (value: Response) => void;
    const mutation = new Promise<Response>((resolve) => {
      resolveMutation = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: [] }))
      .mockResolvedValueOnce(
        response({ accountId: "account-a", definitions: [{ envName: "API_TOKEN" }] }),
      )
      .mockReturnValueOnce(mutation)
      .mockResolvedValue(response({ accountId: "account-a", definitions: [] }));
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.admin = true;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(element.querySelector("wa-tab-group")).not.toBeNull());
    element
      .querySelector("wa-tab-group")!
      .dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name: "administration" } }));
    await vi.waitFor(() =>
      expect(element.querySelector("[data-action='remove-definition']")).not.toBeNull(),
    );
    clickAction(element, "remove-definition", "API_TOKEN");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(element.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "every user's saved value",
    );
    element.querySelector<HTMLButtonElement>("[data-action='confirm-remove-definition']")!.click();
    expect(
      element.querySelector<HTMLButtonElement>("[data-action='remove-definition']")?.disabled,
    ).toBe(true);
    resolveMutation(response({ accountId: "account-a", definitions: [] }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
  });

  it("requires a nonblank draft before enabling Save", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({
        accountId: "account-a",
        definitions: [{ envName: "API_TOKEN", configured: false, revision: 1 }],
      }),
    );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(secretInput(element, "API_TOKEN")).not.toBeNull());
    enterSecret(element, "API_TOKEN", "   ");
    const saveButton = element.querySelector<HTMLButtonElement>("[data-action='save']")!;
    expect(saveButton.disabled).toBe(true);
    saveButton.click();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    enterSecret(element, "API_TOKEN", "new-token");
    expect(saveButton.disabled).toBe(false);
    enterSecret(element, "API_TOKEN", "");
    expect(saveButton.disabled).toBe(true);
  });
  it("focuses the exact requested input once and preserves another input's focus, draft, and caret on locale changes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({
        accountId: "account-a",
        definitions: [{ envName: "FIRST_TOKEN" }, { envName: "API_TOKEN" }],
      }),
    );
    const element = await mount(fetchImpl, true);
    await vi.waitFor(() =>
      expect((document.activeElement as HTMLInputElement)?.dataset.value).toBe("API_TOKEN"),
    );
    const first = element.querySelector<HTMLInputElement>("[data-value='FIRST_TOKEN']")!;
    first.value = "synthetic-draft";
    first.dispatchEvent(new Event("input"));
    first.focus();
    first.setSelectionRange(2, 5);
    await i18n.setLocale("ko");
    await vi.waitFor(() =>
      expect(element.textContent).toContain(t("platformClaw.execCredentials.title")),
    );
    const active = document.activeElement as HTMLInputElement;
    expect(active.dataset.value).toBe("FIRST_TOKEN");
    expect(active.value).toBe("synthetic-draft");
    expect([active.selectionStart, active.selectionEnd]).toEqual([2, 5]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("clears the acknowledged secret and uses GET-only retry before confirming the exact stored revision", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(response({ envName: "API_TOKEN", revision: 4 }))
      .mockRejectedValueOnce(new Error("synthetic-only must never appear"))
      .mockResolvedValueOnce(snapshot(true, 4));
    const element = await mount(fetchImpl, true);
    const onSaved = vi.fn();
    const onReturn = vi.fn();
    element.onPersonalSaved = onSaved;
    element.onReturnToConversation = onReturn;
    save(element);
    await vi.waitFor(() => expect(element.querySelector("[data-recheck]")).not.toBeNull());
    expect(element.querySelector<HTMLInputElement>("[data-value]")!.value).toBe("");
    expect(element.textContent).not.toContain("synthetic-only");
    expect(element.querySelector<HTMLButtonElement>("[data-flow-return]")!.disabled).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    element.querySelector<HTMLButtonElement>("[data-recheck]")!.click();
    await vi.waitFor(() =>
      expect(onSaved).toHaveBeenCalledExactlyOnceWith({
        requestId: "request-a",
        envName: "API_TOKEN",
        revision: 4,
        definitionToken: "definition-API_TOKEN",
        credentialToken: "credential-API_TOKEN-4",
      }),
    );
    expect(fetchImpl.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "GET",
      "GET",
    ]);
    expect(element.querySelector<HTMLButtonElement>("[data-flow-return]")!.disabled).toBe(false);
    element.querySelector<HTMLButtonElement>("[data-flow-return]")!.click();
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it.each([
    { ack: { envName: "OTHER_TOKEN", revision: 4 }, storedRevision: 4, expectedCalls: 2 },
    { ack: { envName: "API_TOKEN", revision: 0 }, storedRevision: 0, expectedCalls: 2 },
    { ack: { envName: "API_TOKEN", revision: 4 }, storedRevision: 5, expectedCalls: 3 },
  ])(
    "does not complete mismatched ACK or changed stored revision $ack",
    async ({ ack, storedRevision, expectedCalls }) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(snapshot())
        .mockResolvedValueOnce(response(ack))
        .mockResolvedValueOnce(snapshot(true, storedRevision));
      const element = await mount(fetchImpl, true);
      const onSaved = vi.fn();
      element.onPersonalSaved = onSaved;
      save(element);
      await vi.waitFor(() =>
        expect(element.querySelector("[role='status'], [role='alert']")).not.toBeNull(),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(expectedCalls);
      expect(onSaved).not.toHaveBeenCalled();
      expect(element.querySelector<HTMLButtonElement>("[data-flow-return]")!.disabled).toBe(true);
    },
  );

  it.each(["cancel", "disconnect", "target"] as const)(
    "ignores a late save ACK after %s",
    async (action) => {
      const pending = deferredResponse();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(snapshot())
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(snapshot(true, 4));
      const element = await mount(fetchImpl, true);
      const onSaved = vi.fn();
      const onCancel = vi.fn();
      element.onPersonalSaved = onSaved;
      element.onCancelFlow = onCancel;
      save(element);
      if (action === "cancel") {
        element.querySelector<HTMLButtonElement>("[data-flow-cancel]")!.click();
        expect(onCancel).toHaveBeenCalledOnce();
      } else if (action === "disconnect") {
        element.remove();
      } else {
        element.target = { ...target, requestId: "request-b" };
      }
      pending.resolve(response({ envName: "API_TOKEN", revision: 4 }));
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(onSaved).not.toHaveBeenCalled();
      expect(element.querySelector<HTMLInputElement>("[data-value]")?.value ?? "").toBe("");
    },
  );

  it("blocks an account change before entering a key and discards values when the mutation account guard rejects", async () => {
    const mismatch = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    mismatch.target = target;
    mismatch.fetchImpl = vi.fn<typeof fetch>(async () => snapshot(false, 1, "account-b"));
    document.body.append(mismatch);
    await vi.waitFor(() => expect(mismatch.querySelector("[role='status']")).not.toBeNull());
    expect(mismatch.querySelector("[data-value]")).toBeNull();
    expect(mismatch.textContent).not.toContain("account-b");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "credential-account-changed" }), { status: 409 }),
      );
    const element = await mount(fetchImpl, true);
    const onSaved = vi.fn();
    element.onPersonalSaved = onSaved;
    save(element);
    await vi.waitFor(() =>
      expect(element.querySelector<HTMLInputElement>("[data-value]")!.value).toBe(""),
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(element.querySelector<HTMLInputElement>("[data-value]")!.disabled).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).expectedAccountId).toBe(
      "account-a",
    );
  });

  it("makes one mutation for repeated save clicks and does not leak raw server errors", async () => {
    const pending = deferredResponse();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(pending.promise);
    const element = await mount(fetchImpl, true);
    const button = element.querySelector<HTMLButtonElement>("[data-action='save']")!;
    save(element);
    button.click();
    element.querySelector<HTMLButtonElement>("[data-action='save']")!.click();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    pending.resolve(new Response(JSON.stringify({ error: "synthetic-only" }), { status: 503 }));
    await vi.waitFor(() =>
      expect(element.querySelector("[role='status'], [role='alert']")).not.toBeNull(),
    );
    expect(element.textContent).not.toContain("synthetic-only");
    expect(element.querySelector<HTMLInputElement>("[data-value]")!.value).toBe("synthetic-only");
  });

  it("does not automatically retry an ambiguous POST or confirm its later metadata", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("synthetic-only"));
    const element = await mount(fetchImpl, true);
    const onSaved = vi.fn();
    element.onPersonalSaved = onSaved;
    save(element);
    await vi.waitFor(() =>
      expect(element.querySelector<HTMLInputElement>("[data-value]")!.disabled).toBe(false),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onSaved).not.toHaveBeenCalled();
    expect(element.querySelector("[data-recheck]")).toBeNull();
    expect(element.textContent).not.toContain("synthetic-only");
    expect(element.querySelector<HTMLButtonElement>("[data-flow-return]")!.disabled).toBe(true);
  });

  it("leaves the contextual request incomplete when its allowed definition disappears", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(response({ envName: "API_TOKEN", revision: 2 }))
      .mockResolvedValueOnce(response({ accountId: "account-a", definitions: [] }));
    const element = await mount(fetchImpl, true);
    const onSaved = vi.fn();
    element.onPersonalSaved = onSaved;
    save(element);
    await vi.waitFor(() => expect(element.querySelector("[data-value]")).toBeNull());
    expect(onSaved).not.toHaveBeenCalled();
    expect(element.querySelector<HTMLButtonElement>("[data-flow-return]")!.disabled).toBe(true);
  });
});
