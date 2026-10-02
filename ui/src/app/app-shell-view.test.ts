/* @vitest-environment jsdom */

import { nothing, render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import type { CommandPaletteTargetDetail } from "../components/command-palette-contract.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { renderApplicationShell, type ShellViewHost } from "./app-shell-view.ts";
import type { ExecApprovalRequest } from "./exec-approval.ts";
import { COMMAND_PALETTE_ELEMENT, EXEC_APPROVAL_ELEMENT } from "./lazy-custom-element.ts";
import "../components/exec-approval.ts";

const embeddedSession = "agent:personal:space-session:00000000-0000-4000-8000-000000000007";
const routeSession = "agent:main:previous-route";
let container: HTMLDivElement;
let restoreDialog: () => void;

function approval(id: string, sessionKey: string): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: `echo ${id}`, sessionKey },
    createdAtMs: Date.now() - 1000,
    expiresAtMs: Date.now() + 60_000,
  };
}

function shellHost(params: {
  queue: ExecApprovalRequest[];
  routeId?: RouteId;
  target?: CommandPaletteTargetDetail;
}): ShellViewHost {
  // Only shell projection state is needed: no router, personal runtime, or
  // Gateway transport starts when rendering this ownership boundary.
  return {
    context: {
      basePath: "",
      gateway: {
        snapshot: {
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.write"] },
            features: { methods: [] },
          },
        },
        connection: { token: "", password: "" },
      },
      navigation: {
        snapshot: { navCollapsed: false, navWidth: 240, sidebarEntries: [], pinnedAgentIds: [] },
      },
      overlays: {
        snapshot: {
          approvalQueue: params.queue,
          approvalBusy: false,
          approvalErrors: new Map(),
          approvalNowMs: Date.now(),
        },
        decideApproval: vi.fn(),
      },
      runtimeConfig: { state: {} },
      config: { current: { terminalEnabled: false } },
      agentSelection: { state: { selectedId: "main" } },
      theme: { mode: "light" },
    },
    runtime: { shellSession: {}, settingsNavigationMode: "takeover", router: {} },
    activeSessionKey: routeSession,
    commandPaletteTarget: params.target,
    commandPaletteElement: COMMAND_PALETTE_ELEMENT,
    execApprovalElement: EXEC_APPROVAL_ELEMENT,
    navigationSidebar: document.createElement("aside"),
    settingsSearchQuery: "",
    routeState: { routeId: params.routeId ?? "skills" },
    settingsPreloadTimers: new Map(),
    sidebarWorkboardSnapshot: { boards: [], ready: true },
    storedOutboxScopeHost: () => ({}),
    draftSessionAgentId: () => "main",
    enabledRouteIds: () => [],
  } as unknown as ShellViewHost;
}

async function drawShell(host: ShellViewHost) {
  render(renderApplicationShell(host), container);
  const modalQueue = container.querySelector<
    LitElement & { props: { inlineApprovalId: string | null } }
  >("openclaw-exec-approval");
  expect(modalQueue).not.toBeNull();
  await modalQueue!.updateComplete;
  return modalQueue!;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  restoreDialog = installDialogPolyfill();
});

afterEach(() => {
  render(nothing, container);
  document.body.replaceChildren();
  restoreDialog();
  vi.restoreAllMocks();
});

describe("shell approval presentation ownership", () => {
  it("leaves approval inline for a connected embedded pane on a non-chat route, then restores the modal on disconnect", async () => {
    const owner = document.createElement("section");
    document.body.append(owner);
    const host = shellHost({
      queue: [approval("embedded-approval", embeddedSession)],
      target: { owner, sessionKey: embeddedSession, onSlashCommand: vi.fn() },
    });

    const modalQueue = await drawShell(host);

    expect(modalQueue.props.inlineApprovalId).toBe("embedded-approval");
    expect(modalQueue.querySelector(".exec-approval-card")).toBeNull();
    expect(modalQueue.querySelector("openclaw-modal-dialog")).toBeNull();

    owner.remove();
    await drawShell(host);

    expect(modalQueue.props.inlineApprovalId).toBeNull();
    expect(modalQueue.querySelector(".exec-approval-card")?.getAttribute("data-approval-id")).toBe(
      "embedded-approval",
    );
    expect((await getRenderedModalDialog(modalQueue)).dialog.open).toBe(true);
  });

  it("prefers the live pane's session over a stale route session without hiding other approvals", async () => {
    const owner = document.createElement("section");
    document.body.append(owner);
    const host = shellHost({
      routeId: "chat",
      queue: [
        approval("embedded-approval", embeddedSession),
        approval("route-approval", routeSession),
      ],
      target: { owner, sessionKey: embeddedSession, onSlashCommand: vi.fn() },
    });

    const modalQueue = await drawShell(host);

    expect(modalQueue.props.inlineApprovalId).toBe("embedded-approval");
    expect(modalQueue.querySelectorAll('[data-approval-id="embedded-approval"]')).toHaveLength(0);
    expect(modalQueue.querySelector('[data-approval-id="route-approval"]')).not.toBeNull();
  });

  it("keeps the normal chat route fallback when no mounted pane supplies a session", async () => {
    const owner = document.createElement("section");
    document.body.append(owner);
    const host = shellHost({
      routeId: "chat",
      queue: [approval("route-approval", routeSession)],
      target: { owner, onSlashCommand: vi.fn() },
    });

    const modalQueue = await drawShell(host);

    expect(modalQueue.props.inlineApprovalId).toBe("route-approval");
    expect(modalQueue.querySelector(".exec-approval-card")).toBeNull();
  });
});
