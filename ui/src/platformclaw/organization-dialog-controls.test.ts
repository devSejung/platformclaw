import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderOrganizationActionDialog,
  type OrganizationPendingAction,
} from "./organization-action-dialog.ts";
import {
  renderOrganizationJoinDialog,
  type OrganizationJoinAction,
} from "./organization-join-dialog.ts";

const actions: OrganizationPendingAction[] = [
  { kind: "add", scopeId: "scope", userId: "user", target: "Person" },
  { kind: "remove", scopeId: "scope", userId: "user", target: "Person", expectedRole: "member" },
  {
    kind: "role",
    scopeId: "scope",
    userId: "user",
    target: "Person",
    expectedRole: "member",
    role: "leader",
  },
  { kind: "rename", scopeId: "scope", scopeRevision: 1, target: "Group", currentName: "Group" },
  { kind: "archive", scopeId: "scope", scopeRevision: 1, target: "Group" },
];

describe("organization confirmation controls", () => {
  let container: HTMLDivElement;

  afterEach(() => container.remove());

  it.each(actions)(
    "shows required validation for whitespace in $kind and submits a corrected reason",
    (action) => {
      container = document.createElement("div");
      document.body.append(container);
      const onSubmit = vi.fn();
      render(
        renderOrganizationActionDialog({
          action,
          busy: false,
          error: "",
          onCancel: vi.fn(),
          onSubmit,
        }),
        container,
      );
      const form = container.querySelector("form")!;
      const reason = form.elements.namedItem("reason") as HTMLTextAreaElement;
      reason.value = "   ";
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      expect(reason.validity.valueMissing).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
      reason.value = "  Confirmed reason  ";
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      expect(onSubmit).toHaveBeenCalledWith({
        reason: "Confirmed reason",
        ...(action.kind === "rename" ? { name: "Group" } : {}),
      });
    },
  );

  it.each(["request", "cancel", "approve", "reject"] as const)(
    "shows required validation for whitespace in join %s",
    (kind) => {
      container = document.createElement("div");
      document.body.append(container);
      const onSubmit = vi.fn();
      const action: OrganizationJoinAction = { kind, id: "request", target: "Group" };
      render(
        renderOrganizationJoinDialog({
          action,
          busy: false,
          error: "",
          onCancel: vi.fn(),
          onSubmit,
        }),
        container,
      );
      const form = container.querySelector("form")!;
      const reason = form.elements.namedItem("reason") as HTMLTextAreaElement;
      reason.value = " \n ";
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      expect(reason.validity.valueMissing).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
      reason.value = "  Confirmed reason  ";
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      expect(onSubmit).toHaveBeenCalledWith("Confirmed reason");
    },
  );
});
