import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  controlUiSessionUrl,
  installFullGatewayMock as installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat waiting on subagents",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium cannot run at ${executablePath}`,
});

suite.define(() => {
  it("restores a private handoff, follows child push state, and resumes the parent without polling children", async () => {
    const artifactDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? path.resolve(".artifacts/control-ui-e2e/subagent-wait")
        : undefined;
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } } }
        : {}),
    });
    const page = await context.newPage();
    const now = Date.now();
    await page.clock.setFixedTime(now);
    const parent: GatewaySessionRow = {
      key: "agent:main:dashboard:wait-parent",
      kind: "direct",
      label: "Parent implementation",
      sessionId: "wait-parent",
      status: "running",
      hasActiveRun: false,
      hasActiveSubagentRun: true,
      activeRunIds: [],
      startedAt: now - 70_000,
      updatedAt: now,
      childSessions: ["agent:main:subagent:wait-child"],
    };
    const child: GatewaySessionRow = {
      key: "agent:main:subagent:wait-child",
      kind: "direct",
      label: "Backend implementation",
      sessionId: "wait-child",
      spawnedBy: parent.key,
      subagentRunState: "active",
      parentSessionKey: parent.key,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["child-run"],
      updatedAt: now,
    };
    const history = [
      { role: "user", content: "Implement the backend", timestamp: now - 70_000 },
      {
        role: "assistant",
        runId: "parent-run",
        content: [
          { type: "text", text: "Backend work is delegated." },
          {
            type: "toolCall",
            id: "yield",
            name: "sessions_yield",
            arguments: { message: "PRIVATE_CONTINUATION" },
          },
        ],
        timestamp: now - 63_000,
      },
      {
        role: "toolResult",
        toolCallId: "yield",
        toolName: "sessions_yield",
        content: [{ type: "text", text: '{"status":"yielded","message":"PRIVATE_CONTINUATION"}' }],
        timestamp: now - 62_999,
      },
    ];
    const gateway = await installMockGateway(page, {
      sessionKey: parent.key,
      sessionInfo: parent,
      historyMessages: history,
      methodResponses: { "sessions.list": sessionsListResponse([parent, child]) },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
    const indicator = page.locator(
      ".chat-pane-cache__pane--active .chat-working-indicator--subagents",
    );
    await indicator.getByText("Waiting on subagents", { exact: true }).waitFor();
    await page.getByText("Handed off and waiting", { exact: true }).waitFor();
    expect(await page.locator("body").textContent()).not.toContain("PRIVATE_CONTINUATION");
    expect(await indicator.locator("openclaw-elapsed-time").count()).toBe(1);
    expect(
      await indicator.locator(".chat-working-indicator__tokens, openclaw-working-phrase").count(),
    ).toBe(0);
    const childLink = indicator.getByRole("button", {
      name: "Backend implementation",
      exact: true,
    });
    await childLink.waitFor();
    const capture = async (name: string) => {
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
      }
    };
    await capture("waiting-light");
    await page.evaluate(() => (document.documentElement.dataset.themeMode = "dark"));
    await capture("waiting-dark");
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await indicator.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await capture("waiting-mobile");
    await page.setViewportSize({ width: 1280, height: 900 });
    await childLink.click();
    await expect.poll(() => page.url()).toContain("wait-child");
    await page.goBack();
    await indicator.waitFor();
    const childReads = (await gateway.getRequests("sessions.list")).filter(
      (request) => (request.params as { spawnedBy?: string })?.spawnedBy === parent.key,
    ).length;
    const settledParent = { ...parent, hasActiveSubagentRun: false, updatedAt: now + 1_000 };
    const settledChild = {
      ...child,
      hasActiveRun: false,
      activeRunIds: [],
      status: "killed",
      updatedAt: now + 1_000,
    };
    await gateway.setMethodResponse(
      "sessions.list",
      sessionsListResponse([settledParent, settledChild]),
    );
    await gateway.emitGatewayEvent("sessions.changed", { ...settledChild, reason: "lifecycle" });
    await indicator.waitFor({ state: "detached" });
    const waitingAgain = { ...parent, updatedAt: now + 2_000 };
    await gateway.setMethodResponse(
      "sessions.list",
      sessionsListResponse([waitingAgain, { ...child, updatedAt: now + 2_000 }]),
    );
    await gateway.emitGatewayEvent("sessions.changed", {
      ...child,
      updatedAt: now + 2_000,
      reason: "lifecycle",
    });
    await indicator.waitFor();
    const resumed = {
      ...waitingAgain,
      hasActiveRun: true,
      activeRunIds: ["resumed-run"],
      startedAt: now + 3_000,
      updatedAt: now + 3_000,
    };
    await gateway.setMethodResponse("sessions.list", sessionsListResponse([resumed, child]));
    await gateway.emitGatewayEvent("sessions.changed", { ...resumed, reason: "lifecycle" });
    await gateway.emitGatewayEvent("chat", {
      sessionKey: parent.key,
      runId: "resumed-run",
      state: "delta",
      message: {
        role: "assistant",
        content: "Reviewing the completed backend.",
        timestamp: now + 3_000,
      },
    });
    await indicator.waitFor({ state: "detached" });
    await page.getByText("Resumed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stop generating" }).waitFor();
    expect(
      (await gateway.getRequests("sessions.list")).filter(
        (request) => (request.params as { spawnedBy?: string })?.spawnedBy === parent.key,
      ),
    ).toHaveLength(childReads);
    await capture("resumed");
  });
});
