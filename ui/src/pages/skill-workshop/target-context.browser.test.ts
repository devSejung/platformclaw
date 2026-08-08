import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import { createSkillWorkshopHistoryScanState } from "./state.ts";
import type { SkillWorkshopExecutionTarget, SkillWorkshopProps } from "./view-types.ts";
import { renderSkillWorkshop } from "./view.ts";

function proposalFor(target: "basic" | "vm"): SkillWorkshopProposal {
  return {
    key: `proposal-${target}`,
    slug: `proposal-${target}`,
    name: `${target} proposal`,
    oneLine: "Target context coverage",
    body: "## Workflow\n- Verify the target.",
    status: "pending",
    version: 1,
    revisionHash: null,
    createdAt: Date.now(),
    recencyGroup: "today",
    ageLabel: "now",
    supportFiles: [],
    isNew: false,
    ...(target === "vm" ? { targetLabel: "Development VM" } : {}),
  };
}

function propsFor(
  currentExecutionTarget: SkillWorkshopExecutionTarget,
  proposal: SkillWorkshopProposal,
  mode: SkillWorkshopProps["mode"],
): SkillWorkshopProps {
  return {
    access: {
      canEvaluate: true,
      canApply: true,
      canRevise: true,
      canReject: true,
      canScanHistory: true,
    },
    loading: false,
    error: null,
    inspectingKey: null,
    proposals: [proposal],
    selectedKey: proposal.key,
    statusFilter: "pending",
    query: "",
    filePreviewKey: null,
    filePreviewQuery: "",
    queueWidth: 360,
    mode,
    actionBusy: null,
    actionNotice: null,
    revisionKey: null,
    revisionDraft: "",
    assistantName: "OpenClaw",
    workshopAgentName: "Research",
    currentExecutionTarget,
    selfLearning: null,
    historyScan: createSkillWorkshopHistoryScanState(),
    counts: { all: 1, pending: 1, applied: 0, rejected: 0, quarantined: 0, stale: 0 },
    onStatusFilterChange: vi.fn(),
    onRetry: vi.fn(),
    onQueryChange: vi.fn(),
    onFilePreviewQueryChange: vi.fn(),
    onQueueWidthChange: vi.fn(),
    onModeChange: vi.fn(),
    onSelect: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onApply: vi.fn(),
    onEvaluate: vi.fn(),
    onRevise: vi.fn(),
    onReject: vi.fn(),
    onRevisionDraftChange: vi.fn(),
    onRevisionCancel: vi.fn(),
    onRevisionSubmit: vi.fn(),
    onPreviewFile: vi.fn(),
    onClosePreview: vi.fn(),
    onSelfLearningToggle: vi.fn(),
    onHistoryScan: vi.fn(),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Skill Workshop execution target context", () => {
  it.each([
    ["board", "platform_server", "basic"],
    ["board", "assigned_vm", "vm"],
    ["today", "platform_server", "basic"],
    ["today", "assigned_vm", "vm"],
  ] as const)(
    "keeps target actions available for matching %s proposals",
    (mode, current, target) => {
      const container = document.createElement("div");
      document.body.append(container);
      render(renderSkillWorkshop(propsFor(current, proposalFor(target), mode)), container);

      const actions = container.querySelectorAll<HTMLButtonElement>(
        mode === "board" ? ".sw-action-bar button" : ".sw-today__actions button",
      );
      expect(actions).toHaveLength(4);
      expect([...actions].every((button) => !button.disabled)).toBe(true);
      expect(container.querySelector(".sw-target-warning")).toBeNull();
      expect(container.textContent).toContain("Current work location:");

      render(nothing, container);
    },
  );

  it.each([
    ["board", "platform_server", "vm", "Development VM"],
    ["board", "assigned_vm", "basic", "Basic workspace"],
    ["today", "platform_server", "vm", "Development VM"],
    ["today", "assigned_vm", "basic", "Basic workspace"],
  ] as const)(
    "blocks target-dependent %s actions for a mismatched proposal",
    (mode, current, target, expectedTarget) => {
      const container = document.createElement("div");
      document.body.append(container);
      render(renderSkillWorkshop(propsFor(current, proposalFor(target), mode)), container);

      const actions = container.querySelectorAll<HTMLButtonElement>(
        mode === "board" ? ".sw-action-bar button" : ".sw-today__actions button",
      );
      expect(actions).toHaveLength(4);
      expect([...actions].slice(0, 3).every((button) => button.disabled)).toBe(true);
      expect(actions[3]?.disabled).toBe(false);
      expect(container.querySelector(".sw-target-warning")?.textContent).toContain(expectedTarget);
      expect(container.textContent).toContain(`Target: ${expectedTarget}`);

      render(nothing, container);
    },
  );
});
