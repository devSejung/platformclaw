/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderSkillHubAdmin, skillHubScopeLineageLabel } from "./admin.ts";

describe("Skill Hub namespace administration", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("shows restricted Global bindings and requires a reason for activation", () => {
    const container = document.createElement("div");
    render(
      renderSkillHubAdmin({
        open: true,
        loading: false,
        busy: false,
        bindings: [
          {
            namespace: "company",
            scopeKind: "global",
            visibilityCeiling: "NAMESPACE_ONLY",
            accessState: "restricted",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        scopes: [],
        unassigned: [],
        draft: {
          namespace: "new-company",
          scopeKind: "global",
          scopeId: "",
          visibilityCeiling: "NAMESPACE_ONLY",
          reason: "",
        },
        pendingAction: null,
        onClose: vi.fn(),
        onDraft: vi.fn(),
        onSave: vi.fn(),
        onRequestAction: vi.fn(),
        onPendingAction: vi.fn(),
        onConfirmAction: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Restricted");
    expect(container.textContent).toContain("Activate them only after reviewing");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Save binding"),
    );
    expect(save?.disabled).toBe(true);
  });

  it("renders immutable scope choices with their full lineage", () => {
    expect(
      skillHubScopeLineageLabel("part-2", [
        { id: "team-2", kind: "team", name: "Second Team" },
        { id: "group-2", kind: "group", name: "Engineering", parentScopeId: "team-2" },
        { id: "part-2", kind: "part", name: "Runtime", parentScopeId: "group-2" },
      ]),
    ).toBe("Second Team / Engineering / Runtime");
  });

  it("opens Global activation with a fresh required reason", () => {
    const container = document.createElement("div");
    const onRequestAction = vi.fn();
    render(
      renderSkillHubAdmin({
        open: true,
        loading: false,
        busy: false,
        bindings: [
          {
            namespace: "company",
            scopeKind: "global",
            visibilityCeiling: "NAMESPACE_ONLY",
            accessState: "restricted",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        scopes: [],
        unassigned: [],
        draft: {
          namespace: "another",
          scopeKind: "global",
          scopeId: "",
          visibilityCeiling: "NAMESPACE_ONLY",
          reason: "stale create reason",
        },
        pendingAction: null,
        onClose: vi.fn(),
        onDraft: vi.fn(),
        onSave: vi.fn(),
        onRequestAction,
        onPendingAction: vi.fn(),
        onConfirmAction: vi.fn(),
      }),
      container,
    );
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Activate Global"))
      ?.click();
    expect(onRequestAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "activate", reason: "" }),
    );
  });
});
