import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./mcp-administration.ts";
import { PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT } from "./mcp-catalog-events.ts";

type AdminElement = HTMLElement & {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
  confirmRemove: (message: string) => boolean;
  updateComplete: Promise<boolean>;
};
function server(name = "docs", overrides: Record<string, unknown> = {}) {
  return {
    name,
    enabled: true,
    transport: "streamable-http",
    target: `https://${name}.example/mcp`,
    editable: true,
    credentialMode: "none",
    sharedConfigured: false,
    headerGuides: [],
    toolPolicy: "all",
    blockedTools: [],
    ...overrides,
  };
}
function response(servers: ReturnType<typeof server>[]) {
  return new Response(JSON.stringify({ servers }), {
    headers: { "Content-Type": "application/json" },
  });
}
function requestBody(body: RequestInit["body"] | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as Record<string, unknown>;
}
async function mount(fetchImpl: typeof fetch) {
  const element = document.createElement("platformclaw-mcp-administration") as AdminElement;
  element.fetchImpl = fetchImpl;
  element.onUnauthenticated = vi.fn();
  document.body.append(element);
  await vi.waitFor(() =>
    expect(
      element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='add']")?.disabled,
    ).toBe(false),
  );
  return element;
}
async function field(element: AdminElement, name: string, value: string) {
  const input = element.shadowRoot!.querySelector<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(`[name='${name}']`)!;
  input.value = value;
  input.dispatchEvent(
    new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
  await element.updateComplete;
}
function click(element: AdminElement, selector: string) {
  element.shadowRoot!.querySelector<HTMLButtonElement>(selector)!.click();
}
function submit(element: AdminElement) {
  element
    .shadowRoot!.querySelector("form")!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}
afterEach(async () => {
  document
    .querySelectorAll("platformclaw-mcp-administration")
    .forEach((element) => element.remove());
  await i18n.setLocale("en");
});

describe("PlatformClaw MCP administration", () => {
  it("displays the stored OAuth selection before submitting its authentication policy", async () => {
    const entry = server("oauth", {
      credentialMode: "personal",
      personalAuth: "oauth",
      scope: "read",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => response([entry]));
    const element = await mount(fetchImpl);
    expect(element.shadowRoot?.querySelector<HTMLSelectElement>("[name='auth']")?.value).toBe(
      "oauth",
    );
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='scope']")?.value).toBe(
      "read",
    );
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body)).toMatchObject({
      credentialMode: "personal",
      auth: "oauth",
      scope: "read",
    });
  });

  it("registers optional header guidance and tools in a single explicit server save", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([server()]));
    const element = await mount(fetchImpl);
    const catalogChanged = vi.fn();
    window.addEventListener(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT, catalogChanged, { once: true });
    click(element, "[data-action='add']");
    await element.updateComplete;
    await field(element, "name", "docs");
    await field(element, "url", "https://docs.example/mcp");
    click(element, "[data-action='add-header']");
    await element.updateComplete;
    await field(element, "guide-name", "X-Tenant-ID");
    await field(element, "guide-description", "Tenant assigned by the service");
    await field(element, "blockedTools", "delete_*, admin");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    submit(element);
    await vi.waitFor(() => expect(catalogChanged).toHaveBeenCalledOnce());
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body)).toEqual({
      action: "save-server",
      name: "docs",
      url: "https://docs.example/mcp",
      transport: "streamable-http",
      credentialMode: "none",
      auth: "bearer",
      headerName: "X-API-Key",
      scope: "",
      headerGuides: [{ name: "X-Tenant-ID", description: "Tenant assigned by the service" }],
      blockedTools: ["delete_*", "admin"],
      enabled: true,
    });
  });

  it("preserves shared credentials for guidance edits and requires replacement after endpoint changes", async () => {
    const entry = server("shared", {
      credentialMode: "shared",
      sharedAuth: "api_key",
      sharedConfigured: true,
      headerName: "X-Key",
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([entry]))
      .mockResolvedValueOnce(response([entry]));
    const element = await mount(fetchImpl);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.disabled).toBe(
      true,
    );
    click(element, "[data-action='add-header']");
    await element.updateComplete;
    await field(element, "guide-name", "X-Project");
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector<HTMLButtonElement>("[type='submit']")?.disabled,
      ).toBe(false),
    );
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body)).not.toHaveProperty("secret");
    await field(element, "url", "https://new.example/mcp");
    submit(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("Enter a replacement shared credential");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps drafts after failures and unrelated row toggles, and restores stored state on cancel", async () => {
    const entries = [server("docs"), server("other")];
    let finish!: (response: Response) => void;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(entries))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(response([entries[0]!, { ...entries[1]!, enabled: false }]));
    const element = await mount(fetchImpl);
    await field(element, "url", "https://draft.example/mcp");
    click(element, "[data-action='add-header']");
    await element.updateComplete;
    await field(element, "guide-name", "X-Draft");
    submit(element);
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']")?.disabled).toBe(
      true,
    );
    finish(
      new Response(JSON.stringify({ error: "Save failed. Retry the same changes." }), {
        status: 503,
      }),
    );
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Save failed"));
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']")?.value).toBe(
      "https://draft.example/mcp",
    );
    const toggle = element.shadowRoot!.querySelector<HTMLInputElement>("[data-toggle='other']")!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']")?.disabled).toBe(
        false,
      ),
    );
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='guide-name']")?.value).toBe(
      "X-Draft",
    );
    click(element, "[data-action='select'][data-server='other']");
    await element.updateComplete;
    click(element, "[data-action='select'][data-server='docs']");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']")?.value).toBe(
      "https://draft.example/mcp",
    );
    click(element, "[data-action='cancel']");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']")?.value).toBe(
      "https://docs.example/mcp",
    );
  });

  it("filters and paginates six rows without submitting a form or dropping the selected draft", async () => {
    const entries = Array.from({ length: 13 }, (_, index) =>
      server(`server-${String(index).padStart(2, "0")}`, {
        credentialMode: index % 2 ? "shared" : "none",
      }),
    );
    const fetchImpl = vi.fn<typeof fetch>(async () => response(entries));
    const element = await mount(fetchImpl);
    expect(element.shadowRoot?.querySelectorAll(".server-row")).toHaveLength(6);
    await field(element, "url", "https://draft.example/mcp");
    click(element, "[data-action='next']");
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("7–12 / 13");
    await field(element, "search", "server-12");
    expect(element.shadowRoot?.querySelectorAll(".server-row")).toHaveLength(1);
    await field(element, "search", "");
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']")?.value).toBe(
      "https://draft.example/mcp",
    );
    await field(element, "policyFilter", "shared");
    expect(element.shadowRoot?.querySelectorAll(".server-row")).toHaveLength(6);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("handles credential modes, warns on HTTP, and keeps advanced servers CLI-managed", async () => {
    const element = await mount(
      vi.fn<typeof fetch>(async () =>
        response([server(), server("advanced", { editable: false })]),
      ),
    );
    await field(element, "url", "http://intranet.example/mcp");
    await field(element, "credentialMode", "personal");
    await field(element, "auth", "oauth");
    expect(element.shadowRoot?.querySelector("[name='scope']")).not.toBeNull();
    expect(element.shadowRoot?.textContent).toContain("without transport encryption");
    await field(element, "credentialMode", "shared");
    expect(element.shadowRoot?.querySelector<HTMLSelectElement>("[name='auth']")?.value).toBe(
      "bearer",
    );
    expect(element.shadowRoot?.querySelector("[name='scope']")).toBeNull();
    click(element, "[data-action='select'][data-server='advanced']");
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("edit with the server CLI");
    expect(element.shadowRoot?.querySelector("form")).toBeNull();
  });

  it("rejects case-insensitive duplicate guide names and confirms global server removal", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockResolvedValueOnce(response([]));
    const element = await mount(fetchImpl);
    for (const name of ["X-Key", "x-key"]) {
      click(element, "[data-action='add-header']");
      await element.updateComplete;
      const fields = element.shadowRoot!.querySelectorAll<HTMLInputElement>("[name='guide-name']");
      fields[fields.length - 1]!.value = name;
      fields[fields.length - 1]!.dispatchEvent(new Event("input", { bubbles: true }));
      await element.updateComplete;
    }
    submit(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("must be unique");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    element.confirmRemove = vi.fn(() => false);
    click(element, "[data-action='remove']");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    element.confirmRemove = vi.fn(() => true);
    click(element, "[data-action='remove']");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body)).toEqual({
      action: "remove-server",
      name: "docs",
    });
  });
  it("returns an expired session to the adapter", async () => {
    const element = document.createElement("platformclaw-mcp-administration") as AdminElement;
    element.fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "expired" }), { status: 401 }),
    );
    element.onUnauthenticated = vi.fn();
    document.body.append(element);
    await vi.waitFor(() => expect(element.onUnauthenticated).toHaveBeenCalledOnce());
  });

  it("blocks mutations while a reconnected administration page reloads its catalog", async () => {
    let finish!: (response: Response) => void;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(response([server("docs", { enabled: false })]));
    const element = await mount(fetchImpl);
    const previousForm = element.shadowRoot!.querySelector("form")!;
    const previousToggle =
      element.shadowRoot!.querySelector<HTMLInputElement>("[data-toggle='docs']")!;
    element.remove();
    document.body.append(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("form")).toBeNull();
    previousForm.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    expect(element.shadowRoot?.querySelector("[data-toggle='docs']")).toBeNull();
    previousToggle.checked = false;
    previousToggle.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    finish(response([server("docs", { target: "https://updated.example/mcp" })]));
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector<HTMLButtonElement>("[type='submit']")?.disabled,
      ).toBe(false),
    );
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body)).toMatchObject({
      url: "https://updated.example/mcp",
    });
  });

  it("clears an earlier load error after a successful reconnect reload", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Catalog unavailable" }), { status: 503 }),
      )
      .mockResolvedValueOnce(response([server()]));
    const element = await mount(fetchImpl);
    expect(element.shadowRoot?.textContent).toContain("Catalog unavailable");
    element.remove();
    document.body.append(element);
    await vi.waitFor(() => expect(element.shadowRoot?.querySelector("form")).not.toBeNull());
    expect(element.shadowRoot?.textContent).not.toContain("Catalog unavailable");
  });

  it("reloads after an interrupted save and rejects the previous connection's late result", async () => {
    let finishSave!: (response: Response) => void;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishSave = resolve;
          }),
      )
      .mockResolvedValueOnce(response([server("docs", { target: "https://current.example/mcp" })]))
      .mockResolvedValueOnce(response([server("docs", { target: "https://current.example/mcp" })]));
    const element = await mount(fetchImpl);
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    element.remove();
    document.body.append(element);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='url']")?.value).toBe(
        "https://current.example/mcp",
      ),
    );
    finishSave(response([server("docs", { target: "https://stale.example/mcp" })]));
    await element.updateComplete;
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    expect(requestBody(fetchImpl.mock.calls[3]?.[1]?.body)).toMatchObject({
      url: "https://current.example/mcp",
    });
  });
});
