import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { PlatformClawVocDialogElement } from "./voc-dialog.ts";

afterEach(async () => {
  document.body.innerHTML = "";
  await i18n.setLocale("en");
});

describe("platformclaw-voc-dialog", () => {
  it("confirms before submitting and shows the Jira issue", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            issueKey: "VOC-42",
            issueUrl: "https://jira.company.example/browse/VOC-42",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
    );
    const element = document.createElement(
      "platformclaw-voc-dialog",
    ) as PlatformClawVocDialogElement;
    element.fetchImpl = fetchImpl;
    document.body.append(element);
    await element.updateComplete;
    const title = element.shadowRoot?.querySelector<HTMLInputElement>("input");
    const description = element.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
    expect(title?.placeholder).toBe("Please enter a title");
    expect(description?.placeholder).toBe(
      "- Pain points\n- Things that would be nice to improve\n- Features that would be nice to add",
    );
    if (title && description) {
      title.value = "Improve onboarding";
      title.dispatchEvent(new InputEvent("input"));
      description.value = "Add a short example.";
      description.dispatchEvent(new InputEvent("input"));
    }
    await element.updateComplete;
    element.shadowRoot?.querySelector<HTMLButtonElement>("footer .primary")?.click();
    await element.updateComplete;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(element.shadowRoot?.textContent).toContain("Register this VOC in Jira?");

    element.shadowRoot?.querySelector<HTMLButtonElement>("footer .primary")?.click();
    await vi.waitFor(() => expect(element.shadowRoot?.textContent).toContain("VOC-42"));
    expect(fetchImpl).toHaveBeenCalledWith(
      "/platformclaw/api/voc",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });
});
