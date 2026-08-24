/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderSkillHubAdmin } from "./admin.ts";

describe("Skill Hub namespace administration", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("shows restricted Global bindings and prevents a silent staged Global save", () => {
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
            createdByUserId: "admin",
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
        },
        onClose: vi.fn(),
        onDraft: vi.fn(),
        onSave: vi.fn(),
        onRemove: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("Restricted");
    expect(container.textContent).toContain("administrator-only");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Save binding"),
    );
    expect(save?.disabled).toBe(true);
  });
});
