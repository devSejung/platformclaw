import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./mcp-administration.ts";
import { PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT } from "./mcp-catalog-events.ts";

type AdminElement = HTMLElement & {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mount(fetchImpl: typeof fetch): AdminElement {
  const element = document.createElement("platformclaw-mcp-administration") as AdminElement;
  element.fetchImpl = fetchImpl;
  element.onUnauthenticated = vi.fn();
  document.body.append(element);
  return element;
}

describe("PlatformClaw MCP administration", () => {
  it("locks all actions during save and retains the complete editor draft after failure", async () => {
    let finish!: (response: Response) => void;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ servers: [] }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
    const element = mount(fetchImpl);
    const root = element.shadowRoot!;
    await vi.waitFor(() => expect(root.querySelector("[data-action='add']")).not.toBeNull());
    root.querySelector<HTMLButtonElement>("[data-action='add']")!.click();
    const set = (name: string, value: string) => {
      const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name='${name}']`)!;
      field.value = value;
      field.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("name", "draft-server");
    set("url", "https://draft.example/mcp");
    set("transport", "sse");
    set("credentialMode", "shared");
    set("auth", "api_key");
    set("headerName", "X-Draft-Key");
    set("secret", "fixture-only-secret");
    set("blockedTools", "delete, write");
    root.querySelector<HTMLInputElement>("[name='enabled']")!.checked = false;
    root.querySelector<HTMLFormElement>("form")!.requestSubmit();
    for (const control of root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >("button, input, select, textarea")) {
      expect(control.disabled).toBe(true);
    }
    finish(jsonResponse({ error: "Save failed. Try again." }, 503));
    await vi.waitFor(() => expect(root.textContent).toContain("Save failed"));
    for (const [name, value] of Object.entries({
      name: "draft-server",
      url: "https://draft.example/mcp",
      transport: "sse",
      credentialMode: "shared",
      auth: "api_key",
      headerName: "X-Draft-Key",
      secret: "fixture-only-secret",
      blockedTools: "delete, write",
    })) {
      expect(root.querySelector<HTMLInputElement>(`[name='${name}']`)?.value).toBe(value);
    }
    expect(root.querySelector<HTMLInputElement>("[name='enabled']")?.checked).toBe(false);
    expect(root.querySelector<HTMLButtonElement>("[type='submit']")?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>("[data-action='cancel']")!.click();
    root.querySelector<HTMLButtonElement>("[data-action='add']")!.click();
    expect(root.querySelector<HTMLInputElement>("[name='name']")?.value).toBe("");
    expect(root.querySelector<HTMLInputElement>("[name='secret']")?.value).toBe("");
  });

  afterEach(async () => {
    document
      .querySelectorAll("platformclaw-mcp-administration")
      .forEach((element) => element.remove());
    await i18n.setLocale("en");
  });

  it("explains the server, credential, and tool policies in one discoverable surface", async () => {
    const element = mount(
      vi.fn<typeof fetch>(async () =>
        jsonResponse({
          servers: [
            {
              name: "docs",
              enabled: true,
              transport: "streamable-http",
              target: "https://docs.example/mcp",
              editable: true,
              credentialMode: "none",
              toolPolicy: "all",
              blockedTools: [],
            },
          ],
        }),
      ),
    );

    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("MCP server administration"),
    );
    expect(element.shadowRoot?.textContent).toContain("No credential");
    expect(element.shadowRoot?.textContent).toContain("All tools allowed");
    expect(element.shadowRoot?.textContent).toContain("docs");
  });

  it("registers a credential-free server without inventing a personal prompt", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ servers: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          servers: [
            {
              name: "docs",
              enabled: true,
              transport: "streamable-http",
              target: "https://docs.example/mcp",
              editable: true,
              credentialMode: "none",
              toolPolicy: "all",
              blockedTools: [],
            },
          ],
        }),
      );
    const element = mount(fetchImpl);
    const catalogChanged = vi.fn();
    window.addEventListener(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT, catalogChanged, {
      once: true,
    });
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Add MCP server"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='add']")?.click();
    const name = element.shadowRoot?.querySelector<HTMLInputElement>("[name='name']");
    const url = element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']");
    if (name && url) {
      name.value = "docs";
      url.value = "https://docs.example/mcp";
    }
    element.shadowRoot
      ?.querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        action: "save-server",
        name: "docs",
        url: "https://docs.example/mcp",
        transport: "streamable-http",
        credentialMode: "none",
        auth: "",
        headerName: "",
        secret: "",
        scope: "",
        blockedTools: [],
        enabled: true,
      }),
    });
    await vi.waitFor(() => expect(catalogChanged).toHaveBeenCalledOnce());
  });

  it("redirects through the adapter when the session expires", async () => {
    const onUnauthenticated = vi.fn();
    const element = mount(vi.fn<typeof fetch>(async () => jsonResponse({ error: "expired" }, 401)));
    element.onUnauthenticated = onUnauthenticated;

    await vi.waitFor(() => expect(onUnauthenticated).toHaveBeenCalledOnce());
  });

  it("requires an explicit credential type when editing redacted shared headers", async () => {
    const element = mount(
      vi.fn<typeof fetch>(async () =>
        jsonResponse({
          servers: [
            {
              name: "shared",
              enabled: true,
              transport: "sse",
              target: "https://shared.example/mcp",
              editable: true,
              credentialMode: "shared",
              headerName: "Authorization",
              toolPolicy: "all",
              blockedTools: [],
            },
          ],
        }),
      ),
    );
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("shared"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='edit']")?.click();

    const form = element.shadowRoot?.querySelector<HTMLFormElement>("form");
    const auth = form?.querySelector<HTMLSelectElement>("[name='auth']");
    expect(auth?.value).toBe("");
    expect(form?.checkValidity()).toBe(false);
  });

  it("warns but still allows header credentials over plaintext HTTP", async () => {
    const element = mount(vi.fn<typeof fetch>(async () => jsonResponse({ servers: [] })));
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Add MCP server"));
    element.shadowRoot?.querySelector<HTMLElement>("[data-action='add']")?.click();

    const form = element.shadowRoot?.querySelector<HTMLFormElement>("form");
    const url = form?.querySelector<HTMLInputElement>("[name='url']");
    const mode = form?.querySelector<HTMLSelectElement>("[name='credentialMode']");
    const warning = form?.querySelector<HTMLElement>("[data-http-auth-warning]");
    expect(warning?.hidden).toBe(true);

    if (url && mode) {
      url.value = "http://mcp.example/mcp";
      url.dispatchEvent(new InputEvent("input", { bubbles: true }));
      mode.value = "shared";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(warning?.hidden).toBe(false);
    expect(warning?.textContent).toContain("sent without transport encryption");
    expect(form?.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled).toBe(false);
  });
});
