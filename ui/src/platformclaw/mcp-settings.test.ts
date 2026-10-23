import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./mcp-settings.ts";
import { PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT } from "./mcp-catalog-events.ts";
import type { McpServerSetting } from "./mcp-settings-model.ts";

type SettingsElement = HTMLElement & {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
  navigate: (url: string) => void;
  confirmRemove: (message: string) => boolean;
  updateComplete: Promise<boolean>;
};
function server(serverName = "docs", overrides: Partial<McpServerSetting> = {}): McpServerSetting {
  return {
    serverName,
    origin: "organization",
    credentialMode: "personal",
    auth: "api_key",
    headerName: "X-API-Key",
    globalEnabled: true,
    userEnabled: true,
    settingsRevision: 7,
    policyFingerprint: "policy-original",
    credentialStored: false,
    credentialFingerprint: null,
    configured: false,
    headerGuides: [{ name: "X-Tenant", description: "Your tenant ID" }],
    headers: [],
    ...overrides,
  };
}
function response(servers: ReturnType<typeof server>[], status = 200) {
  return new Response(JSON.stringify({ servers }), {
    status,
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
  const element = document.createElement("platformclaw-mcp-settings") as SettingsElement;
  element.fetchImpl = fetchImpl;
  element.onUnauthenticated = vi.fn();
  document.body.append(element);
  await vi.waitFor(() =>
    expect(
      element.shadowRoot?.querySelector("[data-action='refresh']")?.hasAttribute("disabled"),
    ).toBe(false),
  );
  return element;
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
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
}
function click(element: SettingsElement, selector: string) {
  element.shadowRoot!.querySelector<HTMLButtonElement>(selector)!.click();
}
async function idle(element: SettingsElement) {
  await element.updateComplete;
  await vi.waitFor(() =>
    expect(
      element.shadowRoot!.querySelector<HTMLButtonElement>("[data-action='refresh']")!.disabled,
    ).toBe(false),
  );
}
async function toggleServer(element: SettingsElement, name: string, checked: boolean) {
  const field = element.shadowRoot!.querySelector<HTMLInputElement>(`[data-toggle='${name}']`)!;
  field.checked = checked;
  field.dispatchEvent(new Event("change", { bubbles: true }));
  await element.updateComplete;
  await idle(element);
}

afterEach(async () => {
  document.querySelectorAll("platformclaw-mcp-settings").forEach((element) => element.remove());
  window.history.replaceState(null, "", "/");
  await i18n.setLocale("en");
});

describe("PlatformClaw personal MCP settings", () => {
  it("keeps an edited snapshot stale across another row response and a same-server toggle", async () => {
    const alpha = server("alpha", {
      configured: true,
      headers: [{ name: "X-A", configured: true }],
    });
    const beta = server("beta", { credentialMode: "none" });
    const newer: McpServerSetting = {
      ...alpha,
      settingsRevision: 8,
      headers: [...alpha.headers, { name: "X-B", configured: true }],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([alpha, beta]))
      .mockResolvedValueOnce(
        response([newer, { ...beta, userEnabled: false, settingsRevision: 8 }]),
      )
      .mockResolvedValueOnce(
        response([{ ...newer, userEnabled: false, settingsRevision: 9 }, beta]),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Settings changed. Reload saved settings." }), {
          status: 409,
        }),
      );
    const element = await mount(fetchImpl);
    await input(element, "[name='guide-value']", "unsaved");
    await toggleServer(element, "beta", false);
    await toggleServer(element, "alpha", false);
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body).expectedRevision).toBe(8);
    expect(requestBody(fetchImpl.mock.calls[3]?.[1]?.body).expectedRevision).toBe(7);
    await idle(element);
    expect(element.shadowRoot?.textContent).toContain("Settings changed");
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='guide-value']")?.value).toBe(
      "unsaved",
    );
  });

  it("refreshes an untouched snapshot after another row reveals newly saved headers", async () => {
    const alpha = server("alpha", { credentialMode: "none", headerGuides: [] });
    const beta = server("beta", { credentialMode: "none" });
    const newer: McpServerSetting = {
      ...alpha,
      settingsRevision: 8,
      headers: [{ name: "X-New", configured: true }],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([alpha, beta]))
      .mockResolvedValueOnce(response([newer, beta]))
      .mockResolvedValueOnce(response([{ ...newer, settingsRevision: 9 }, beta]));
    const element = await mount(fetchImpl);
    await toggleServer(element, "beta", false);
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body)).toMatchObject({
      expectedRevision: 8,
      headers: [{ name: "X-New" }],
    });
  });

  it("keeps the original policy identity until explicit reload when an administrator changes authentication", async () => {
    const changed = server("docs", { auth: "bearer", policyFingerprint: "policy-changed" });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockResolvedValueOnce(response([changed]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "Reload MCP settings and re-enter changed values before saving.",
          }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(response([changed]))
      .mockResolvedValueOnce(response([{ ...changed, settingsRevision: 8, configured: true }]));
    const element = await mount(fetchImpl);
    await input(element, "[name='secret']", "old-policy-secret");
    window.dispatchEvent(new Event(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await idle(element);
    submit(element);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("re-enter changed values"),
    );
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body).expectedPolicyFingerprint).toBe(
      "policy-original",
    );
    click(element, "[data-action='refresh']");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    await idle(element);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.value).toBe("");
    await input(element, "[name='secret']", "new-policy-secret");
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(5));
    expect(requestBody(fetchImpl.mock.calls[4]?.[1]?.body)).toMatchObject({
      expectedPolicyFingerprint: "policy-changed",
      credential: { kind: "bearer", secret: "new-policy-secret" },
    });
  });

  it("keeps a new duplicate row editable and removable without deleting its saved counterpart", async () => {
    const entry = server("docs", {
      headerGuides: [],
      headers: [{ name: "X-Saved", configured: true }],
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([entry]))
      .mockResolvedValueOnce(response([{ ...entry, settingsRevision: 8 }]));
    const element = await mount(fetchImpl);
    click(element, "[data-action='add-header']");
    await element.updateComplete;
    const row = element.shadowRoot!.querySelectorAll<HTMLElement>(".custom-row")[1]!;
    const name = row.querySelector<HTMLInputElement>("[name='custom-name']")!;
    name.value = "x-saved";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    submit(element);
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("must be unique");
    expect(name.readOnly).toBe(false);
    row.querySelector<HTMLButtonElement>("[data-action='remove-header']")!.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelectorAll(".custom-row")).toHaveLength(1);
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body).headers).toEqual([{ name: "X-Saved" }]);
  });

  it("keeps committed-but-not-refreshed feedback visible after the credential-needed filter removes its row", async () => {
    const committed = server("docs", {
      configured: true,
      credentialStored: true,
      settingsRevision: 8,
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            saved: true,
            servers: [committed],
            error: "Save again to retry active connections.",
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(response([{ ...committed, settingsRevision: 9 }]));
    const element = await mount(fetchImpl);
    const filter = element.shadowRoot!.querySelector<HTMLSelectElement>("[name='statusFilter']")!;
    filter.value = "needs";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    await input(element, "[name='secret']", "committed");
    submit(element);
    await idle(element);
    expect(element.shadowRoot?.querySelectorAll(".server-row")).toHaveLength(0);
    expect(element.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain(
      "docs: Save again",
    );
    click(element, "[data-action='show-feedback-server']");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.value).toBe("");
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body)).toMatchObject({
      expectedRevision: 8,
      headers: [],
    });
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body)).not.toHaveProperty("credential");
  });

  it("serializes reload with edits and writes so its old GET cannot undo a successful save", async () => {
    let completeReload!: (value: Response) => void;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            completeReload = resolve;
          }),
      )
      .mockResolvedValueOnce(response([server("docs", { settingsRevision: 9 })]));
    const element = await mount(fetchImpl);
    click(element, "[data-action='refresh']");
    await element.updateComplete;
    expect(
      element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='save']")?.disabled,
    ).toBe(true);
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.disabled).toBe(
      true,
    );
    submit(element);
    window.dispatchEvent(new Event(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT));
    await element.updateComplete;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    completeReload(response([server("docs", { settingsRevision: 8 })]));
    await idle(element);
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body).expectedRevision).toBe(8);
  });

  it("clears a failed load alert when the next reload succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Catalog unavailable" }), { status: 503 }),
      )
      .mockResolvedValueOnce(response([server()]));
    const element = await mount(fetchImpl);
    expect(element.shadowRoot?.querySelector("[role='alert']")?.textContent).toContain(
      "Catalog unavailable",
    );
    click(element, "[data-action='refresh']");
    await idle(element);
    expect(element.shadowRoot?.textContent).not.toContain("Catalog unavailable");
    expect(element.shadowRoot?.querySelector("form")).not.toBeNull();
  });

  it.each(["personal", "shared", "none"] as const)(
    "allows deleting a retained invalid credential under the %s policy",
    async (credentialMode) => {
      const entry = server("docs", { credentialMode, configured: false, credentialStored: true });
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([entry]))
        .mockResolvedValueOnce(new Response(JSON.stringify({ removed: true })))
        .mockResolvedValueOnce(response([{ ...entry, credentialStored: false }]));
      const element = await mount(fetchImpl);
      element.confirmRemove = vi.fn(() => true);
      if (credentialMode === "personal") {
        expect(
          element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.disabled,
        ).toBe(false);
      } else {
        expect(element.shadowRoot?.querySelector("[name='secret']")).toBeNull();
      }
      click(element, "[data-action='remove']");
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
      await idle(element);
      expect(fetchImpl.mock.calls[1]?.[0]).toBe("/platformclaw/api/mcp/credential");
      expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("DELETE");
      expect(element.shadowRoot?.querySelector("[data-action='remove']")).toBeNull();
      expect(element.shadowRoot?.textContent).toContain("Personal credential deleted");
    },
  );
  it("offers deletion only for saved guide values and clears a new input without claiming it was saved", async () => {
    const element = await mount(vi.fn<typeof fetch>(async () => response([server()])));
    expect(element.shadowRoot?.querySelector("[data-action='remove-header']")).toBeNull();
    await input(element, "[name='guide-value']", "new-value");
    expect(element.shadowRoot?.textContent).toContain("Clear value");
    expect(element.shadowRoot?.textContent).not.toContain("Delete saved value");
    click(element, "[data-action='remove-header']");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='guide-value']")?.value).toBe(
      "",
    );
    expect(element.shadowRoot?.querySelector("[data-action='remove-header']")).toBeNull();
  });
  it("adopts committed metadata after disposal fails and retries with the new revision without plaintext", async () => {
    const committed = server("docs", {
      configured: true,
      settingsRevision: 8,
      headers: [{ name: "X-Tenant", configured: true }],
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            saved: true,
            servers: [committed],
            error:
              "Settings were saved, but connections could not be refreshed. Save again to retry.",
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(response([{ ...committed, settingsRevision: 9 }]));
    const element = await mount(fetchImpl);
    await input(element, "[name='secret']", "committed-secret");
    await input(element, "[name='guide-value']", "committed-header");
    submit(element);
    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Save again to retry"),
    );
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.value).toBe("");
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='guide-value']")?.value).toBe(
      "",
    );
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body)).toEqual({
      serverName: "docs",
      expectedRevision: 8,
      expectedPolicyFingerprint: "policy-original",
      enabled: true,
      headers: [{ name: "X-Tenant" }],
    });
  });

  it("reloads the current revision after a conflict and discards only explicitly reloaded drafts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server()]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Settings changed. Reload saved settings." }), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(response([server("docs", { settingsRevision: 10 })]))
      .mockResolvedValueOnce(response([server("docs", { settingsRevision: 11 })]));
    const element = await mount(fetchImpl);
    await input(element, "[name='guide-value']", "old-draft");
    submit(element);
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Settings changed"));
    click(element, "[data-action='refresh']");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector<HTMLInputElement>("[name='guide-value']")?.value,
      ).toBe(""),
    );
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    expect(requestBody(fetchImpl.mock.calls[3]?.[1]?.body).expectedRevision).toBe(10);
  });
  it("shows every organization credential policy and enforces administrator Off", async () => {
    const servers = [
      server("docs"),
      server("public", { credentialMode: "none", auth: undefined }),
      server("shared", { credentialMode: "shared", auth: undefined }),
      server("off", { globalEnabled: false, configured: true }),
    ];
    const element = await mount(vi.fn<typeof fetch>(async () => response(servers)));
    expect(element.shadowRoot?.textContent).toContain("Organization credential applied");
    expect(element.shadowRoot?.textContent).toContain("No personal credential required");
    expect(
      element.shadowRoot?.querySelector<HTMLInputElement>("[data-toggle='off']")?.disabled,
    ).toBe(true);
    expect(element.shadowRoot?.querySelector("[data-action='add']")).toBeNull();
    click(element, "[data-action='select'][data-server='shared']");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("[name='secret']")).toBeNull();
    expect(element.shadowRoot?.querySelector("[data-action='add-header']")).not.toBeNull();
  });

  it("atomically saves one credential and filled optional headers while preserving stored values", async () => {
    const initial = server("docs", { headers: [{ name: "X-Saved", configured: true }] });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([initial]))
      .mockResolvedValueOnce(
        response([
          server("docs", {
            configured: true,
            settingsRevision: 8,
            headers: [
              { name: "X-Saved", configured: true },
              { name: "X-Custom", configured: true },
            ],
          }),
        ]),
      );
    const element = await mount(fetchImpl);
    expect(
      element.shadowRoot?.querySelector<HTMLInputElement>("[name='custom-value']")?.value,
    ).toBe("");
    await input(element, "[name='secret']", "employee-secret");
    click(element, "[data-action='add-header']");
    await element.updateComplete;
    const rows = element.shadowRoot!.querySelectorAll<HTMLElement>(".custom-row");
    const row = rows[rows.length - 1]!;
    const key = row.querySelector<HTMLInputElement>("[name='custom-name']")!;
    key.value = "X-Custom";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    const value = row.querySelector<HTMLInputElement>("[name='custom-value']")!;
    value.value = "project";
    value.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body)).toEqual({
      serverName: "docs",
      expectedRevision: 7,
      expectedPolicyFingerprint: "policy-original",
      enabled: true,
      headers: [{ name: "X-Saved" }, { name: "X-Custom", value: "project" }],
      credential: { kind: "api_key", secret: "employee-secret" },
      expectedCredentialFingerprint: null,
    });
    await vi.waitFor(() =>
      expect(element.shadowRoot?.textContent).toContain("Your settings were saved"),
    );
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.value).toBe("");
    expect(element.shadowRoot?.textContent).not.toContain("employee-secret");
  });

  it("retains per-server drafts across search, selection, pagination, and another row toggle", async () => {
    const servers = Array.from({ length: 13 }, (_, index) =>
      server(`server-${String(index).padStart(2, "0")}`, {
        credentialMode: "none",
        auth: undefined,
      }),
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(servers))
      .mockResolvedValueOnce(
        response(
          servers.map((entry) =>
            entry.serverName === "server-01"
              ? Object.assign({}, entry, { userEnabled: false, settingsRevision: 8 })
              : entry,
          ),
        ),
      );
    const element = await mount(fetchImpl);
    expect(element.shadowRoot?.querySelectorAll(".server-row")).toHaveLength(6);
    await input(element, "[name='guide-value']", "unsaved-value");
    const toggle = element.shadowRoot!.querySelector<HTMLInputElement>(
      "[data-toggle='server-01']",
    )!;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body)).toEqual({
      serverName: "server-01",
      expectedRevision: 7,
      enabled: false,
    });
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='guide-value']")?.value).toBe(
      "unsaved-value",
    );
    click(element, "[data-action='next']");
    await element.updateComplete;
    expect(element.shadowRoot?.textContent).toContain("7–12 / 13");
    await input(element, "[name='search']", "server-12");
    expect(element.shadowRoot?.querySelectorAll(".server-row")).toHaveLength(1);
    await input(element, "[name='search']", "");
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='guide-value']")?.value).toBe(
      "unsaved-value",
    );
    click(element, "[data-action='picker']");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".workspace")?.hasAttribute("data-picking")).toBe(
      true,
    );
    click(element, "[data-action='select'][data-server='server-00']");
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector(".workspace")?.hasAttribute("data-picking")).toBe(
      false,
    );
  });

  it("preserves a changed-but-empty stored field and deletes only by explicit action", async () => {
    const entry = server("docs", {
      configured: true,
      headers: [{ name: "X-Tenant", configured: true }],
      headerError: "Remove the conflicting header and save again.",
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([entry]))
      .mockResolvedValueOnce(response([{ ...entry, settingsRevision: 8 }]))
      .mockResolvedValueOnce(
        response([{ ...entry, settingsRevision: 9, headers: [], headerError: undefined }]),
      );
    const element = await mount(fetchImpl);
    expect(element.shadowRoot?.textContent).toContain("Remove the conflicting header");
    click(element, "[data-action='change-header']");
    await element.updateComplete;
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='save']")?.disabled,
      ).toBe(false),
    );
    expect(requestBody(fetchImpl.mock.calls[1]?.[1]?.body).headers).toEqual([{ name: "X-Tenant" }]);
    click(element, "[data-action='remove-header']");
    await element.updateComplete;
    submit(element);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(requestBody(fetchImpl.mock.calls[2]?.[1]?.body).headers).toEqual([
      { name: "X-Tenant", value: "" },
    ]);
  });

  it("retains secret drafts after a conflict and does not turn missing authentication into On", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server("docs", { userEnabled: false })]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Settings changed. Reload and try again." }), {
          status: 409,
        }),
      );
    const element = await mount(fetchImpl);
    const toggle = element.shadowRoot!.querySelector<HTMLInputElement>("[data-toggle='docs']")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(element.shadowRoot?.textContent).toContain("complete OAuth before turning");
    await input(element, "[name='secret']", "retry-secret");
    submit(element);
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Settings changed"));
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='secret']")?.value).toBe(
      "retry-secret",
    );
  });

  it("rejects duplicate header names without losing the entered draft", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response([server()]));
    const element = await mount(fetchImpl);
    click(element, "[data-action='add-header']");
    await element.updateComplete;
    await input(element, "[name='custom-name']", "x-tenant");
    submit(element);
    await element.updateComplete;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(element.shadowRoot?.textContent).toContain("must be unique");
    expect(element.shadowRoot?.querySelector<HTMLInputElement>("[name='custom-name']")?.value).toBe(
      "x-tenant",
    );
  });

  it("navigates only to a safe OAuth URL and consumes callback feedback once", async () => {
    window.history.replaceState(null, "", "/platformclaw/app/settings/mcp?mcpOAuth=success");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([server("oauth", { auth: "oauth", scope: "read" })]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "redirect",
            authorizationUrl: "https://auth.example.test/start",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "redirect", authorizationUrl: "javascript:alert(1)" }),
        ),
      );
    const element = await mount(fetchImpl);
    const navigate = vi.fn();
    element.navigate = navigate;
    expect(element.shadowRoot?.textContent).toContain("OAuth connection completed");
    expect(window.location.search).toBe("");
    click(element, "[data-action='oauth']");
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://auth.example.test/start"),
    );
    await vi.waitFor(() =>
      expect(
        element.shadowRoot?.querySelector<HTMLButtonElement>("[data-action='oauth']")?.disabled,
      ).toBe(false),
    );
    click(element, "[data-action='oauth']");
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector("[role='alert']")).not.toBeNull(),
    );
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it("returns expired sessions to the adapter", async () => {
    const element = document.createElement("platformclaw-mcp-settings") as SettingsElement;
    element.fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "expired" }), { status: 401 }),
    );
    element.onUnauthenticated = vi.fn();
    document.body.append(element);
    await vi.waitFor(() => expect(element.onUnauthenticated).toHaveBeenCalledOnce());
  });
});
