import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HelloOk } from "../../../packages/gateway-protocol/src/index.ts";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.ts";
import type { BrowserGatewayAccess } from "../../../packages/platformclaw-control-plane/src/browser-gateway-contracts.ts";
import { PLATFORMCLAW_WEB_GATEWAY_EVENTS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-event-policy.ts";
import { projectPlatformClawBrowserHello } from "../../../packages/platformclaw-control-plane/src/browser-gateway-hello.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeE2e =
  canRunPlaywrightChromium(executablePath) || !allowMissingChromium ? describe : describe.skip;
const agentId = "person_one";
const sessionKey = `agent:${agentId}:main`;
const proofDir = path.join(
  process.cwd(),
  ".artifacts/control-ui-e2e/platformclaw-personal-permissions",
);
const access: BrowserGatewayAccess = {
  user: {
    id: "person-one",
    accountId: "person.one",
    employeeId: "1001",
    displayName: "Person One",
    status: "active",
    globalRole: "member",
    groups: [],
    createdAt: 1,
    updatedAt: 1,
  },
  binding: {
    id: "personal-binding",
    kind: "personal",
    userId: "person-one",
    agentId,
    state: "active",
    createdAt: 1,
    updatedAt: 1,
  },
  mainSessionKey: sessionKey,
};

let browser: Browser;
let server: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();

function memberHello(): HelloOk {
  return projectPlatformClawBrowserHello({
    access,
    connectionId: "personal-browser",
    upstream: {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      server: { version: "e2e", connId: "private-gateway" },
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: {
        methods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
        events: [...PLATFORMCLAW_WEB_GATEWAY_EVENTS],
      },
      snapshot: {
        presence: [],
        health: {},
        stateVersion: { presence: 0, health: 0 },
        uptimeMs: 1,
      },
      policy: { maxPayload: 1_048_576, maxBufferedBytes: 1_048_576, tickIntervalMs: 30_000 },
    },
  });
}

async function personalPage() {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    recordVideo: { dir: path.join(proofDir, "video"), size: { width: 1280, height: 720 } },
  });
  contexts.add(context);
  const page = await context.newPage();
  const response = await page.request.get(server.baseUrl);
  const source = await response.text();
  const headers = response.headers();
  await page.route("**/platformclaw/app/**", (route) => {
    const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
    return route.fulfill({
      body: source.replace("</head>", `${descriptor}</head>`),
      headers,
      status: response.status(),
    });
  });
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      status: 200,
      json: {
        authenticated: true,
        user: {
          accountId: "person.one",
          displayName: "Person One",
          department: "Platform",
          globalRole: "member",
        },
        agent: { agentId, state: "active" },
      },
    }),
  );
  await page.route("**/platformclaw/api/announcements", (route) =>
    route.fulfill({ json: { revision: 0, serverNow: Date.now(), announcement: null } }),
  );
  return page;
}

async function submitCommand(page: Page, command: string) {
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.fill(command);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

async function completeManualCompaction(gateway: MockGatewayControls, persist: boolean) {
  const operationId = "manual-compact-1";
  const operation = { operation: "compact", operationId, sessionKey, agentId };
  await gateway.emitGatewayEvent("session.operation", { ...operation, phase: "start" });
  if (persist) {
    await gateway.setHistoryMessages([
      {
        role: "system",
        timestamp: Date.now(),
        __openclaw: {
          kind: "compaction",
          id: "compact-entry-1",
          runId: operationId,
          itemId: "compact-item-1",
          tokensBefore: 2000,
          tokensAfter: 900,
        },
      },
    ]);
  }
  await gateway.emitGatewayEvent("session.operation", {
    ...operation,
    phase: "end",
    completed: true,
  });
  await gateway.resolveDeferred("sessions.compact", {
    ok: true,
    compacted: true,
    result: { tokensBefore: 2000, tokensAfter: 900 },
  });
}

describeE2e("PlatformClaw member personal permissions", () => {
  beforeAll(async () => {
    await mkdir(proofDir, { recursive: true });
    browser = await chromium.launch({ executablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterEach(async ({ task }) => {
    if (task.result?.state === "fail") {
      for (const context of contexts) {
        for (const page of context.pages()) {
          await page.screenshot({
            path: path.join(proofDir, `failure-${task.name.replace(/[^a-z0-9]+/giu, "-")}.png`),
            fullPage: true,
          });
        }
      }
    }
    await Promise.all([...contexts].map((context) => context.close()));
    contexts.clear();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("edits owned Agent Files using the real member hello without global admin", async () => {
    const page = await personalPage();
    const names = ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"];
    const hello = memberHello();
    expect(hello.auth.scopes).not.toContain("operator.admin");
    const file = (name: string, content: string) => ({ name, path: name, content, missing: false });
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: agentId,
      assistantName: "Personal Agent",
      sessionKey,
      featureMethods: hello.features.methods,
      operatorScopes: hello.auth.scopes,
      methodResponses: {
        connect: hello,
        "agents.files.list": {
          agentId,
          workspace: "personal workspace",
          files: names.map((name) => file(name, `Original ${name}`)),
        },
        "agents.files.get": {
          cases: names.map((name) => ({
            match: { name },
            response: {
              agentId,
              workspace: "personal workspace",
              file: file(name, `Original ${name}`),
            },
          })),
        },
        "agents.files.set": {
          cases: names.map((name) => ({
            match: { name },
            response: {
              ok: true,
              agentId,
              workspace: "personal workspace",
              file: file(name, `Updated ${name}`),
            },
          })),
        },
      },
    });

    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await gateway.waitForRequest("chat.startup");
    await page.goto(`${server.baseUrl}platformclaw/app/agents`);
    await page.getByRole("button", { name: /Personal Agent/ }).click();
    for (const name of names) {
      await page.getByRole("tab", { name: name.replace(/\.md$/, ""), exact: true }).click();
      const editor = page.locator(".agent-file-textarea");
      await expect.poll(() => editor.isEditable()).toBe(true);
      await editor.fill(`Updated ${name}`);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("agents.files.set")).some(
            (request) =>
              isRecord(request.params) &&
              request.params.name === name &&
              request.params.content === `Updated ${name}` &&
              request.params.agentId === agentId,
          ),
        )
        .toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Save", exact: true }).isDisabled())
        .toBe(true);
    }
    expect(await gateway.getRequests("config.patch")).toEqual([]);
    await page.screenshot({ path: path.join(proofDir, "agent-files-member.png"), fullPage: true });
  });

  it("dispatches manual compact and session settings for a member", async () => {
    const page = await personalPage();
    const hello = memberHello();
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: agentId,
      sessionKey,
      agentModel: "openai/gpt-5.6-luna",
      models: [
        { id: "gpt-5.6-luna", name: "Luna", provider: "openai", available: true },
        { id: "gpt-6-sol", name: "Sol", provider: "openai", available: true },
      ],
      featureMethods: hello.features.methods,
      operatorScopes: hello.auth.scopes,
      methodResponses: {
        connect: hello,
        "sessions.compact": {
          ok: true,
          compacted: true,
          result: { tokensBefore: 2000, tokensAfter: 900 },
        },
        "sessions.patch": { ok: true, key: sessionKey },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await gateway.waitForRequest("chat.startup");
    await gateway.deferNext("sessions.compact");
    await submitCommand(page, "/compact");
    await gateway.waitForRequest("sessions.compact");
    await completeManualCompaction(gateway, true);
    const compactNotice = page.locator(".chat-compaction--complete");
    await expect.poll(() => compactNotice.isVisible()).toBe(true);
    expect(await compactNotice.count()).toBe(1);
    expect(await compactNotice.textContent()).toContain("Context compacted");
    await page.screenshot({
      path: path.join(proofDir, "manual-compact-member.png"),
      fullPage: true,
    });
    await gateway.setMethodResponse("sessions.compact", {
      ok: true,
      compacted: false,
      reason: "Already compacted",
    });
    await submitCommand(page, "/compact");
    await expect.poll(async () => (await gateway.getRequests("sessions.compact")).length).toBe(2);
    const skippedNotice = page.getByText("Compaction skipped: Already compacted", { exact: true });
    await expect.poll(() => skippedNotice.isVisible()).toBe(true);
    expect(await skippedNotice.count()).toBe(1);
    await page.screenshot({
      path: path.join(proofDir, "manual-compact-skipped-member.png"),
      fullPage: true,
    });
    await submitCommand(page, "/fast on");
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.patch")).some(
          (request) => isRecord(request.params) && request.params.fastMode === true,
        ),
      )
      .toBe(true);
    await submitCommand(page, "/think high");
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.patch")).some(
          (request) => isRecord(request.params) && request.params.thinkingLevel === "high",
        ),
      )
      .toBe(true);
    await submitCommand(page, "/model openai/gpt-6-sol");
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.patch")).some(
          (request) => isRecord(request.params) && request.params.model === "openai/gpt-6-sol",
        ),
      )
      .toBe(true);
    expect(await gateway.getRequests("config.patch")).toEqual([]);
    expect(await gateway.getRequests("exec.approval.list")).toEqual([]);
    expect(await gateway.getRequests("plugin.approval.list")).toEqual([]);
    expect(await gateway.getRequests("openclaw.approval.list")).toEqual([]);
    await page.screenshot({
      path: path.join(proofDir, "session-actions-member.png"),
      fullPage: true,
    });
  });

  it("keeps compact success and a failed history refresh visible together", async () => {
    const page = await personalPage();
    const hello = memberHello();
    const gateway = await installMockGateway(page, {
      basePath: "/platformclaw/app",
      defaultAgentId: agentId,
      sessionKey,
      agentModel: "openai/gpt-5.6-luna",
      models: [{ id: "gpt-5.6-luna", name: "Luna", provider: "openai", available: true }],
      featureMethods: hello.features.methods,
      operatorScopes: hello.auth.scopes,
      methodResponses: {
        connect: hello,
        "sessions.compact": {
          ok: true,
          compacted: true,
          result: { tokensBefore: 2000, tokensAfter: 900 },
        },
      },
    });
    await page.goto(`${server.baseUrl}platformclaw/app/chat`);
    await gateway.waitForRequest("chat.startup");
    await gateway.setMethodResponse("chat.history", {
      __mockError: { code: "UNAVAILABLE", message: "History refresh unavailable" },
    });

    await gateway.deferNext("sessions.compact");
    await submitCommand(page, "/compact");
    await gateway.waitForRequest("sessions.compact");
    await completeManualCompaction(gateway, false);

    const notice = page.locator(".chat-compaction--complete");
    await expect.poll(() => notice.isVisible()).toBe(true);
    const warning = page.locator('.chat-error[role="alert"]');
    await expect.poll(() => warning.isVisible()).toBe(true);
    expect(await warning.textContent()).toContain("History refresh unavailable");
    expect(await notice.count()).toBe(1);
    expect(await gateway.getRequests("sessions.compact")).toHaveLength(1);
    await page.screenshot({
      path: path.join(proofDir, "manual-compact-history-warning-member.png"),
      fullPage: true,
    });
  });
});
