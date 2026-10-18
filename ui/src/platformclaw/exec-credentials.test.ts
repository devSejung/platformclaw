import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./exec-credentials.ts";

type CredentialElement = HTMLElement & { admin: boolean; fetchImpl: typeof fetch };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function secretInput(element: HTMLElement, envName: string): HTMLInputElement {
  return element.querySelector<HTMLInputElement>(`[data-value='${envName}']`)!;
}

function enterSecret(element: HTMLElement, envName: string, value: string): void {
  const input = secretInput(element, envName);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function clickAction(element: HTMLElement, action: string, envName: string): void {
  element
    .querySelector<HTMLButtonElement>(`[data-action='${action}'][data-env='${envName}']`)!
    .click();
}

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
        response({ definitions: [{ envName: "API_TOKEN", configured: false }] }),
      )
      .mockResolvedValueOnce(response({ envName: "API_TOKEN", revision: 1 }))
      .mockResolvedValueOnce(
        response({ definitions: [{ envName: "API_TOKEN", configured: true }] }),
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
      { envName: "TOKEN_A", configured: false },
      { envName: "TOKEN_B", configured: false },
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
      .mockResolvedValueOnce(response({ definitions }))
      .mockReturnValueOnce(pending)
      .mockReturnValueOnce(refresh)
      .mockResolvedValueOnce(response({ envName: "TOKEN_B", revision: 1 }))
      .mockResolvedValueOnce(
        response({
          definitions: definitions.map((item) => ({ envName: item.envName, configured: true })),
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
      response({ definitions: [{ ...definitions[0], configured: true }, definitions[1]] }),
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
      JSON.stringify({ action: "replace", envName: "TOKEN_B", value: "newer-secret-b" }),
    );
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_B").placeholder).toBe("••••••••"));
    expect(secretInput(element, "TOKEN_B").value).toBe("");
  });

  it.each([false, true])(
    "keeps the correct drafts after a request failure (save acknowledged: %s)",
    async (saved) => {
      const definitions = [
        { envName: "TOKEN_A", configured: false },
        { envName: "TOKEN_B", configured: false },
      ];
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ definitions }));
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

      await vi.waitFor(() => expect(element.textContent).toContain("Service unavailable"));
      expect(secretInput(element, "TOKEN_A").value).toBe(saved ? "" : "retry-secret-a");
      expect(secretInput(element, "TOKEN_B").value).toBe("secret-b");
      if (saved) {
        expect(secretInput(element, "TOKEN_A").placeholder).toBe("••••••••");
      }
    },
  );

  it("keeps sibling drafts on removal and locale changes, then clears them when leaving", async () => {
    const definitions = [
      { envName: "TOKEN_A", configured: true },
      { envName: "TOKEN_B", configured: false },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ definitions }))
      .mockResolvedValueOnce(response({ deleted: true }))
      .mockResolvedValueOnce(
        response({
          definitions: definitions.map((item) => ({ envName: item.envName, configured: false })),
        }),
      );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_B")).not.toBeNull());
    enterSecret(element, "TOKEN_B", "unsaved-b");
    await i18n.setLocale("ko");
    await vi.waitFor(() => expect(element.textContent).toContain("저장됨"));
    expect(secretInput(element, "TOKEN_B").value).toBe("unsaved-b");
    clickAction(element, "remove", "TOKEN_A");
    await vi.waitFor(() => expect(secretInput(element, "TOKEN_A").placeholder).toBe("새 값 입력"));
    expect(secretInput(element, "TOKEN_B").value).toBe("unsaved-b");
    const draftInput = secretInput(element, "TOKEN_B");
    element.remove();
    expect(draftInput.value).toBe("");
    expect(element.querySelector("[data-value]")).toBeNull();
  });

  it("shows allowlist administration only to administrators", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ definitions: [] }));
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.admin = true;
    element.fetchImpl = fetchImpl;
    document.body.append(element);

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
      .mockResolvedValueOnce(response({ definitions: [] }))
      .mockResolvedValueOnce(response({ definitions: [{ envName: "API_TOKEN" }] }))
      .mockReturnValueOnce(mutation)
      .mockResolvedValue(response({ definitions: [] }));
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.admin = true;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() =>
      expect(element.querySelector("[data-action='remove-definition']")).not.toBeNull(),
    );
    clickAction(element, "remove-definition", "API_TOKEN");
    expect(
      element.querySelector<HTMLButtonElement>("[data-action='remove-definition']")?.disabled,
    ).toBe(true);
    resolveMutation(response({ definitions: [] }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
  });

  it("requires a nonblank draft before enabling Save", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ definitions: [{ envName: "API_TOKEN", configured: false }] }),
    );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() => expect(secretInput(element, "API_TOKEN")).not.toBeNull());
    enterSecret(element, "API_TOKEN", "   ");
    const save = element.querySelector<HTMLButtonElement>("[data-action='save']")!;
    expect(save.disabled).toBe(true);
    save.click();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    enterSecret(element, "API_TOKEN", "new-token");
    expect(save.disabled).toBe(false);
    enterSecret(element, "API_TOKEN", "");
    expect(save.disabled).toBe(true);
  });
});
