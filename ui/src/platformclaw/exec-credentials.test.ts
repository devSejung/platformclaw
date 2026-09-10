import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./exec-credentials.ts";

type CredentialElement = HTMLElement & { admin: boolean; fetchImpl: typeof fetch };

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("API_TOKEN"));

    const input = element.shadowRoot?.querySelector<HTMLInputElement>("[data-value='API_TOKEN']");
    if (input) {
      input.value = "  personal-secret  ";
    }
    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='save']")?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        action: "replace",
        envName: "API_TOKEN",
        value: "  personal-secret  ",
      }),
    });
    expect(element.shadowRoot?.innerHTML).not.toContain("  personal-secret  ");
    expect(element.shadowRoot?.textContent).toContain("Configured");
    expect(element.shadowRoot?.querySelector('[role="status"]')?.textContent).toBe("Saved.");
  });

  it("shows allowlist administration only to administrators", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ definitions: [] }));
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.admin = true;
    element.fetchImpl = fetchImpl;
    document.body.append(element);

    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Allowed environment variables"),
    );
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
      expect(element.shadowRoot?.querySelector("[data-action='remove-definition']")).not.toBeNull(),
    );
    element
      .shadowRoot!.querySelector<HTMLButtonElement>("[data-action='remove-definition']")!
      .click();
    expect(
      element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='remove-definition']")!
        .disabled,
    ).toBe(true);
    resolveMutation(response({ definitions: [] }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
  });

  it("marks a whitespace-only personal credential as required instead of ignoring Save", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ definitions: [{ envName: "API_TOKEN", configured: false }] }),
    );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[data-value]")).not.toBeNull(),
    );
    const input = element.shadowRoot!.querySelector<HTMLInputElement>("[data-value]")!;
    input.value = "   ";
    const reportValidity = vi.spyOn(input, "reportValidity");
    element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='save']")!.click();
    expect(reportValidity).toHaveBeenCalledOnce();
    expect(input.validity.valueMissing).toBe(true);
    expect(input.getAttribute("aria-label")).toBe("API_TOKEN");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves volatile credential drafts after a failed save", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          definitions: [
            { envName: "API_TOKEN", configured: false },
            { envName: "SECOND_TOKEN", configured: false },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Credential service unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const element = document.createElement("platformclaw-exec-credentials") as CredentialElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[data-value='SECOND_TOKEN']")).not.toBeNull(),
    );
    const first = element.shadowRoot!.querySelector<HTMLInputElement>("[data-value='API_TOKEN']")!;
    const second = element.shadowRoot!.querySelector<HTMLInputElement>(
      "[data-value='SECOND_TOKEN']",
    )!;
    first.value = "failed-secret";
    first.dispatchEvent(new Event("input"));
    second.value = "unrelated-draft";
    second.dispatchEvent(new Event("input"));
    element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='save']")!.click();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Credential service unavailable"),
    );
    expect(
      element.shadowRoot!.querySelector<HTMLInputElement>("[data-value='API_TOKEN']")!.value,
    ).toBe("failed-secret");
    expect(
      element.shadowRoot!.querySelector<HTMLInputElement>("[data-value='SECOND_TOKEN']")!.value,
    ).toBe("unrelated-draft");
    expect(element.shadowRoot!.innerHTML).not.toContain("failed-secret");
    expect(element.shadowRoot!.innerHTML).not.toContain("unrelated-draft");
  });
});
