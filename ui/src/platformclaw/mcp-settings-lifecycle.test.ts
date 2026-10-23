import { afterEach, describe, expect, it, vi } from "vitest";
import { PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT } from "./mcp-catalog-events.ts";
import type { McpServerSetting } from "./mcp-settings-model.ts";
import "./mcp-settings.ts";

type SettingsElement = HTMLElement & {
  fetchImpl: typeof fetch;
  confirmRemove: (message: string) => boolean;
  updateComplete: Promise<boolean>;
};
function catalog(revision: number, overrides: Partial<McpServerSetting> = {}) {
  return new Response(
    JSON.stringify({
      servers: [
        {
          serverName: "docs",
          origin: "organization",
          credentialMode: "none",
          globalEnabled: true,
          userEnabled: true,
          configured: true,
          credentialStored: false,
          credentialFingerprint: null,
          settingsRevision: revision,
          policyFingerprint: "policy-docs",
          headerGuides: [],
          headers: [],
          ...overrides,
        },
      ],
    }),
  );
}
async function input(element: SettingsElement, selector: string, value: string) {
  const field = element.shadowRoot!.querySelector<HTMLInputElement>(selector)!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await element.updateComplete;
}
function submit(element: SettingsElement) {
  element
    .shadowRoot!.querySelector("form")!
    .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
}
function savedRequest(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const body = fetchImpl.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as Record<string, unknown>;
}
async function idle(element: SettingsElement) {
  await element.updateComplete;
  await vi.waitFor(() =>
    expect(
      element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='refresh']")?.disabled,
    ).toBe(false),
  );
}
afterEach(() =>
  document.querySelectorAll("platformclaw-mcp-settings").forEach((element) => element.remove()),
);

describe("PlatformClaw MCP settings request lifecycle", () => {
  it("keeps an edited credential's original snapshot after another client deletes it", async () => {
    const stored: Partial<McpServerSetting> = {
      credentialMode: "personal",
      auth: "api_key",
      credentialStored: true,
      credentialFingerprint: "credential-original",
    };
    const deleted: Partial<McpServerSetting> = {
      ...stored,
      configured: false,
      credentialStored: false,
      credentialFingerprint: null,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catalog(7, stored))
      .mockResolvedValueOnce(catalog(7, deleted))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: "Credential changed. Reload and re-enter the changed value." }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(catalog(7, deleted))
      .mockResolvedValueOnce(catalog(8, stored));
    const element = document.createElement("platformclaw-mcp-settings") as SettingsElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await idle(element);
    element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='change-secret']")!.click();
    await element.updateComplete;
    await input(element, "[name='secret']", "stale-secret");
    window.dispatchEvent(new Event(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await idle(element);
    submit(element);
    await idle(element);
    expect(savedRequest(fetchImpl, 2).expectedCredentialFingerprint).toBe("credential-original");
    expect(element.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain(
      "Credential changed",
    );
    element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='refresh']")!.click();
    await idle(element);
    expect(element.shadowRoot!.querySelector<HTMLInputElement>("[name='secret']")!.value).toBe("");
    await input(element, "[name='secret']", "new-secret");
    submit(element);
    await idle(element);
    expect(savedRequest(fetchImpl, 4)).toMatchObject({
      expectedRevision: 7,
      expectedCredentialFingerprint: null,
      credential: { kind: "api_key", secret: "new-secret" },
    });
  });

  it("clears a replaced credential and adopts the explicit deletion snapshot while retaining header edits", async () => {
    const stored: Partial<McpServerSetting> = {
      credentialMode: "personal",
      auth: "api_key",
      credentialStored: true,
      credentialFingerprint: "credential-original",
      headerGuides: [{ name: "X-Tenant" }],
    };
    const deleted = {
      ...stored,
      configured: false,
      credentialStored: false,
      credentialFingerprint: null,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catalog(7, stored))
      .mockResolvedValueOnce(new Response(JSON.stringify({ removed: true })))
      .mockResolvedValueOnce(catalog(7, deleted))
      .mockResolvedValueOnce(catalog(8, stored));
    const element = document.createElement("platformclaw-mcp-settings") as SettingsElement;
    element.fetchImpl = fetchImpl;
    element.confirmRemove = () => true;
    document.body.append(element);
    await idle(element);
    element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='change-secret']")!.click();
    await element.updateComplete;
    await input(element, "[name='secret']", "discard-after-delete");
    await input(element, "[name='guide-value']", "unsaved-tenant");
    element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='remove']")!.click();
    await idle(element);
    expect(element.shadowRoot!.querySelector<HTMLInputElement>("[name='secret']")!.value).toBe("");
    expect(element.shadowRoot!.querySelector<HTMLInputElement>("[name='guide-value']")!.value).toBe(
      "unsaved-tenant",
    );
    await input(element, "[name='secret']", "replacement");
    submit(element);
    await idle(element);
    expect(savedRequest(fetchImpl, 3)).toMatchObject({
      expectedRevision: 7,
      expectedPolicyFingerprint: "policy-docs",
      expectedCredentialFingerprint: null,
      credential: { kind: "api_key", secret: "replacement" },
      headers: [{ name: "X-Tenant", value: "unsaved-tenant" }],
    });
  });
  it.each(["reload", "save"])(
    "reconnects after an interrupted %s and ignores the old response",
    async (operation) => {
      let completeOld!: (response: Response) => void;
      let completeNew!: (response: Response) => void;
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(catalog(7))
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              completeOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              completeNew = resolve;
            }),
        )
        .mockResolvedValueOnce(catalog(11));
      const element = document.createElement("platformclaw-mcp-settings") as SettingsElement;
      element.fetchImpl = fetchImpl;
      document.body.append(element);
      await idle(element);
      if (operation === "reload") {
        element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='refresh']")!.click();
      } else {
        element
          .shadowRoot!.querySelector("form")!
          .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
      }
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      element.remove();
      document.body.append(element);
      await element.updateComplete;
      expect(element.shadowRoot?.querySelector("form")).toBeNull();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      completeNew(catalog(10));
      await idle(element);
      completeOld(catalog(8));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      await element.updateComplete;
      element
        .shadowRoot!.querySelector("form")!
        .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
      const requestBody = fetchImpl.mock.calls[3]?.[1]?.body;
      if (typeof requestBody !== "string") {
        throw new Error("Expected a JSON request body");
      }
      const body = JSON.parse(requestBody) as {
        expectedRevision: number;
      };
      expect(body.expectedRevision).toBe(10);
      await idle(element);
    },
  );
});
