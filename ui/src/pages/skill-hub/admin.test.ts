/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderSkillHubAdmin } from "./admin.ts";
import { skillHubScopeLineageLabel } from "./scope-lineage.ts";

describe("Skill Hub namespace administration", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("keeps default Global immutable while preserving custom and organization actions", () => {
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
          {
            namespace: "global",
            scopeKind: "global",
            visibilityCeiling: "NAMESPACE_ONLY",
            accessState: "active",
            createdAt: 1,
            updatedAt: 1,
          },
          {
            namespace: "team-tools",
            scopeKind: "team",
            scopeId: "team-one",
            visibilityCeiling: "NAMESPACE_ONLY",
            accessState: "active",
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
        onRequestAction,
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
    const [custom, global, team] = container.querySelectorAll(".skill-hub-admin__list article");
    expect(custom!.querySelectorAll("button")).toHaveLength(2);
    expect(global!.querySelector("button")).toBeNull();
    expect(team!.querySelectorAll("button")).toHaveLength(1);
    team!.querySelector<HTMLButtonElement>("button")!.click();
    expect(onRequestAction).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ namespace: "team-tools" }),
        action: "remove",
      }),
    );
  });

  it.each(["global", " GLOBAL "])(
    "prevents organizational or Private policy for the default namespace %j",
    (namespace) => {
      const container = document.createElement("div");
      const onDraft = vi.fn();
      const props = {
        open: true,
        loading: false,
        busy: false,
        bindings: [],
        scopes: [{ id: "team-one", kind: "team" as const, name: "Team One" }],
        unassigned: [],
        draft: {
          namespace: "team-tools",
          scopeKind: "team" as const,
          scopeId: "team-one",
          visibilityCeiling: "PRIVATE" as const,
          reason: "update namespace policy",
        },
        pendingAction: null,
        onClose: vi.fn(),
        onDraft,
        onSave: vi.fn(),
        onRequestAction: vi.fn(),
        onPendingAction: vi.fn(),
        onConfirmAction: vi.fn(),
      };
      render(renderSkillHubAdmin(props), container);
      const input = container.querySelector<HTMLInputElement>("input")!;
      input.value = namespace;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const canonicalDraft = {
        namespace,
        scopeKind: "global" as const,
        scopeId: "",
        visibilityCeiling: "NAMESPACE_ONLY" as const,
        reason: "update namespace policy",
      };
      expect(onDraft).toHaveBeenCalledWith(canonicalDraft);
      render(renderSkillHubAdmin({ ...props, draft: canonicalDraft }), container);
      const scope = container.querySelector<HTMLSelectElement>("select")!;
      expect(scope.value).toBe("global");
      expect(scope.disabled).toBe(true);
      expect(container.querySelector<HTMLOptionElement>('option[value="PRIVATE"]')?.disabled).toBe(
        true,
      );
    },
  );

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
