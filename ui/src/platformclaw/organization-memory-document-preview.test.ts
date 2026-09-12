/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { isOrganizationMemoryPath } from "./organization-memory-document-preview.ts";

afterEach(() => document.body.replaceChildren());
it("opens compiler Markdown links through authorized organization reads", async () => {
  const request = vi.fn(async (_method, params) => ({
    title: params.path,
    path: params.path,
    kind: "part",
    provenanceLabel: "Demo",
    updatedAt: new Date(1).toISOString(),
    fromLine: 1,
    lineCount: 3,
    totalLines: 3,
    content: "[Related](organization/part/target.2)\n\n[Private](wiki/private.md)",
  }));
  const element = document.createElement(
    "platformclaw-organization-memory-document-preview",
  ) as HTMLElement & {
    client: unknown;
    connected: boolean;
    getAdvertised: boolean;
    agentId: string;
    path: string;
  };
  Object.assign(element, {
    client: { request },
    connected: true,
    getAdvertised: true,
    agentId: "leader",
    path: "organization/part/source",
  });
  document.body.append(element);
  await waitForFast(() => expect(element.querySelector("a")).not.toBeNull());
  element.querySelector<HTMLAnchorElement>("a")!.click();
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("platformclaw.memory.get", {
      agentId: "leader",
      path: "organization/part/target.2",
      fromLine: 1,
      lineCount: 200,
    }),
  );
  expect(isOrganizationMemoryPath("wiki/private.md")).toBe(false);
  expect(isOrganizationMemoryPath("organization/part/..")).toBe(false);
  const parentCancel = vi.fn();
  document.body.addEventListener("modal-cancel", parentCancel, { once: true });
  element
    .querySelector("openclaw-modal-dialog")!
    .dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
  expect(parentCancel).not.toHaveBeenCalled();
});

it("replaces bounded source pages without submitting the enclosing review form", async () => {
  const request = vi.fn(async (_method, params) => ({
    title: "Approved source",
    path: params.path,
    kind: "part",
    provenanceLabel: "Permitted Part",
    updatedAt: new Date(1).toISOString(),
    fromLine: params.fromLine,
    lineCount: params.fromLine === 1 ? 200 : 1,
    totalLines: 201,
    textTruncated: false,
    verification: {
      approvalStatus: "approved",
      revision: 7,
      sourceRevision: 2,
      sourceStatus: "current",
    },
    content: params.fromLine === 1 ? "# First page" : "# Last page",
  }));
  const form = document.createElement("form");
  const submit = vi.fn((event: Event) => event.preventDefault());
  form.addEventListener("submit", submit);
  const element = document.createElement("platformclaw-organization-memory-document-preview");
  Object.assign(element, {
    client: { request },
    connected: true,
    getAdvertised: true,
    agentId: "leader",
    path: "organization/part/source",
  });
  form.append(element);
  document.body.append(form);
  await waitForFast(() =>
    expect(element.querySelector(".md-preview-dialog__reader h1")?.textContent).toBe("First page"),
  );
  expect(element.textContent).toContain("Permitted Part");
  expect(element.querySelector("[data-memory-verification]")?.textContent).toContain("7");
  expect(element.querySelector(".wiki-document__actions")?.textContent).not.toContain("Edit");
  const buttons = element.querySelectorAll<HTMLButtonElement>("footer button");
  expect(buttons[0].disabled).toBe(true);
  buttons[1].click();
  await waitForFast(() =>
    expect(element.querySelector("article h1")?.textContent).toBe("Last page"),
  );
  expect(element.textContent).not.toContain("First page");
  expect(element.querySelectorAll<HTMLButtonElement>("footer button")[1].disabled).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  expect(request).toHaveBeenLastCalledWith("platformclaw.memory.get", {
    agentId: "leader",
    path: "organization/part/source",
    fromLine: 201,
    lineCount: 200,
  });
});
