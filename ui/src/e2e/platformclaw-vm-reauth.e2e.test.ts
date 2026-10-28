import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ExecutionSettings } from "../platformclaw/execution-settings-view.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId as agentId,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "PlatformClaw automatic VM credential recovery",
  unavailableMessage: (executable) => `Chromium cannot start at ${executable}.`,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "vm-reauth");
const READY: ExecutionSettings = {
  activeTarget: "assigned_vm",
  targetRevision: 8,
  credentialStatus: "current",
  credentialRevision: 3,
  accountId: "person.one",
  availableVms: [{ id: "vm-one", label: "Build VM" }],
  savedVms: [
    {
      id: "connection-one",
      vmHostId: "vm-one",
      vmLabel: "Build VM",
      safeConnectLabel: "Synthetic connector",
      linuxAccount: "person.one",
      status: "ready",
      active: true,
    },
  ],
  assignment: {
    id: "allocation-one",
    vmHostId: "vm-one",
    status: "ready",
    vmLabel: "Build VM",
    safeConnectLabel: "Synthetic connector",
    linuxAccount: "person.one",
    remoteWorkspaceDir: "/users/person.one/.platformclaw/workspace",
  },
  codingAgents: [],
};

async function screenshot(page: Page, name: string) {
  if (captureProof) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      path: path.join(proofDir, name),
    });
  }
}

async function expectRecoveryClosed(recovery: Locator): Promise<void> {
  await expect.poll(() => recovery.locator("[data-recovery-modal]").count()).toBe(0);
  expect(await recovery.locator("[data-recovery-password]").count()).toBe(0);
}

suite.define(() => {
  it.each([
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    { name: "mobile", viewport: { width: 390, height: 844 } },
  ])(
    "recovers from a chat authentication failure without replay on $name",
    async ({ name, viewport }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        colorScheme: "light",
        viewport,
        serviceWorkers: "block",
        ...(captureProof
          ? { recordVideo: { dir: path.join(proofDir, "video"), size: viewport } }
          : {}),
      });
      const page = await context.newPage();
      let current: ExecutionSettings = structuredClone(READY);
      let getCount = 0;
      const credentialRequests: unknown[] = [];
      const publishState = () => ({
        agentId,
        allocationId: current.assignment!.id,
        targetRevision: current.targetRevision,
        credentialRevision: current.credentialRevision,
        status: current.credentialStatus,
      });
      try {
        await installPlatformClawMemoryDocument(page, suite.server.baseUrl);
        const gateway = await installMockGateway(page, {
          basePath: "/platformclaw/app",
          defaultAgentId: agentId,
          assistantAgentId: agentId,
          sessionKey: `agent:${agentId}:${agentId}`,
          operatorScopes: ["operator.read", "operator.write"],
          methodResponses: { "agents.list": platformClawMemoryResponses["agents.list"] },
        });
        await page.route("**/platformclaw/api/execution{,/credential}", async (route) => {
          if (route.request().method() === "POST") {
            const body = route.request().postDataJSON();
            credentialRequests.push(body);
            expect(body).toEqual({
              password: credentialRequests.length === 1 ? "synthetic-wrong" : "synthetic-correct",
              expectedRevision: current.targetRevision,
              expectedCredentialRevision: current.credentialRevision,
              expectedAllocationId: current.assignment!.id,
            });
            if (credentialRequests.length === 1) {
              await route.fulfill({ status: 422, json: { error: "AD password was not accepted" } });
              return;
            }
            current = {
              ...current,
              credentialStatus: "current",
              credentialRevision: current.credentialRevision + 1,
              credentialLastAuthFailureAt: undefined,
              assignment: { ...current.assignment!, status: "ready" },
            };
          } else {
            getCount++;
          }
          await route.fulfill({ json: current });
        });
        await page.goto(`${suite.server.baseUrl}platformclaw/app/chat`);
        await waitForControlUiGatewayReady(page);
        const recovery = page.locator("platformclaw-vm-recovery");
        await recovery.waitFor({ state: "attached" });
        await expectRecoveryClosed(recovery);
        expect(await page.locator("platformclaw-execution-settings").count()).toBe(0);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Run the project tests");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const sent = await gateway.waitForRequest("chat.send");
        const request = sent.params as { idempotencyKey: string };
        await gateway.emitChatFinal({
          runId: request.idempotencyKey,
          text: "VM authentication failed.",
        });
        await composer.fill("Keep this draft while I reconnect");
        await screenshot(page, `${name}-before.png`);

        current = {
          ...current,
          credentialStatus: "update_required",
          credentialLastAuthFailureAt: 1_700_000_100_000,
          assignment: { ...current.assignment!, status: "connection_required" },
        };
        await gateway.emitGatewayEvent("platformclaw.execution.changed", publishState());
        const dialog = recovery.getByRole("dialog", { name: "Reconnect to your VM", exact: true });
        await dialog.waitFor();
        expect(await page.locator("platformclaw-execution-settings").count()).toBe(0);
        const panel = recovery.locator(".recovery-panel");
        const bounds = await panel.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
        await screenshot(page, `${name}-failure.png`);
        await recovery.getByRole("button", { name: "Later", exact: true }).click();
        await expectRecoveryClosed(recovery);
        await recovery.locator("[data-recovery-banner]").waitFor({ state: "visible" });
        const beforeDuplicate = getCount;
        await gateway.emitGatewayEvent("platformclaw.execution.changed", publishState());
        await expect.poll(() => getCount).toBeGreaterThan(beforeDuplicate);
        await expectRecoveryClosed(recovery);
        const sockets = await gateway.getSocketCount();
        await gateway.closeLatest(1012, "synthetic reconnect");
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(sockets);
        await waitForControlUiGatewayReady(page);
        await expectRecoveryClosed(recovery);

        await recovery.getByRole("button", { name: "Reconnect VM", exact: true }).click();
        await dialog.waitFor();
        const password = recovery.locator("[data-recovery-password]");
        await password.fill("synthetic-wrong");
        await recovery.getByRole("button", { name: "Save and reconnect", exact: true }).click();
        await expect
          .poll(() => recovery.locator("#execution-recovery-error").textContent())
          .toMatch(/AD password/i);
        await expect
          .poll(() => recovery.locator("#execution-recovery-error").isVisible())
          .toBe(true);
        expect(await password.inputValue()).toBe("");
        expect(await dialog.isVisible()).toBe(true);
        await screenshot(page, `${name}-rejected.png`);
        await password.fill("synthetic-correct");
        await recovery.getByRole("button", { name: "Save and reconnect", exact: true }).click();
        await expectRecoveryClosed(recovery);
        await recovery.locator("[data-recovery-success]").waitFor({ state: "visible" });
        expect(await password.count()).toBe(0);
        expect(await composer.inputValue()).toBe("Keep this draft while I reconnect");
        expect(credentialRequests).toHaveLength(2);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await screenshot(page, `${name}-success.png`);

        current = {
          ...current,
          credentialStatus: "update_required",
          credentialLastAuthFailureAt: 1_700_000_200_000,
          assignment: { ...current.assignment!, status: "connection_required" },
        };
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await dialog.waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await password.fill("retire-this-secret");
        current = {
          ...current,
          activeTarget: "platform_server",
          targetRevision: current.targetRevision + 1,
        };
        // Use the same DOM bridge emitted by the work-location settings owner.
        await page.evaluate(() =>
          window.dispatchEvent(new Event("platformclaw:execution-target-changed")),
        );
        await expectRecoveryClosed(recovery);
        expect(await password.count()).toBe(0);
        expect(await recovery.locator("[data-recovery-banner]").count()).toBe(0);
        current = {
          ...current,
          activeTarget: "assigned_vm",
          targetRevision: current.targetRevision + 1,
          assignment: { ...current.assignment!, id: "allocation-two", vmLabel: "Another VM" },
        };
        await page.evaluate(() =>
          window.dispatchEvent(new Event("platformclaw:execution-target-changed")),
        );
        await dialog.waitFor();
        await recovery.getByRole("button", { name: "Later", exact: true }).click();
        await expectRecoveryClosed(recovery);
        await recovery.locator("[data-recovery-banner]").waitFor({ state: "visible" });
        current = {
          ...current,
          credentialStatus: "current",
          targetRevision: current.targetRevision + 1,
          assignment: { ...current.assignment!, id: "allocation-three", status: "ready" },
        };
        await page.evaluate(() =>
          window.dispatchEvent(new Event("platformclaw:execution-target-changed")),
        );
        await expectRecoveryClosed(recovery);
        expect(await recovery.locator("[data-recovery-banner]").count()).toBe(0);
        expect(credentialRequests).toHaveLength(2);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
