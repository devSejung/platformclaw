/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  installTerminalPanelTestLifecycle,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";
const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);
describe("Personal VM terminal sessions", () => {
  installTerminalPanelTestLifecycle(createGhosttyTerminalMock);
  it("restores available personal VM sessions without taking peer browser ownership", async () => {
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    const session = {
      sessionId: "vm-terminal-1",
      agentId: "person_one",
      shell: "person_one login shell",
      cwd: "/home/person_one",
      confined: true,
    };
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.list") {
          return {
            sessions: [
              { ...session, attached: false, available: true, owner: "conn", createdAtMs: 1 },
              {
                ...session,
                sessionId: "peer-terminal",
                attached: false,
                available: false,
                owner: "conn",
                createdAtMs: 2,
              },
            ],
          } as T;
        }
        if (method === "terminal.attach") {
          return { ...session, buffer: "welcome", seq: 7 } as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.agentId = "person_one";
    panel.available = true;
    panel.maxSessions = 8;
    panel.uploadsEnabled = false;
    document.body.append(panel);

    panel.toggle();
    await waitForFast(() =>
      expect(requests).toContainEqual({
        method: "terminal.attach",
        params: { sessionId: "vm-terminal-1" },
      }),
    );
    expect(requests.some(({ method }) => method === "terminal.open")).toBe(false);
    expect(panel.renderRoot.querySelector(".tp-upload")).toBeNull();
    expect(panel.renderRoot.querySelector(".tp-session-picker")).not.toBeNull();
    expect(panel.renderRoot.querySelector(".tabstrip-new")).not.toBeNull();
    expect(requests.filter(({ method }) => method === "terminal.attach")).toHaveLength(1);
  });

  it("bounds personal VM tabs at eight and stops detached input and close RPCs", async () => {
    createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
    const requests: Array<{ method: string; params: unknown }> = [];
    let sequence = 0;
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.list") {
          return { sessions: [] } as T;
        }
        if (method === "terminal.open") {
          return terminalOpenResult(`vm-${++sequence}`) as T;
        }
        return {} as T;
      },
      addEventListener: (next) => {
        listener = next;
        return () => {};
      },
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    panel.maxSessions = 8;
    panel.uploadsEnabled = false;
    document.body.append(panel);
    panel.toggle();
    await waitForFast(() =>
      expect(panel.renderRoot.querySelectorAll(".tabstrip-tab")).toHaveLength(1),
    );
    for (let count = 2; count <= 8; count += 1) {
      await waitForFast(() =>
        expect(
          (panel.renderRoot.querySelector(".tabstrip-new") as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      (panel.renderRoot.querySelector(".tabstrip-new") as HTMLButtonElement).click();
      await waitForFast(() =>
        expect(requests.filter(({ method }) => method === "terminal.open")).toHaveLength(count),
      );
    }
    await waitForFast(() =>
      expect((panel.renderRoot.querySelector(".tabstrip-new") as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    listener?.({
      event: "terminal.exit",
      payload: { sessionId: "vm-8", reason: "detached", exitCode: null },
    });
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".is-exited")?.textContent).toContain(
        t("terminal.detached"),
      ),
    );
    const before = requests.filter(({ method }) => method === "terminal.close").length;
    const close = panel.renderRoot.querySelector(
      ".is-exited + .tabstrip-tab__close",
    ) as HTMLButtonElement;
    close.click();
    expect(requests.filter(({ method }) => method === "terminal.close")).toHaveLength(before);
    expect(requests.filter(({ method }) => method === "terminal.open")).toHaveLength(8);
  });
});
