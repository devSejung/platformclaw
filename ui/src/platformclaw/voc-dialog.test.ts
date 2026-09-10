import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./voc-dialog.ts";

afterEach(async () => {
  document.body.innerHTML = "";
  await i18n.setLocale("en");
});

describe("platformclaw-voc-dialog", () => {
  it("disables every dismissal button while submitting and restores them after failure", async () => {
    let rejectSubmit!: (error: Error) => void;
    const element = document.createElement("platformclaw-voc-dialog") as HTMLElement & {
      fetchImpl: typeof fetch;
      updateComplete: Promise<unknown>;
    };
    element.fetchImpl = vi.fn(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectSubmit = reject;
        }),
    );
    document.body.append(element);
    await element.updateComplete;
    const root = element.shadowRoot!;
    for (const [selector, value] of [
      ["input", "Preview issue"],
      ["textarea", "UI-only test"],
    ]) {
      const input = root.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new InputEvent("input"));
    }
    await element.updateComplete;
    root.querySelector<HTMLButtonElement>("footer .primary")!.click();
    await element.updateComplete;
    root.querySelector<HTMLButtonElement>("footer .primary")!.click();
    await element.updateComplete;
    expect(
      [...root.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled),
    ).toBe(true);
    const cancel = new CustomEvent("modal-cancel", { cancelable: true });
    root.querySelector("openclaw-modal-dialog")!.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    rejectSubmit(new Error("Cannot submit right now"));
    await vi.waitFor(() =>
      expect(root.querySelector("[role=alert]")?.textContent).toContain("Cannot submit"),
    );
    expect(root.querySelector<HTMLButtonElement>(".close")!.disabled).toBe(false);
    expect(root.querySelector<HTMLInputElement>("input")!.value).toBe("Preview issue");
  });

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
    const element = document.createElement("platformclaw-voc-dialog") as HTMLElement & {
      fetchImpl: typeof fetch;
      updateComplete: Promise<unknown>;
      shadowRoot: ShadowRoot;
    };
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
