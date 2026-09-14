/* @vitest-environment jsdom */
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { reconcileSessionHistory } from "../lib/sessions/reconcile.ts";
import { buildSidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import "./tooltip.ts";

type BadgeInput = Parameters<typeof renderSessionRowBadges>[0];

const parentKey = "agent:main:dashboard:parent";
const dashboardKey = "agent:main:dashboard:22222222-2222-4222-8222-222222222222";
const subagentKey = "agent:main:subagent:11111111-1111-4111-8111-111111111111";
const acpLookingKey = "agent:main:acp:33333333-3333-4333-8333-333333333333";

function acpRuntime(agent?: string): NonNullable<GatewaySessionRow["agentRuntime"]> {
  return {
    id: "acpx",
    kind: "acp",
    source: "session",
    ...(agent === undefined ? {} : { agent }),
  };
}

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
});

function renderBadges(params: Partial<BadgeInput>) {
  render(renderSessionRowBadges({ hasAutomation: false, ...params }), container);
}

function expectTypeBadge(modifier: string, label: string) {
  const badge = container.querySelector(`.session-row-badge--${modifier}`);
  expect(badge).not.toBeNull();
  expect(badge?.getAttribute("role")).toBe("img");
  expect(badge?.getAttribute("aria-label")).toBe(label);
  expect(badge?.textContent?.trim()).toBe("");
  expect(badge?.querySelectorAll("svg")).toHaveLength(1);
  expect(badge?.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(badge?.hasAttribute("title")).toBe(false);
  expect(
    (badge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
  ).toBe(label);
  expect(badge?.querySelector("button, a, [tabindex]")).toBeNull();
  return badge;
}

function expectAcpBadge(agent: string, label: string) {
  const badge = container.querySelector(`.session-row-badge--acp-${agent}`);
  expect(badge).not.toBeNull();
  expect(badge?.getAttribute("role")).toBe("img");
  expect(badge?.getAttribute("aria-label")).toBe(label);
  expect(badge?.querySelector(`[data-provider-icon="${agent}"]`)).not.toBeNull();
  expect(badge?.querySelector("button, a, [tabindex]")).toBeNull();
  expect(
    (badge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
  ).toBe(label);
  return badge;
}

describe("session row type badges", () => {
  it.each([
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
  ] as const)("renders the %s ACP harness badge from explicit metadata", (agent, label) => {
    renderBadges({ key: acpLookingKey, agentRuntime: acpRuntime(agent) });
    const badge = expectAcpBadge(agent, label);
    expect(badge?.getAttribute("data-acp-agent")).toBe(agent);
    expect(badge?.querySelector(`[data-provider-icon="${agent}"]`)).not.toBeNull();
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
  });

  it.each([undefined, "", "unknown", "claude-code"])(
    "does not label an ACP row with an unknown or missing agent: %s",
    (agent) => {
      renderBadges({ key: acpLookingKey, agentRuntime: acpRuntime(agent) });
      expect(container.querySelector(".session-row-badge--acp")).toBeNull();
      expect(container.querySelector(".session-row-badges")).toBeNull();
    },
  );

  it("does not infer an ACP harness from an ACP-looking key alone", () => {
    renderBadges({ key: acpLookingKey });
    expect(container.querySelector(".session-row-badge--acp")).toBeNull();
    expect(container.querySelector(".session-row-badges")).toBeNull();
  });

  it("uses ACP metadata on an ordinary key without inferring from the key", () => {
    renderBadges({ key: "agent:main:dashboard:ordinary", agentRuntime: acpRuntime("codex") });
    expectAcpBadge("codex", "Codex");
    expect(container.querySelector(".session-row-badge--dashboard-task")).toBeNull();
  });

  it("keeps ACP and #216 subagent badges together", () => {
    renderBadges({ key: subagentKey, agentRuntime: acpRuntime("claude") });
    expectTypeBadge("subagent", "Sub-agent");
    expectAcpBadge("claude", "Claude");
    expect(container.querySelectorAll(".session-row-badge")).toHaveLength(2);
  });

  it.each([subagentKey, "subagent:legacy-child", " Agent:Main:Subagent:CHILD "])(
    "recognizes canonical subagent keys without relying on tree placement: %s",
    (key) => {
      for (const isChild of [true, false]) {
        renderBadges({ key, isChild });
        expectTypeBadge("subagent", "Sub-agent");
        expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
        expect(container.querySelector(".session-row-badge--dashboard-task")).toBeNull();
      }
    },
  );

  it.each([1, 3])("recognizes a visible dashboard task at spawn depth %s", (spawnDepth) => {
    for (const isChild of [true, false]) {
      renderBadges({ key: dashboardKey, spawnedBy: parentKey, spawnDepth, isChild });
      expectTypeBadge("dashboard-task", "Dashboard task");
      expect(container.querySelectorAll(".session-row-badge")).toHaveLength(1);
      expect(container.querySelector(".session-row-badge--subagent")).toBeNull();
    }
  });

  it.each([
    { name: "no spawn metadata", lineage: {} },
    { name: "depth without a controller", lineage: { spawnDepth: 1 } },
    { name: "controller without a depth", lineage: { spawnedBy: parentKey } },
    { name: "depth zero", lineage: { spawnedBy: parentKey, spawnDepth: 0 } },
    { name: "negative depth", lineage: { spawnedBy: parentKey, spawnDepth: -1 } },
    { name: "fractional depth", lineage: { spawnedBy: parentKey, spawnDepth: 1.5 } },
    { name: "nonfinite depth", lineage: { spawnedBy: parentKey, spawnDepth: Infinity } },
    { name: "unknown depth", lineage: { spawnedBy: parentKey, spawnDepth: Number.NaN } },
    { name: "empty controller", lineage: { spawnedBy: "", spawnDepth: 1 } },
    { name: "blank controller", lineage: { spawnedBy: " \t ", spawnDepth: 1 } },
  ])("does not infer a dashboard task from $name", ({ lineage }) => {
    for (const isChild of [true, false]) {
      renderBadges({ key: dashboardKey, isChild, ...lineage });
      expect(container.querySelector(".session-row-badges")).toBeNull();
    }
  });

  it("does not confuse a manually forked dashboard thread with a spawned task", () => {
    const operatorFork: GatewaySessionRow = {
      key: dashboardKey,
      kind: "direct",
      updatedAt: 1,
      label: "Subagent: visible dashboard task",
      boardFace: "dashboard",
      parentSessionKey: parentKey,
      forkSource: { sessionKey: parentKey, sessionId: "parent-transcript" },
      spawnDepth: 0,
    };
    renderBadges({ ...operatorFork, isChild: true });
    expect(container.querySelector(".session-row-badges")).toBeNull();
  });

  it.each([
    undefined,
    "",
    "agent:main:main",
    "agent:main:slack:channel",
    "agent:main:slack:channel:subagent:thread",
    "agent:main:cron:job",
    "agent:main:acp:child",
    "acp:legacy-child",
    "agent:main:acp:subagent:child",
    "agent:main:acp:dashboard:child",
    "agent:main:dashboard",
    "agent:main:dashboard-like:child",
  ])("does not assign a task type to a different or unknown key: %s", (key) => {
    renderBadges({ key, spawnedBy: parentKey, spawnDepth: 1, isChild: true });
    expect(container.querySelector(".session-row-badges")).toBeNull();
  });

  it("uses different icon shapes and keeps existing child annotations", () => {
    renderBadges({ key: subagentKey, isChild: true });
    const subagentIcon = expectTypeBadge("subagent", "Sub-agent")?.querySelector("svg")?.innerHTML;
    renderBadges({
      key: dashboardKey,
      spawnedBy: parentKey,
      spawnDepth: 1,
      isChild: true,
      incognito: true,
      hasAutomation: true,
      placementState: "active",
      hasApproval: true,
      outboxCount: 2,
      pullRequest: { numbers: [42], state: "open" },
    });
    const dashboardIcon = expectTypeBadge("dashboard-task", "Dashboard task")?.querySelector("svg");
    expect(dashboardIcon?.innerHTML).not.toBe(subagentIcon);
    expect(container.querySelector(".session-row-badge--incognito")).not.toBeNull();
    expect(container.querySelector(".session-row-badge--approval")).not.toBeNull();
    expect(container.querySelector(".session-row-badge--queued")?.textContent?.trim()).toBe("2");
    expect(container.querySelector(".session-row-badge--pull-request")).not.toBeNull();
    expect(container.querySelector(".session-row-badge--cloud")).toBeNull();
    expect(container.querySelector('[aria-label="Automation attached"]')).toBeNull();
  });

  it("adds no independent click target or tab stop inside the owning row", () => {
    const onClick = vi.fn((event: Event) => event.preventDefault());
    render(
      html`<a href="#session" @click=${onClick}>
        ${renderSessionRowBadges({ key: subagentKey, hasAutomation: false })}
      </a>`,
      container,
    );
    const badge = expectTypeBadge("subagent", "Sub-agent");
    expect(badge?.hasAttribute("tabindex")).toBe(false);
    badge?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("a, button, [tabindex]")).toHaveLength(1);
  });
});

describe("sidebar ACP metadata projection", () => {
  it("classifies ACP rows only from runtime kind and preserves full metadata", () => {
    const runtime = acpRuntime("opencode");
    const navigation = buildSidebarSessionNavigationState({
      context: undefined,
      routeSessionKey: acpLookingKey,
      sessionsResult: {
        ts: 1,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: acpLookingKey, kind: "direct", updatedAt: 1, agentRuntime: runtime },
          {
            key: "agent:main:acp:key-only",
            kind: "direct",
            updatedAt: 2,
          },
        ],
      },
      sessionsAgentId: null,
      showCron: false,
      statusFilter: "active",
      compareSessions: () => 0,
      highlightCurrentSession: false,
      runtimeSampledAtByRow: new WeakMap(),
      loadingChildSessionKeys: new Set(),
      outboxCountForSessionKey: () => 0,
      resolveAttention: () => ({ kind: "none" }),
      resolveAgentStatusNote: () => undefined,
    });
    const row = navigation.visibleSessions.find((candidate) => candidate.key === acpLookingKey);
    expect(row).toMatchObject({ acpSession: true, agentRuntime: runtime });
    expect(
      navigation.visibleSessions.find((candidate) => candidate.key === "agent:main:acp:key-only"),
    ).toMatchObject({ acpSession: false, agentRuntime: undefined });
  });

  it("keeps complete ACP metadata when a later event omits runtime fields", () => {
    const key = "agent:main:dashboard:reconcile-acp";
    const runtime = acpRuntime("claude");
    const result: Parameters<typeof reconcileSessionHistory>[0] = {
      ts: 1,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [{ key, kind: "direct", updatedAt: 1, agentRuntime: runtime }],
    };
    const next = reconcileSessionHistory(
      result,
      { key, kind: "direct", updatedAt: 2, status: "done" },
      undefined,
    );
    expect(next?.sessions[0]?.agentRuntime).toEqual(runtime);
  });
});

it("preserves spawn metadata and run state through a mixed sidebar tree and root projection", () => {
  const parent: GatewaySessionRow = { key: parentKey, kind: "direct", updatedAt: 1 };
  const subagent: GatewaySessionRow = {
    key: subagentKey,
    kind: "direct",
    updatedAt: 2,
    spawnedBy: parentKey,
    spawnDepth: 1,
    status: "running",
    hasActiveRun: true,
  };
  const dashboard: GatewaySessionRow = {
    key: dashboardKey,
    kind: "direct",
    updatedAt: 3,
    parentSessionKey: parentKey,
    spawnedBy: parentKey,
    spawnDepth: 1,
    status: "done",
    hasActiveRun: false,
  };
  const operatorFork: GatewaySessionRow = {
    key: "agent:main:dashboard:operator-fork",
    kind: "direct",
    updatedAt: 4,
    parentSessionKey: parentKey,
    spawnDepth: 0,
    status: "failed",
    hasActiveRun: false,
  };
  const navigation = buildSidebarSessionNavigationState({
    context: undefined,
    routeSessionKey: parentKey,
    sessionsResult: null,
    sessionsAgentId: null,
    showCron: false,
    statusFilter: "active",
    compareSessions: () => 0,
    highlightCurrentSession: false,
    runtimeSampledAtByRow: new WeakMap(),
    loadingChildSessionKeys: new Set(),
    outboxCountForSessionKey: () => 0,
    resolveAttention: () => ({ kind: "none" }),
    resolveAgentStatusNote: () => undefined,
  });
  const [tree] = projectSessionTree({
    roots: [parent],
    agentRows: [parent, subagent, dashboard, operatorFork],
    childRowsByParent: {},
    loadingChildKeys: new Set(),
    knownSessionAttention: [],
    toSidebarSession: navigation.toSidebarSession,
  });
  if (!tree) {
    throw new Error("expected the parent session tree");
  }
  expect(tree).toMatchObject({ isChild: false, runningChildCount: 1, failedChildCount: 1 });
  expect(tree.children).toHaveLength(3);
  renderBadges(tree);
  expect(container.querySelector(".session-row-badges")).toBeNull();

  const children = new Map(tree.children.map((row) => [row.key, row]));
  expect(children.get(subagentKey)).toMatchObject({
    spawnedBy: parentKey,
    spawnDepth: 1,
    isChild: true,
    status: "running",
    hasActiveRun: true,
  });
  renderBadges(children.get(subagentKey)!);
  expectTypeBadge("subagent", "Sub-agent");
  expect(children.get(dashboardKey)).toMatchObject({
    spawnedBy: parentKey,
    spawnDepth: 1,
    isChild: true,
    status: "done",
    hasActiveRun: false,
  });
  renderBadges(children.get(dashboardKey)!);
  expectTypeBadge("dashboard-task", "Dashboard task");
  renderBadges(children.get(operatorFork.key)!);
  expect(container.querySelector(".session-row-badges")).toBeNull();

  const promoted = navigation.toSidebarSession(dashboard, false);
  expect(promoted).toMatchObject({ isChild: false, spawnedBy: parentKey, spawnDepth: 1 });
  renderBadges(promoted);
  expectTypeBadge("dashboard-task", "Dashboard task");
});
