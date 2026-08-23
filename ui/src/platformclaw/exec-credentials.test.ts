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
    if (input) input.value = "personal-secret";
    element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='save']")?.click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ action: "replace", envName: "API_TOKEN", value: "personal-secret" }),
    });
    expect(element.shadowRoot?.innerHTML).not.toContain("personal-secret");
    expect(element.shadowRoot?.textContent).toContain("Configured");
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
});
