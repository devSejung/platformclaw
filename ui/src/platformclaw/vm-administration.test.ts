import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPlatformClawVmAdministration } from "./vm-administration.ts";

const SNAPSHOT = {
  endpoints: [],
  hosts: [],
  agents: [
    {
      accountId: "person.one",
      agentId: "person_one",
      displayName: "Person One",
      department: "Platform",
    },
  ],
  allocations: [],
  auditEvents: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PlatformClaw VM administration", () => {
  afterEach(() => document.querySelector("platformclaw-vm-administration")?.remove());

  it("loads administration state only after the administrator opens it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SNAPSHOT));
    mountPlatformClawVmAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;

    expect(fetchImpl).not.toHaveBeenCalled();
    element.shadowRoot?.querySelector<HTMLElement>("[data-open]")?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("Person One"));

    expect(fetchImpl).toHaveBeenCalledWith(
      "/platformclaw/api/admin/vm",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(element.shadowRoot?.textContent).toContain("SafeConnect endpoints");
    expect(element.shadowRoot?.textContent).toContain("Employee assignments");
  });

  it("submits a new endpoint through the admin-only API", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(SNAPSHOT));
    mountPlatformClawVmAdministration({ fetchImpl, onUnauthenticated: vi.fn() });
    const element = document.querySelector("platformclaw-vm-administration")!;
    element.shadowRoot?.querySelector<HTMLElement>("[data-open]")?.click();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const form = element.shadowRoot?.querySelector<HTMLFormElement>(
      "form[data-action='endpoints']",
    );
    if (!form) {
      throw new Error("endpoint form is missing");
    }
    (form.elements.namedItem("label") as HTMLInputElement).value = "Corporate access";
    (form.elements.namedItem("host") as HTMLInputElement).value = "safeconnect.example.test";
    (form.elements.namedItem("adDomain") as HTMLInputElement).value = "example.test";
    form.requestSubmit();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const init = fetchImpl.mock.calls[1]?.[1];
    expect(init?.method).toBe("POST");
    if (typeof init?.body !== "string") {
      throw new Error("endpoint request body is missing");
    }
    expect(JSON.parse(init.body)).toEqual({
      action: "endpoints",
      label: "Corporate access",
      host: "safeconnect.example.test",
      port: 44_422,
      adDomain: "example.test",
    });
  });
});
