import type { Locator, Page, Route } from "playwright";
import { expect, it } from "vitest";
import type { ExecutionSettings } from "../platformclaw/execution-settings-view.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId as agentId,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "PlatformClaw selected personal work location",
  unavailableMessage: (path) => `Chromium cannot start at ${path}.`,
});

const settings: ExecutionSettings = {
  activeTarget: "platform_server",
  targetRevision: 8,
  credentialStatus: "current",
  credentialRevision: 1,
  accountId: "person.one",
  availableVms: [
    { id: "synthetic-vm-one", label: "Build VM" },
    { id: "synthetic-vm-two", label: "Test VM" },
  ],
  savedVms: [
    {
      id: "connection-one",
      vmHostId: "synthetic-vm-one",
      vmLabel: "Build VM",
      safeConnectLabel: "Synthetic connector",
      linuxAccount: "person.one",
      status: "ready",
      active: false,
    },
    {
      id: "connection-two",
      vmHostId: "synthetic-vm-two",
      vmLabel: "Test VM",
      safeConnectLabel: "Synthetic connector",
      linuxAccount: "person.one",
      status: "ready",
      active: false,
    },
  ],
  assignment: {
    id: "synthetic-assignment",
    vmHostId: "synthetic-vm-one",
    status: "ready",
    vmLabel: "Build VM",
    safeConnectLabel: "Synthetic connector",
    linuxAccount: "person.one",
  },
  codingAgents: [],
};

function savedVmsForTarget(
  target: ExecutionSettings["activeTarget"],
  connectionId: string | undefined,
): ExecutionSettings["savedVms"] {
  return settings.savedVms.map((vm) => ({
    id: vm.id,
    vmHostId: vm.vmHostId,
    vmLabel: vm.vmLabel,
    safeConnectLabel: vm.safeConnectLabel,
    linuxAccount: vm.linuxAccount,
    status: vm.status,
    active: target === "assigned_vm" && vm.id === connectionId,
    remoteWorkspaceDir: vm.remoteWorkspaceDir,
    lastConnectionSucceededAt: vm.lastConnectionSucceededAt,
  }));
}

suite.define(() => {
  it.each(["platform_server", "assigned_vm"] as const)(
    "keeps the member's selected %s visible on mobile and preserves the draft when switching",
    async (target) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
        recordVideo:
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? {
                dir: ".artifacts/control-ui-e2e/selected-location",
                size: { width: 390, height: 844 },
              }
            : undefined,
      });
      const page = await context.newPage();
      let current: ExecutionSettings = {
        ...settings,
        activeTarget: target,
        savedVms: savedVmsForTarget(target, "connection-one"),
      };
      const destinations: Array<string | undefined> =
        target === "platform_server"
          ? ["connection-one", "connection-two"]
          : [undefined, "connection-one", "connection-two"];
      const expectedChanges = destinations.map((connectionId, index) =>
        connectionId
          ? {
              target: "assigned_vm" as const,
              connectionId,
              expectedRevision: 8 + index,
            }
          : { target: "platform_server" as const, expectedRevision: 8 + index },
      );
      const changes: unknown[] = [];
      const executionResponse = async (route: Route) => {
        if (route.request().method() === "POST") {
          expect(new URL(route.request().url()).pathname).toBe(
            "/platformclaw/api/execution/target",
          );
          const change = route.request().postDataJSON();
          expect(change).toEqual(expectedChanges[changes.length]);
          changes.push(change);
          const vm = current.savedVms.find((entry) => entry.id === change.connectionId);
          if (change.target === "assigned_vm") {
            expect(vm).toBeDefined();
          }
          const targetRevision = current.targetRevision + 1;
          current = {
            ...current,
            activeTarget: change.target,
            targetRevision,
            assignment: vm
              ? {
                  id: `synthetic-allocation-${targetRevision}`,
                  vmHostId: vm.vmHostId,
                  status: "ready",
                  vmLabel: vm.vmLabel,
                  safeConnectLabel: vm.safeConnectLabel,
                  linuxAccount: vm.linuxAccount,
                }
              : current.assignment,
            savedVms: savedVmsForTarget(change.target, change.connectionId),
          };
        }
        await route.fulfill({ json: current });
      };
      const scenario = {
        basePath: "/platformclaw/app",
        defaultAgentId: agentId,
        assistantAgentId: agentId,
        sessionKey: `agent:${agentId}:${agentId}`,
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: { "agents.list": platformClawMemoryResponses["agents.list"] },
      };
      const openChat = async (targetPage: Page) => {
        await installPlatformClawMemoryDocument(targetPage, suite.server.baseUrl);
        const gateway = await installMockGateway(targetPage, scenario);
        await targetPage.route("**/platformclaw/api/execution{,/target}", executionResponse);
        await targetPage.goto(`${suite.server.baseUrl}platformclaw/app/chat`);
        // Playwright normally emulates every page as focused. Restore native tab
        // visibility so bringToFront exercises the real foreground event contract.
        const nativeFocus = await context.newCDPSession(targetPage);
        await nativeFocus.send("Emulation.setFocusEmulationEnabled", { enabled: false });
        await targetPage.bringToFront();
        return gateway;
      };
      try {
        const gateway = await openChat(page);
        const indicator = page
          .locator("platformclaw-quick-actions[location-only]")
          .getByRole("status");
        const assertLocation = async (status: Locator, label: string, width: number) => {
          const selected = `Selected location: ${label}`;
          await expect.poll(() => status.getAttribute("aria-label")).toBe(selected);
          await expect.poll(async () => (await status.textContent())?.trim()).toBe(selected);
          expect(await status.getAttribute("title")).toContain(`${selected}.`);
          const bounds = await status.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        };
        await assertLocation(
          indicator,
          target === "platform_server" ? "Basic server" : "Build VM",
          390,
        );
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this draft while checking work location");
        const secondPage = await context.newPage();
        await secondPage.setViewportSize({ width: 1440, height: 900 });
        const secondGateway = await openChat(secondPage);
        const launcher = secondPage
          .locator("platformclaw-quick-actions:not([location-only])")
          .getByRole("button", { name: "Open work location settings", exact: true });
        expect((await launcher.textContent())?.trim()).toBe("Work location");
        await launcher.click();
        const dialog = secondPage.getByRole("dialog", {
          name: "Work environment settings",
          exact: true,
        });
        await dialog.waitFor();
        const component = secondPage.locator("platformclaw-execution-settings");
        const secondIndicator = secondPage
          .locator("platformclaw-quick-actions[location-only]")
          .getByRole("status");
        for (const change of expectedChanges) {
          await secondPage.bringToFront();
          // Saved VM selection must identify the registration, not the shared assigned_vm target.
          await component
            .locator(
              change.connectionId
                ? `[data-connection-id="${change.connectionId}"]`
                : '[data-target="platform_server"]',
            )
            .click();
          const label = change.connectionId
            ? settings.savedVms.find((vm) => vm.id === change.connectionId)!.vmLabel
            : "Basic server";
          await assertLocation(secondIndicator, label, 1440);
          await expect
            .poll(() =>
              component
                .locator("[data-progress-modal] dialog")
                .evaluate((node) => (node as HTMLDialogElement).open),
            )
            .toBe(false);
          expect((await launcher.textContent())?.trim()).toBe("Work location");
          await page.bringToFront();
          await assertLocation(indicator, label, 390);
          expect(await composer.inputValue()).toBe("Keep this draft while checking work location");
        }
        expect(changes).toEqual(expectedChanges);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(await secondGateway.getRequests("chat.send")).toHaveLength(0);
        expect(await secondGateway.getRequests("sessions.patch")).toHaveLength(0);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
