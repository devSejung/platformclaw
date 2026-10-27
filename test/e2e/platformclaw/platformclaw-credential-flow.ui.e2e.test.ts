import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { registerPlatformClawCredentialTool } from "../../../extensions/platformclaw-execution/api.js";
import type { BrowserAuthService } from "../../../packages/platformclaw-control-plane/src/browser-auth-service.ts";
import { handlePlatformClawExecCredentialRequest } from "../../../packages/platformclaw-control-plane/src/browser-exec-credentials-http.ts";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { readBrowserJsonBody } from "../../../packages/platformclaw-control-plane/src/browser-http-shared.ts";
import { ExecCredentialCipher } from "../../../packages/platformclaw-control-plane/src/exec-credential-crypto.ts";
import { ExecCredentialService } from "../../../packages/platformclaw-control-plane/src/exec-credential-service.ts";
import { ExecutionHandoffClient } from "../../../packages/platformclaw-control-plane/src/execution-handoff-client.ts";
import { PlatformClawExecutionHandoffServer } from "../../../packages/platformclaw-control-plane/src/execution-handoff-http.ts";
import { SqliteControlPlaneStore } from "../../../packages/platformclaw-control-plane/src/sqlite-store.ts";
import { sanitizeChatHistoryMessages } from "../../../src/gateway/chat-display-projection.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "../../../ui/src/platformclaw/web-contract.ts";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../../../ui/src/test-helpers/control-ui-e2e.ts";

const chromiumPath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumPath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeCredentialFlow =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "credentials-contextual-flow", "pc-ko");
const envName = "REPORT_API_TOKEN";
const sessionId = "credential-proof-session";
const finalLeaf = "credential-proof-source-final";
const contexts = new Set<BrowserContext>();
const fixtures = new Set<Awaited<ReturnType<typeof startCredentialFixture>>>();
let browser: Browser;
let server: ControlUiE2eServer;

async function closeHttpServer(httpServer: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/** The synthetic model supplies only a tool call. Production code creates uiAction. */
async function startCredentialFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "platformclaw-credential-flow-"));
  const store = new SqliteControlPlaneStore({
    databasePath: path.join(directory, "control.sqlite"),
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["proof.admin"],
  });
  const principal = (accountId: string) => ({
    provider: "ldap" as const,
    subject: `proof:${accountId}`,
    accountId,
    employeeId: accountId,
  });
  const admin = (await store.upsertPrincipal(principal("proof.admin"), Date.now())).user;
  const member = (await store.upsertPrincipal(principal("proof.member"), Date.now())).user;
  const otherMember = (await store.upsertPrincipal(principal("proof.other"), Date.now())).user;
  const reserved = await store.reservePersonalAgent(member.id, Date.now());
  await store.transitionAgent({
    bindingId: reserved.binding.id,
    state: "active",
    changedAt: Date.now(),
  });
  await store.addExecCredentialDefinition(admin.id, envName, Date.now());
  const agentId = reserved.binding.agentId;
  const sessionKey = `agent:${agentId}:main`;
  const cipher = ExecCredentialCipher.fromBase64(randomBytes(32).toString("base64"));
  // Authentication is synthetic; credential authorization, encryption, and storage are real.
  let currentUser = member;
  const authService = {
    authenticateToken: async () => ({ status: "active", user: currentUser }),
  } as unknown as BrowserAuthService;
  const service = new ExecCredentialService({ authService, store, cipher });
  const socketPath =
    process.platform === "win32"
      ? String.raw`\\.\pipe\platformclaw-credential-proof-${randomUUID()}`
      : path.join(directory, "execution.sock");
  const unsupported = async () => {
    throw new Error("No execution target is part of this fixture");
  };
  let metadataCalls = 0;
  const handoff = new PlatformClawExecutionHandoffServer(
    "synthetic-service-token-at-least-32-bytes",
    {
      resolveTarget: unsupported,
      resolveConnectionTarget: unsupported,
      changeTarget: unsupported,
      issueCredentialGrant: unsupported,
      execCredentialMetadata: async (owner, key) => {
        metadataCalls++;
        return service.metadataForAgent(owner, key);
      },
    },
    socketPath,
  );
  await handoff.listen();
  const client = new ExecutionHandoffClient(
    socketPath,
    "synthetic-service-token-at-least-32-bytes",
  );
  let saveCalls = 0;
  let readCalls = 0;
  let failNextSave = false;
  let failReadAfterSave = false;
  let failNextRead = false;
  const api = createServer((req, res) => {
    if (req.method === "GET") {
      readCalls++;
      if (failNextRead) {
        failNextRead = false;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "synthetic-status-unavailable" }));
        return;
      }
    }
    if (req.method === "POST") {
      saveCalls++;
      if (failNextSave) {
        failNextSave = false;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "synthetic-save-unavailable" }));
        return;
      }
      if (failReadAfterSave) {
        failReadAfterSave = false;
        failNextRead = true;
      }
    }
    void handlePlatformClawExecCredentialRequest(req, res, {
      service,
      isMutationOriginAllowed: () => true,
      readJsonBody: readBrowserJsonBody,
    }).catch(() => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "synthetic-request-failed" }));
    });
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an isolated credential HTTP listener");
  }
  return {
    agentId,
    sessionKey,
    accountId: member.accountId,
    apiUrl: `http://127.0.0.1:${address.port}/platformclaw/api/exec-credentials`,
    metadataCalls: () => metadataCalls,
    saveCalls: () => saveCalls,
    readCalls: () => readCalls,
    failSave: () => {
      failNextSave = true;
    },
    failRefreshAfterSave: () => {
      failReadAfterSave = true;
    },
    switchAccount: () => {
      currentUser = otherMember;
    },
    snapshot: () => service.snapshot(member.id),
    otherSnapshot: () => service.snapshot(otherMember.id),
    addSiblingDefinition: (siblingName: string) => service.addDefinition(admin.id, siblingName),
    async recreateRequestedValue(value: string) {
      const before = (await service.snapshot(member.id)).definitions.find(
        (definition) => definition.envName === envName,
      );
      if (!before?.configured || !before.credentialToken) {
        throw new Error("The requested credential must be saved before the ABA sequence");
      }
      await service.remove(member.id, envName, {
        expectedDefinitionToken: before.definitionToken,
        expectedCredentialToken: before.credentialToken,
      });
      const after = await service.replace(member.id, envName, value, {
        expectedDefinitionToken: before.definitionToken,
        expectedCredentialToken: null,
      });
      return { before, after };
    },
    async callRegisteredTool(runId: string) {
      type RegistrationApi = Parameters<typeof registerPlatformClawCredentialTool>[0];
      const registrations: Parameters<RegistrationApi["registerTool"]>[0][] = [];
      registerPlatformClawCredentialTool(
        {
          registrationMode: "full",
          registerTool: (tool) => {
            registrations.push(tool);
          },
        },
        async () => ({
          credentialMetadata: (request) =>
            client.execCredentialMetadata(request.agentId, request.sessionKey),
        }),
      );
      const registered = registrations[0];
      if (typeof registered !== "function") {
        throw new Error("The credential tool was not registered as a factory");
      }
      const created = registered({
        agentId,
        sessionKey,
        sessionId,
        runId,
        config: {},
        sandboxed: true,
      });
      const tool = Array.isArray(created)
        ? created.find((entry) => entry.name === "platformclaw_credentials")
        : created;
      if (!tool || tool.name !== "platformclaw_credentials") {
        throw new Error("The registered credential tool was unavailable to the personal sandbox");
      }
      return tool.execute("credential-proof-call", { action: "request", envName });
    },
    async close() {
      await closeHttpServer(api);
      await handoff.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type CredentialFixture = Awaited<ReturnType<typeof startCredentialFixture>>;

async function screenshot(page: Page, locale: string, state: string) {
  if (captureProof) {
    await mkdir(proofDir, { recursive: true });
    await page.screenshot({
      path: path.join(proofDir, `${locale}-${state}.png`),
      animations: "disabled",
      fullPage: true,
    });
  }
}

async function openConversation(locale: "ko" | "en") {
  const fixture = await startCredentialFixture();
  fixtures.add(fixture);
  const context = await browser.newContext({
    locale: locale === "ko" ? "ko-KR" : "en-US",
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    ...(captureProof ? { recordVideo: { dir: proofDir, size: { width: 1440, height: 900 } } } : {}),
  });
  contexts.add(context);
  await context.addCookies([
    { name: "platformclaw_session", value: "synthetic-session-only", url: server.baseUrl },
  ]);
  const page = await context.newPage();
  await page.addInitScript((selectedLocale) => {
    localStorage.setItem("openclaw.i18n.locale", selectedLocale);
    localStorage.setItem("openclaw.confetti.firstReply", "1");
  }, locale);
  const documentResponse = await page.request.get(server.baseUrl);
  const source = await documentResponse.text();
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      body: source.replace(
        "</head>",
        `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'></head>`,
      ),
      contentType: "text/html",
    }),
  );
  await page.route("**/platformclaw/api/announcements", (route) =>
    route.fulfill({ json: { revision: 0, serverNow: Date.now(), announcement: null } }),
  );
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: fixture.accountId,
          displayName: "Credential Proof",
          globalRole: "member",
          department: "Synthetic",
        },
        agent: { agentId: fixture.agentId, state: "active" },
        session: { idleExpiresAt: Date.now() + 600_000, absoluteExpiresAt: Date.now() + 600_000 },
      },
    }),
  );
  await page.route("**/platformclaw/api/exec-credentials", async (route) => {
    const response = await route.fetch({ url: fixture.apiUrl });
    await route.fulfill({ response });
  });
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: fixture.agentId,
    sessionKey: fixture.sessionKey,
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    methodResponses: {
      "chat.history": {
        sessionId,
        messages: [],
        sessionInfo: { sessionId, activeLeafEntryId: null, hasActiveRun: false, activeRunIds: [] },
      },
    },
  });
  const conversationUrl = controlUiSessionUrl(
    `${server.baseUrl}platformclaw/app/`,
    fixture.sessionKey,
  );
  await page.goto(conversationUrl);
  await page.locator(".agent-chat__composer-combobox textarea").waitFor();
  return { page, gateway, fixture, conversationPath: new URL(conversationUrl).pathname };
}

async function requestCredential(
  page: Page,
  gateway: MockGatewayControls,
  fixture: CredentialFixture,
) {
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.fill(`Create the synthetic report. Its documented key is ${envName}.`);
  await composer.press("Enter");
  const request = await gateway.waitForRequest("chat.send");
  const params = request.params as { idempotencyKey: string };
  const runId = params.idempotencyKey;
  // The real Gateway acknowledges the run before dispatching tools. Request
  // observation alone can precede the mock's timer-delivered ACK.
  await expect
    .poll(() =>
      page.locator("openclaw-chat-pane").evaluate((element) => {
        const pane = element as HTMLElement & { state: { chatRunId: string | null } };
        return pane.state.chatRunId;
      }),
    )
    .toBe(runId);
  const result = await fixture.callRegisteredTool(runId);
  expect(fixture.metadataCalls()).toBeGreaterThan(0);
  const details = result.details as { status: string; uiAction: { requestId: string } };
  expect(details.status).toBe("required");
  const user = {
    role: "user",
    id: "credential-proof-source-user",
    __openclaw: { idempotencyKey: `${runId}:user` },
    content: [{ type: "text", text: `Create the synthetic report using ${envName}.` }],
  };
  const final = {
    role: "assistant",
    id: finalLeaf,
    content: [
      {
        type: "text",
        text: "이 합성 보고서 작업에는 개인 키가 필요합니다. 아래에서 안전하게 등록하세요. 저장하면 등록이 완료됩니다.",
      },
    ],
  };
  const messages = sanitizeChatHistoryMessages([
    user,
    {
      role: "toolResult",
      toolName: "platformclaw_credentials",
      toolCallId: "credential-proof-call",
      content: result.content,
      details: result.details,
    },
    final,
  ]);
  const history = {
    sessionId,
    messages,
    sessionInfo: { sessionId, activeLeafEntryId: finalLeaf, hasActiveRun: false, activeRunIds: [] },
  };
  await gateway.emitGatewayEvent("agent", {
    runId,
    sessionKey: fixture.sessionKey,
    agentId: fixture.agentId,
    sessionId,
    seq: 1,
    stream: "tool",
    ts: Date.now(),
    data: {
      phase: "start",
      name: "platformclaw_credentials",
      toolCallId: "credential-proof-call",
      args: { action: "request", envName },
    },
  });
  await gateway.emitGatewayEvent("agent", {
    runId,
    sessionKey: fixture.sessionKey,
    agentId: fixture.agentId,
    sessionId,
    seq: 2,
    stream: "tool",
    ts: Date.now(),
    data: {
      phase: "result",
      name: "platformclaw_credentials",
      toolCallId: "credential-proof-call",
      result,
    },
  });
  await gateway.setHistoryMessages(messages);
  await gateway.setMethodResponse("chat.history", history);
  await gateway.emitChatFinal({
    runId,
    sessionKey: fixture.sessionKey,
    text: "이 합성 보고서 작업에는 개인 키가 필요합니다. 아래에서 안전하게 등록하세요. 저장하면 등록이 완료됩니다.",
  });
  await expect.poll(() => page.locator('[data-credential-flow="required"]').count()).toBe(1);
  return { requestId: details.uiAction.requestId, result, history };
}

describeCredentialFlow("PlatformClaw contextual personal credentials on PC", () => {
  beforeAll(async () => {
    if (captureProof) {
      await mkdir(proofDir, { recursive: true });
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumPath });
  });
  afterEach(async () => {
    await Promise.all([...contexts].map((context) => context.close()));
    contexts.clear();
    for (const fixture of fixtures) {
      await fixture.close();
    }
    fixtures.clear();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(["ko", "en"] as const)(
    "completes registration in place without sending another turn in %s",
    async (locale) => {
      const { page, gateway, fixture } = await openConversation(locale);
      await requestCredential(page, gateway, fixture);
      const configure = locale === "ko" ? "키 등록하기" : "Add key";
      await screenshot(page, locale, "01-required");
      await page.getByRole("button", { name: configure, exact: true }).evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe("/platformclaw/app/settings/credentials");
      const form = page.locator("platformclaw-exec-credentials");
      const input = form.locator(`[data-value="${envName}"]`);
      await expect
        .poll(() =>
          input.evaluate(
            (element) => element === (element.getRootNode() as ShadowRoot | Document).activeElement,
          ),
        )
        .toBe(true);
      await screenshot(page, locale, "02-focused");
      await input.fill("synthetic-fixture-only");
      await form.locator(`[data-action="save"][data-env="${envName}"]`).evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
      await expect.poll(() => input.inputValue()).toBe("");
      await expect.poll(() => form.locator("[data-flow-cancel]").count()).toBe(0);
      expect(await form.locator("[data-flow-return]").count()).toBe(0);
      expect(fixture.saveCalls()).toBe(1);
      expect(await fixture.snapshot()).toMatchObject({
        definitions: [{ envName, configured: true }],
      });
      await screenshot(page, locale, "03-saved-unverified");
      expect(new URL(page.url()).pathname).toBe("/platformclaw/app/settings/credentials");
      expect((await gateway.getRequests("chat.send")).length).toBe(1);
      expect(await page.locator("[data-credential-flow]").count()).toBe(0);
      expect(await form.getByRole("status").textContent()).toMatch(
        locale === "ko" ? /저장했습니다/ : /Saved/u,
      );
      const backToChat = page.locator(".app-toast--bottom-right").getByRole("button", {
        name: locale === "ko" ? "챗으로 돌아가기" : "Back to chat",
        exact: true,
      });
      await backToChat.waitFor();
      await screenshot(page, locale, "04-return-notification");
      await backToChat.click();
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      expect(new URL(page.url()).pathname).toContain("/platformclaw/app/chat/");
      expect((await gateway.getRequests("chat.send")).length).toBe(1);
      expect(await page.locator("[data-credential-flow]").count()).toBe(0);
      expect(JSON.stringify(await gateway.getRequests())).not.toContain("synthetic-fixture-only");
    },
  );

  it("keeps a failed save visible, preserves its draft, and cancels without sending", async () => {
    const { page, gateway, fixture } = await openConversation("ko");
    await requestCredential(page, gateway, fixture);
    await page.getByRole("button", { name: "키 등록하기", exact: true }).click();
    const form = page.locator("platformclaw-exec-credentials");
    const input = form.locator(`[data-value="${envName}"]`);
    fixture.failSave();
    await input.fill("synthetic-failed-save-only");
    await form.locator(`[data-action="save"][data-env="${envName}"]`).click();
    await expect.poll(() => form.getByRole("alert").textContent()).not.toBe("");
    expect(await input.inputValue()).toBe("synthetic-failed-save-only");
    expect(await form.locator("[data-flow-cancel]").count()).toBe(1);
    // Capture only a cleared field; neither screenshots nor gateway traffic retain its value.
    await input.fill("");
    await screenshot(page, "ko", "06-save-failed");
    await form.locator("[data-flow-cancel]").click();
    expect((await gateway.getRequests("chat.send")).length).toBe(1);
    expect(await page.getByRole("button", { name: "계속하기", exact: true }).count()).toBe(0);
    expect(await fixture.snapshot()).toMatchObject({
      definitions: [{ envName, configured: false }],
    });
  });

  it("does not reactivate an action from history after a page reload", async () => {
    const { page, gateway, fixture } = await openConversation("ko");
    await requestCredential(page, gateway, fixture);
    await page.reload();
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    expect(await page.locator("[data-credential-flow]").count()).toBe(0);
    expect(await page.getByRole("button", { name: "키 등록하기", exact: true }).count()).toBe(0);
    expect(fixture.saveCalls()).toBe(0);
  });

  it("retains the requested credential's return action after selecting and saving another key", async () => {
    const { page, gateway, fixture, conversationPath } = await openConversation("en");
    const siblingName = "SIBLING_API_TOKEN";
    await fixture.addSiblingDefinition(siblingName);
    await requestCredential(page, gateway, fixture);
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    const form = page.locator("platformclaw-exec-credentials");
    const requestedInput = form.locator(`[data-value="${envName}"]`);
    await requestedInput.fill("synthetic-requested-value");
    await form.locator(`[data-action="save"][data-env="${envName}"]`).click();
    const backToChat = page.locator(".app-toast--bottom-right").getByRole("button", {
      name: "Back to chat",
      exact: true,
    });
    await backToChat.waitFor();

    await form.locator(`[data-action="select"][data-env="${siblingName}"]`).click();
    const siblingInput = form.locator(`[data-value="${siblingName}"]`);
    await siblingInput.fill("synthetic-sibling-value");
    await form.locator(`[data-action="save"][data-env="${siblingName}"]`).click();
    await expect.poll(() => siblingInput.inputValue()).toBe("");
    expect(await backToChat.count()).toBe(1);
    expect(fixture.saveCalls()).toBe(2);
    expect((await fixture.snapshot()).definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ envName, configured: true }),
        expect.objectContaining({ envName: siblingName, configured: true }),
      ]),
    );
    await screenshot(page, "en", "08-target-return-after-sibling-save");
    await backToChat.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(conversationPath);
    expect((await gateway.getRequests("chat.send")).length).toBe(1);
    expect(await page.locator("[data-credential-flow]").count()).toBe(0);
    const gatewayTraffic = JSON.stringify(await gateway.getRequests());
    expect(gatewayTraffic).not.toContain("synthetic-requested-value");
    expect(gatewayTraffic).not.toContain("synthetic-sibling-value");
  });

  it("rejects save confirmation after the real store recreates the value at the same revision", async () => {
    const { page, gateway, fixture } = await openConversation("en");
    await requestCredential(page, gateway, fixture);
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    const form = page.locator("platformclaw-exec-credentials");
    fixture.failRefreshAfterSave();
    await form.locator(`[data-value="${envName}"]`).fill("synthetic-original-value");
    await form.locator(`[data-action="save"][data-env="${envName}"]`).click();
    await form.locator("[data-recheck]").waitFor();

    // The pending genuine ACK must not confirm a different generation on its GET retry.
    const { before, after } = await fixture.recreateRequestedValue("synthetic-recreated-value");
    expect(after.revision).toBe(before.revision);
    expect(after.definitionToken).toBe(before.definitionToken);
    expect(after.credentialToken).not.toBe(before.credentialToken);
    await form.locator("[data-recheck]").click();
    await form.getByRole("alert").waitFor();
    expect(await form.locator("[data-flow-cancel]").count()).toBe(1);
    expect(await page.locator(".app-toast__action").count()).toBe(0);
    expect(fixture.saveCalls()).toBe(1);
    expect((await fixture.snapshot()).definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ credentialToken: after.credentialToken })]),
    );
    expect((await gateway.getRequests("chat.send")).length).toBe(1);
    const gatewayTraffic = JSON.stringify(await gateway.getRequests());
    expect(gatewayTraffic).not.toContain("synthetic-original-value");
    expect(gatewayTraffic).not.toContain("synthetic-recreated-value");
    await screenshot(page, "en", "09-aba-confirmation-rejected");
  });

  it("keeps an acknowledged save unconfirmed after GET failure and rechecks without repeating POST", async () => {
    const { page, gateway, fixture } = await openConversation("ko");
    await requestCredential(page, gateway, fixture);
    await page.getByRole("button", { name: "키 등록하기", exact: true }).click();
    const form = page.locator("platformclaw-exec-credentials");
    const input = form.locator(`[data-value="${envName}"]`);
    await input.waitFor();
    fixture.failRefreshAfterSave();
    await input.fill("synthetic-ack-only");
    await form.locator(`[data-action="save"][data-env="${envName}"]`).click();
    await form.locator("[data-recheck]").waitFor();
    expect(await input.inputValue()).toBe("");
    // The ACK clears plaintext, but saved metadata is not confirmed until GET succeeds.
    expect(await form.locator("[data-flow-cancel]").count()).toBe(1);
    expect(await page.locator(".app-toast__action").count()).toBe(0);
    expect(fixture.saveCalls()).toBe(1);
    expect(await fixture.snapshot()).toMatchObject({
      definitions: [{ envName, configured: true }],
    });
    await screenshot(page, "ko", "07-saved-status-unconfirmed");
    const readsBeforeRecheck = fixture.readCalls();
    await form.locator("[data-recheck]").click();
    await expect.poll(() => form.locator("[data-flow-cancel]").count()).toBe(0);
    expect(fixture.readCalls()).toBeGreaterThan(readsBeforeRecheck);
    expect(fixture.saveCalls()).toBe(1);
    expect(new URL(page.url()).pathname).toBe("/platformclaw/app/settings/credentials");
    expect((await gateway.getRequests("chat.send")).length).toBe(1);
    expect(JSON.stringify(await gateway.getRequests())).not.toContain("synthetic-ack-only");
  });

  it("rejects a stale form after the authenticated account changes without writing either account", async () => {
    const { page, gateway, fixture } = await openConversation("en");
    await requestCredential(page, gateway, fixture);
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    const form = page.locator("platformclaw-exec-credentials");
    const input = form.locator(`[data-value="${envName}"]`);
    await input.fill("synthetic-old-account-only");
    fixture.switchAccount();
    await form.locator(`[data-action="save"][data-env="${envName}"]`).click();
    await expect.poll(() => input.inputValue()).toBe("");
    expect(await input.isDisabled()).toBe(true);
    expect(await form.getByRole("status").textContent()).toMatch(/account/iu);
    expect(await form.locator("[data-flow-return]").count()).toBe(0);
    expect(fixture.saveCalls()).toBe(1);
    expect(await fixture.snapshot()).toMatchObject({
      definitions: [{ envName, configured: false }],
    });
    expect(await fixture.otherSnapshot()).toMatchObject({
      definitions: [{ envName, configured: false }],
    });
    await screenshot(page, "en", "06-account-changed");
    expect((await gateway.getRequests("chat.send")).length).toBe(1);
    expect(JSON.stringify(await gateway.getRequests())).not.toContain("synthetic-old-account-only");
  });
});
