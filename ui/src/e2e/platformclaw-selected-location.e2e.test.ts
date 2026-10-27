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
  accountId: "person.one",
  availableVms: [{ id: "synthetic-vm", label: "Development" }],
  assignment: {
    id: "synthetic-assignment",
    vmHostId: "synthetic-vm",
    status: "ready",
    vmLabel: "Development",
    safeConnectLabel: "Synthetic connector",
    linuxAccount: "person.one",
  },
  codingAgents: [],
};

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
      let current: ExecutionSettings = { ...settings, activeTarget: target };
      const changes: unknown[] = [];
      const executionResponse = async (route: Route) => {
        if (route.request().method() === "POST") {
          const change = route.request().postDataJSON();
          changes.push(change);
          expect(change).toEqual({
            target: target === "platform_server" ? "assigned_vm" : "platform_server",
            expectedRevision: 8,
          });
          current = { ...current, activeTarget: change.target, targetRevision: 9 };
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
        const label = target === "platform_server" ? "Basic server" : "Development VM";
        await expect
          .poll(() => indicator.getAttribute("aria-label"))
          .toBe(`Selected location: ${label}`);
        const bounds = await indicator.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this draft while checking work location");
        const secondPage = await context.newPage();
        await secondPage.setViewportSize({ width: 1440, height: 900 });
        const secondGateway = await openChat(secondPage);
        await secondPage
          .locator("platformclaw-quick-actions:not([location-only])")
          .getByRole("button", { name: "Open work location settings", exact: true })
          .click();
        const dialog = secondPage.getByRole("dialog", {
          name: "Work environment settings",
          exact: true,
        });
        await dialog.waitFor();
        const nextTarget = target === "platform_server" ? "assigned_vm" : "platform_server";
        // The tile is slotted into the native dialog; scope to its owner, not the shadow dialog.
        await secondPage
          .locator(`platformclaw-execution-settings [data-target="${nextTarget}"]`)
          .click();
        const nextLabel = nextTarget === "platform_server" ? "Basic server" : "Development VM";
        await expect
          .poll(() =>
            secondPage
              .locator("platformclaw-quick-actions[location-only]")
              .getByRole("status")
              .getAttribute("aria-label"),
          )
          .toBe(`Selected location: ${nextLabel}`);
        await page.bringToFront();
        await expect
          .poll(() => indicator.getAttribute("aria-label"))
          .toBe(`Selected location: ${nextLabel}`);
        expect(await composer.inputValue()).toBe("Keep this draft while checking work location");
        expect(changes).toHaveLength(1);
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
import type { Page, Route } from "playwright";
