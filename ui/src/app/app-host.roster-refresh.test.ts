/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsListResult, GatewayAgentRow } from "../api/types.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import "./app-host.ts";
import type { ApplicationContext } from "./context.ts";

type ShellRosterRefreshState = {
  runtime: { context: ApplicationContext };
  handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
};

function roster(defaultId: string, agents: GatewayAgentRow[]): AgentsListResult {
  return { defaultId, mainKey: "main", scope: "per-sender", agents };
}

function createRosterRefreshContext(params: {
  previous: AgentsListResult;
  next: AgentsListResult;
  selectedId: string;
}) {
  const agentsState = { agentsList: params.previous };
  const selectionState = { selectedId: params.selectedId, scopeId: params.selectedId };
  const refreshList = vi.fn(async () => {
    agentsState.agentsList = params.next;
    return params.next;
  });
  const invalidateFiles = vi.fn();
  const invalidateIdentity = vi.fn();
  const ensureIdentity = vi.fn(async () => undefined);
  const setSelection = vi.fn((agentId: string) => {
    selectionState.selectedId = agentId;
    selectionState.scopeId = agentId;
  });
  const refreshConfig = vi.fn(async () => null);
  const context = {
    accessMode: "operator",
    agents: { state: agentsState, refreshList, invalidateFiles },
    agentIdentity: { invalidate: invalidateIdentity, ensure: ensureIdentity },
    agentSelection: { state: selectionState, set: setSelection },
    runtimeConfig: { state: { configFormDirty: false }, refresh: refreshConfig },
  } as unknown as ApplicationContext;
  return {
    context,
    refreshList,
    invalidateFiles,
    invalidateIdentity,
    ensureIdentity,
    setSelection,
    refreshConfig,
  };
}

describe("OpenClaw shell roster refresh", () => {
  afterEach(resetAppHostTestGlobals);

  it("refreshes the roster on config.changed and invalidates removed or changed agents", async () => {
    vi.useFakeTimers();
    const harness = createRosterRefreshContext({
      previous: roster("main", [
        { id: "main", name: "Main" },
        { id: "writer", name: "Writer" },
        { id: "retired", name: "Retired" },
      ]),
      next: roster("main", [
        { id: "main", name: "Main" },
        { id: "writer", name: "Editor" },
        { id: "new-agent", name: "New" },
      ]),
      selectedId: "main",
    });
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellRosterRefreshState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.refreshConfig).toHaveBeenCalledOnce();
    expect(harness.refreshList).toHaveBeenCalledOnce();
    expect(harness.invalidateFiles).toHaveBeenCalledWith(["writer", "retired"]);
    expect(harness.invalidateIdentity).toHaveBeenCalledWith(["writer", "retired"]);
    expect(harness.ensureIdentity).toHaveBeenCalledWith(["writer"]);
    expect(harness.setSelection).not.toHaveBeenCalled();
  });

  it("moves a deleted active agent to the refreshed roster default", async () => {
    vi.useFakeTimers();
    const harness = createRosterRefreshContext({
      previous: roster("writer", [{ id: "fallback" }, { id: "main" }, { id: "writer" }]),
      next: roster("main", [{ id: "fallback" }, { id: "main" }]),
      selectedId: "writer",
    });
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellRosterRefreshState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.setSelection).toHaveBeenCalledExactlyOnceWith("main");
  });

  it("keeps caches intact when a config.changed refresh returns the same roster", async () => {
    vi.useFakeTimers();
    const unchanged = roster("main", [{ id: "main", name: "Main" }, { id: "writer" }]);
    const harness = createRosterRefreshContext({
      previous: unchanged,
      next: structuredClone(unchanged),
      selectedId: "main",
    });
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellRosterRefreshState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.refreshList).toHaveBeenCalledOnce();
    expect(harness.invalidateFiles).not.toHaveBeenCalled();
    expect(harness.invalidateIdentity).not.toHaveBeenCalled();
    expect(harness.ensureIdentity).not.toHaveBeenCalled();
  });

  it("coalesces config.changed bursts into one roster refresh", async () => {
    vi.useFakeTimers();
    const unchanged = roster("main", [{ id: "main" }]);
    const harness = createRosterRefreshContext({
      previous: unchanged,
      next: unchanged,
      selectedId: "main",
    });
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellRosterRefreshState;
    shell.runtime = { context: harness.context };

    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    shell.handleGatewayEvent({ event: "config.changed", payload: {} });
    await vi.advanceTimersByTimeAsync(99);
    expect(harness.refreshList).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.refreshList).toHaveBeenCalledOnce();
  });
});
