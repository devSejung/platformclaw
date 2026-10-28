/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformClawSkillHubSharingDetail } from "../../platformclaw/skill-hub.ts";
import {
  renderSkillHubSharing,
  skillHubSharingInvalid,
  skillHubSharingRequest,
} from "./sharing.ts";
import { skillHubConfig } from "./skill-hub.test-fixtures.ts";

afterEach(() => document.body.replaceChildren());

describe("Unavailable selected organizations", () => {
  it("keeps a newly selected organization identifiable after configuration reload and requires explicit removal", () => {
    const archived = { id: "old-part", kind: "part" as const, name: "Archived Part" };
    const active = { id: "active-part", kind: "part" as const, name: "Active Part" };
    let config = skillHubConfig({ scopes: [archived, active] });
    let draft: PlatformClawSkillHubSharingDetail = {
      mode: "SELECTED",
      userIds: [],
      scopeIds: [],
      users: [],
      scopes: [],
    };
    const container = document.createElement("div");
    document.body.append(container);
    const update = () =>
      render(
        html`${renderSkillHubSharing({
          draft,
          config,
          disabled: false,
          onChange: (next) => {
            draft = next;
            update();
          },
        })}`,
        container,
      );
    update();
    const checkbox = container.querySelector<HTMLInputElement>('[value="old-part"]')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(draft.scopeIds).toEqual(["old-part"]);
    config = skillHubConfig({ scopes: [active] });
    update();
    expect(container.querySelector('[value="old-part"]')).toBeNull();
    expect(container.querySelector(".skill-hub-unavailable-scopes")?.textContent).toContain(
      "Archived Part",
    );
    expect(draft.scopeIds).toEqual(["old-part"]);
    container
      .querySelector<HTMLButtonElement>(
        '[aria-label="Remove unavailable organization Archived Part"]',
      )!
      .click();
    expect(draft.mode).toBe("SELECTED");
    expect(skillHubSharingInvalid(draft)).toBe(true);
    const replacement = container.querySelector<HTMLInputElement>('[value="active-part"]')!;
    replacement.checked = true;
    replacement.dispatchEvent(new Event("change", { bubbles: true }));
    expect(skillHubSharingInvalid(draft)).toBe(false);
    expect(skillHubSharingRequest(draft)).toEqual({
      mode: "SELECTED",
      userIds: [],
      scopeIds: ["active-part"],
    });
    expect(container.querySelector(".skill-hub-unavailable-scopes")).toBeNull();
  });

  it("uses the selected ID when its name is unavailable and respects read-only controls", () => {
    const onChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`${renderSkillHubSharing({
        draft: { mode: "SELECTED", userIds: [], scopeIds: ["missing-name"], users: [], scopes: [] },
        config: skillHubConfig(),
        disabled: true,
        onChange,
      })}`,
      container,
    );
    expect(container.textContent).toContain("missing-name");
    const remove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove unavailable organization missing-name"]',
    )!;
    expect(remove.disabled).toBe(true);
    remove.click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
