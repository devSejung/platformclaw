/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createProps, normalizeText } from "./view.test-helpers.ts";
import { renderSkills } from "./view.ts";

describe("Skills empty-state recovery", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await i18n.setLocale("en");
  });

  it.each(["platform_server", "assigned_vm"] as const)(
    "offers the allowed Skill Hub route for an empty %s workspace",
    (executionTarget) => {
      const props = createProps({ personalAccess: true, onBrowseSkillHub: vi.fn() });
      props.report = { ...props.report!, executionTarget, skills: [] };
      const container = document.createElement("div");
      render(renderSkills(props), container);
      expect(normalizeText(container.querySelector(".settings-empty")!)).toBe(
        "No skills are available in this workspace yet. Find skills in Skill Hub",
      );
      container.querySelector<HTMLButtonElement>(".settings-empty button")!.click();
      expect(props.onBrowseSkillHub).toHaveBeenCalledOnce();
      expect(container.querySelectorAll("wa-switch.settings-toggle")).toHaveLength(0);
    },
  );

  it("does not offer a Skill Hub route when the owner has not provided it", () => {
    const props = createProps({ personalAccess: true });
    props.report = { ...props.report!, skills: [] };
    const container = document.createElement("div");
    render(renderSkills(props), container);
    expect(normalizeText(container.querySelector(".settings-empty")!)).toBe(
      "No skills are available in this workspace yet.",
    );
    expect(container.querySelector(".settings-empty button")).toBeNull();
  });

  it.each([{ filter: "missing" }, { statusFilter: "disabled" as const }])(
    "offers to clear unmatched filters without suggesting the workspace is empty: %j",
    (filter) => {
      const onFilterChange = vi.fn();
      const onStatusFilterChange = vi.fn();
      const props = createProps({ ...filter, onFilterChange, onStatusFilterChange });
      const container = document.createElement("div");
      render(renderSkills(props), container);
      expect(normalizeText(container.querySelector(".settings-empty")!)).toBe(
        "No skills match your filters. Clear filters",
      );
      container.querySelector<HTMLButtonElement>(".settings-empty button")!.click();
      expect(onFilterChange).toHaveBeenCalledWith("");
      expect(onStatusFilterChange).toHaveBeenCalledWith("all");
    },
  );

  it.each([
    { connected: false, loading: false, error: null, expected: "Not connected to gateway." },
    { connected: true, loading: true, error: null, expected: "Loading…" },
    { connected: true, loading: false, error: "Workspace unavailable", expected: null },
  ])("does not describe an unread workspace as empty: %j", (state) => {
    const container = document.createElement("div");
    render(renderSkills(createProps({ ...state, report: null })), container);
    expect(container.querySelector(".settings-empty")?.textContent?.trim() ?? null).toBe(
      state.expected,
    );
    expect(normalizeText(container)).not.toContain("No skills are available");
  });
});
