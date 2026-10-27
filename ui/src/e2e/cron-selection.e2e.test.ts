import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId as agentId,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron visible selection consistency",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

async function expectEditorSelection(
  page: Page,
  values: { unit: string; payload: string; session: string; delivery: string; wake: string },
  summary: string,
) {
  expect(await page.getByRole("combobox", { name: "Unit", exact: true }).inputValue()).toBe(
    values.unit,
  );
  expect(await page.locator("#cron-payload-kind").inputValue()).toBe(values.payload);
  expect(await page.locator("#cron-session-target").inputValue()).toBe(values.session);
  expect(await page.locator("#cron-delivery-mode").inputValue()).toBe(values.delivery);
  expect(await page.locator("#cron-wake-mode").inputValue()).toBe(values.wake);
  expect((await page.locator(".cron-schedule-summary").textContent())?.trim()).toBe(summary);
}

const storedJob: CronJob = {
  id: "personal-two-hour-job",
  configRevision: "personal-two-hour-revision",
  name: "Two-hour personal task",
  agentId,
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 7_200_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Check the personal workspace" },
  delivery: { mode: "none" },
  state: {},
};

async function openPersonalCron(page: Page) {
  await installPlatformClawMemoryDocument(page, suite.server.baseUrl);
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: agentId,
    assistantAgentId: agentId,
    sessionKey: `agent:${agentId}:main`,
    operatorScopes: ["operator.read", "operator.write"],
    methodResponses: {
      "agents.list": platformClawMemoryResponses["agents.list"],
      "cron.add": { id: "created-personal-job" },
      "cron.update": { id: storedJob.id },
      "cron.list": {
        jobs: [storedJob],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
      "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
      "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
    },
  });
  await page.goto(`${suite.server.baseUrl}platformclaw/app/cron`);
  await page.locator('[data-test-id="cron-new-task"]').waitFor();
  return gateway;
}

suite.define(() => {
  it("shows the new personal task defaults and submits those same values", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1_280 },
    });
    const page = await context.newPage();
    const gateway = await openPersonalCron(page);

    try {
      await page.locator('[data-test-id="cron-new-task"]').click();
      await expectEditorSelection(
        page,
        {
          unit: "minutes",
          payload: "agentTurn",
          session: "isolated",
          delivery: "announce",
          wake: "now",
        },
        "Runs every 30 minutes",
      );
      await page.locator("#cron-name").fill("Default personal task");
      await page.locator("#cron-payload-text").fill("Check the current workspace");
      await page.locator('[data-test-id="cron-submit"]').click();

      expect((await gateway.waitForRequest("cron.add")).params).toMatchObject({
        name: "Default personal task",
        agentId,
        schedule: { kind: "every", everyMs: 1_800_000 },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Check the current workspace" },
        delivery: { mode: "announce" },
      });
      expect(await gateway.getRequests("cron.run")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps edit, changed options, and clone selections consistent with their requests", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    const page = await context.newPage();
    const gateway = await openPersonalCron(page);

    try {
      await page
        .locator(`[data-test-id="cron-row-${storedJob.id}"] .cron-table__name-text`)
        .click();
      const storedSelection = {
        unit: "hours",
        payload: "agentTurn",
        session: "isolated",
        delivery: "none",
        wake: "next-heartbeat",
      };
      await expectEditorSelection(page, storedSelection, "Runs every 2 hours");

      await page.getByRole("combobox", { name: "Unit", exact: true }).selectOption("days");
      await page.locator("#cron-every-amount").fill("3");
      await page.locator("#cron-payload-kind").selectOption("systemEvent");
      await page.locator("#cron-session-target").selectOption("main");
      await expectEditorSelection(
        page,
        { ...storedSelection, unit: "days", payload: "systemEvent", session: "main" },
        "Runs every 3 days",
      );
      expect(await page.locator("#cron-delivery-mode option").count()).toBe(1);
      await page.locator('[data-test-id="cron-submit"]').click();
      expect((await gateway.waitForRequest("cron.update")).params).toMatchObject({
        id: storedJob.id,
        expectedConfigRevision: storedJob.configRevision,
        patch: {
          agentId,
          schedule: { kind: "every", everyMs: 259_200_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Check the personal workspace" },
          delivery: { mode: "none" },
        },
      });

      await page.locator(".cron-detail-actions .cron-job-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Clone", exact: true }).click();
      await expectEditorSelection(page, storedSelection, "Runs every 2 hours");
      await page.locator('[data-test-id="cron-submit"]').click();
      expect((await gateway.waitForRequest("cron.add")).params).toMatchObject({
        agentId,
        schedule: { kind: "every", everyMs: 7_200_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check the personal workspace" },
        delivery: { mode: "none" },
      });
      expect(await gateway.getRequests("cron.run")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
