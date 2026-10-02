import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPACE_RPC_METHODS } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createPlatformClawMemoryContext,
  installPlatformClawMemoryDocument,
  platformClawMemoryAgentId,
  platformClawMemoryMethods,
  platformClawMemoryResponses,
} from "../test-helpers/platformclaw-memory-fixture.ts";

// Real shipped UI in Chromium; synthetic identities and Gateway replies only.
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "spaces");
const rpc = "platformclaw.spaces.";
const space = {
  id: "work-optics",
  name: "Optics Reliability Project",
  role: "owner",
  revision: 1,
  agentId: "space-synthetic",
};
const issue = {
  id: "issue-timing",
  spaceId: space.id,
  parentId: null,
  title: "Cold-start timing issue",
  body: "Board revision C: compare cold-start traces before changing the timing configuration.",
  revision: 1,
  createdBy: "alice",
  updatedAt: 1790856000000,
};
const child = {
  ...issue,
  id: "issue-followup",
  parentId: issue.id,
  title: "Revision C follow-up",
  body: "Reproduce with the same board revision.",
};
const alice = {
  userId: "alice",
  accountId: "alice.synthetic",
  displayName: "Alice Example",
  role: "owner",
};
const bob = {
  userId: "bob",
  accountId: "bob.synthetic",
  displayName: "Bob Example",
  role: "editor",
};
const messages = [
  {
    id: "message-a",
    role: "user",
    text: "Does the startup timeout depend on board revision?",
    authorName: alice.displayName,
    timestamp: issue.updatedAt,
  },
  {
    id: "message-b",
    role: "assistant",
    text: "The shared notes describe revision C. Compare the cold-start conditions before assuming the same cause.",
    timestamp: issue.updatedAt + 1000,
  },
] as const;
const conversation = {
  id: "conversation-alice",
  spaceId: space.id,
  pageId: issue.id,
  title: "Compare revision C traces",
  ownerId: alice.userId,
  ownerName: alice.displayName,
  agentId: platformClawMemoryAgentId,
  sessionKey: `agent:${platformClawMemoryAgentId}:space-session:00000000-0000-4000-8000-000000000001`,
  createdAt: issue.updatedAt,
  canWrite: true,
};
const nativeMessages = [
  {
    id: "personal-user",
    role: "user",
    content: [{ type: "text", text: "Compare the revision C evidence." }],
    timestamp: issue.updatedAt,
  },
  {
    id: "personal-assistant",
    role: "assistant",
    content: [
      { type: "text", text: "The personal agent found the shared timing evidence." },
      { type: "toolCall", id: "call-shared-read", name: "read", arguments: { path: "traces.txt" } },
    ],
    timestamp: issue.updatedAt + 1000,
  },
  {
    role: "toolResult",
    toolCallId: "call-shared-read",
    toolName: "read",
    content: [{ type: "text", text: "Revision C cold-start traces" }],
    timestamp: issue.updatedAt + 2000,
  },
];
let browser: Browser;
let server: ControlUiE2eServer;

async function setup(
  name: string,
  width = 1440,
  role = "owner",
  locale = "en-US",
  conversations: Array<typeof conversation> = [],
) {
  const context = await createPlatformClawMemoryContext(browser, server.baseUrl, {
    locale,
    mode: "light",
    recordVideo: { dir: proofDir, size: { width, height: 1000 } },
    viewport: { width, height: 1000 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  await installPlatformClawMemoryDocument(page, server.baseUrl);
  const snapshot = {
    space: { ...space, role },
    pages: [issue, child],
    members: [alice, bob],
    currentUserId: role === "owner" ? alice.userId : bob.userId,
    conversations,
  };
  const gateway = await installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: platformClawMemoryAgentId,
    sessionKey: conversation.sessionKey,
    historyMessages: nativeMessages,
    featureMethods: [
      ...platformClawMemoryMethods,
      ...SPACE_RPC_METHODS,
      "chat.abort",
      "chat.history",
      "chat.metadata",
      "chat.send",
      "chat.startup",
      "sessions.list",
      "sessions.patch",
      "sessions.subscribe",
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "exec.approval.resolve",
    ],
    methodResponses: {
      ...platformClawMemoryResponses,
      [`${rpc}list`]: [snapshot.space],
      [`${rpc}get`]: snapshot,
      [`${rpc}create`]: space,
      [`${rpc}page.create`]: issue,
      [`${rpc}chat.history`]: { messages },
      [`${rpc}conversation.create`]: conversation,
      [`${rpc}conversation.history`]: {
        messages: nativeMessages,
        sessionKey: conversation.sessionKey,
        conversation: conversations[0] ?? conversation,
      },
      [`${rpc}people`]: [bob],
      [`${rpc}member.set`]: { updated: true },
      [`${rpc}member.remove`]: { updated: true },
      [`${rpc}search`]: {
        results: [
          {
            spaceId: space.id,
            pageId: issue.id,
            pageTitle: issue.title,
            snippet: messages[0].text,
            messageId: "message-a",
            link: `/spaces?space=${space.id}&page=${issue.id}&message=message-a`,
          },
        ],
      },
    },
  });
  return { context, page, gateway, snapshot, name };
}
async function capture(page: Page, name: string) {
  await page.screenshot({
    path: path.join(proofDir, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}
async function finish(context: BrowserContext, page: Page, name: string) {
  const video = page.video();
  try {
    await capture(page, `${name}-final`);
  } finally {
    await context.tracing.stop({ path: path.join(proofDir, `${name}-trace.zip`) });
    await context.close();
    await video?.saveAs(path.join(proofDir, `${name}.webm`));
  }
}
suite("Team Space rendered browser workflows", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error("Playwright Chromium is required for Space browser verification.");
    }
    await mkdir(proofDir, { recursive: true });
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("creates a Space, confirms membership, nests issues and retains attributed legacy Q&A", async () => {
    const { context, page, gateway, snapshot, name } = await setup("owner-desktop");
    try {
      await page.goto(`${server.baseUrl}platformclaw/app/spaces`);
      const spacesLink = page.getByRole("link", { name: "Spaces", exact: true });
      await expect.poll(() => spacesLink.isVisible()).toBe(true);
      await spacesLink.click();
      const ui = page.locator("platformclaw-spaces-page");
      await expect
        .poll(() => ui.getByRole("button", { name: "Create Space", exact: true }).isVisible())
        .toBe(true);
      await ui.getByRole("button", { name: "Create Space", exact: true }).click();
      await ui.getByLabel("Title", { exact: true }).fill(space.name);
      await gateway.setMethodResponse(`${rpc}list`, [space]);
      await gateway.setMethodResponse(`${rpc}get`, { ...snapshot, pages: [], members: [alice] });
      await ui.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests(`${rpc}create`)).at(-1)?.params)
        .toMatchObject({ name: space.name });
      await expect.poll(() => ui.getByRole("heading", { name: space.name }).isVisible()).toBe(true);
      await ui.getByRole("button", { name: "Members and access", exact: true }).click();
      await ui.getByLabel("Exact employee account ID", { exact: true }).fill(bob.accountId);
      await ui.getByRole("button", { name: "Find employee", exact: true }).click();
      await ui
        .getByRole("button", { name: `Invite ${bob.displayName} (${bob.accountId})`, exact: true })
        .click();
      const confirmation = ui.getByRole("alertdialog");
      await expect.poll(() => confirmation.textContent()).toContain("existing and future");
      await capture(page, "owner-invite-confirmation");
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests(`${rpc}member.set`)).toHaveLength(0);
      await ui
        .getByRole("button", { name: `Invite ${bob.displayName} (${bob.accountId})`, exact: true })
        .click();
      await gateway.setMethodResponse(`${rpc}get`, { ...snapshot, pages: [] });
      await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests(`${rpc}member.set`)).at(-1)?.params)
        .toMatchObject({
          spaceId: space.id,
          userId: bob.userId,
          role: "editor",
          expectedRevision: 1,
        });
      await ui.getByRole("button", { name: "Members and access", exact: true }).click();
      await ui.getByRole("button", { name: "New issue page", exact: true }).click();
      await ui.getByLabel("Title", { exact: true }).fill(issue.title);
      await ui.getByLabel("Issue description / notes", { exact: true }).fill(issue.body);
      await gateway.setMethodResponse(`${rpc}get`, { ...snapshot, pages: [issue] });
      await ui.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(() => ui.getByRole("heading", { name: issue.title }).isVisible())
        .toBe(true);
      expect((await gateway.getRequests(`${rpc}page.create`)).at(-1)?.params).not.toHaveProperty(
        "parentId",
      );
      await ui.getByRole("button", { name: "Notes", exact: true }).click();
      await ui.getByRole("button", { name: "New child issue", exact: true }).click();
      await ui.getByLabel("Title", { exact: true }).fill(child.title);
      await ui.getByLabel("Issue description / notes", { exact: true }).fill(child.body);
      await capture(page, "owner-page-editor");
      await gateway.setMethodResponse(`${rpc}page.create`, child);
      await gateway.setMethodResponse(`${rpc}get`, snapshot);
      await ui.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests(`${rpc}page.create`)).at(-1)?.params)
        .toMatchObject({ parentId: issue.id, title: child.title });
      await ui.getByRole("button", { name: issue.title, exact: true }).click();
      await ui.getByRole("tab", { name: "Shared Q&A", exact: true }).click();
      await expect.poll(() => ui.locator("#message-message-a").isVisible()).toBe(true);
      expect(await ui.locator(".pc-space-conversation textarea").count()).toBe(0);
      expect(await gateway.getRequests(`${rpc}chat.send`)).toHaveLength(0);
      await ui
        .getByRole("region", { name: "Issue conversation", exact: true })
        .scrollIntoViewIfNeeded();
      await capture(page, "owner-shared-conversation");
      expect(await ui.locator("#message-message-a").textContent()).toContain(alice.displayName);
      await ui
        .getByRole("searchbox", { name: "Search shared issues", exact: true })
        .fill("board revision");
      await ui.getByRole("button", { name: "Search shared issues", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests(`${rpc}search`)).length).toBe(1);
      await ui
        .getByRole("region", { name: "Search results", exact: true })
        .getByRole("button")
        .first()
        .click();
      await expect.poll(() => new URL(page.url()).searchParams.get("message")).toBe("message-a");
    } finally {
      await finish(context, page, name);
    }
  });

  it("creates an owned personal conversation in Space and keeps canonical tools, approvals and interruption", async () => {
    const { context, page, gateway, snapshot, name } = await setup("owner-personal-session");
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      await ui.getByRole("button", { name: "New conversation", exact: true }).click();
      await ui.getByLabel("Title", { exact: true }).fill(conversation.title);
      await expect
        .poll(() => ui.locator(".pc-space-panel-hint").textContent())
        .toContain("Only you can open this conversation");
      expect(await ui.locator(".pc-space-panel-hint").textContent()).toContain(
        "Questions and final answers",
      );
      await capture(page, "owner-conversation-sharing-notice");
      await gateway.setMethodResponse(`${rpc}get`, { ...snapshot, conversations: [conversation] });
      await gateway.deferNext(`${rpc}conversation.create`);
      const create = ui.getByRole("button", { name: "Create conversation", exact: true });
      await create.click();
      const creation = await gateway.waitForRequest(`${rpc}conversation.create`);
      expect(creation.params).toMatchObject({
        spaceId: space.id,
        pageId: issue.id,
        title: conversation.title,
        requestId: expect.any(String),
      });
      expect(await create.isDisabled()).toBe(true);
      expect(await gateway.getRequests(`${rpc}conversation.create`)).toHaveLength(1);
      await gateway.resolveDeferred(`${rpc}conversation.create`, conversation);
      const tab = ui.locator(`[role="tab"][data-conversation-id="${conversation.id}"]`);
      await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
      await expect.poll(() => tab.textContent()).toContain("Your personal agent");
      expect(new URL(page.url()).pathname).toBe("/platformclaw/app/spaces");
      const pane = ui.locator("openclaw-chat-pane");
      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Inspect the cold-start trace on my personal agent.");
      await pane.getByRole("button", { name: "Send message", exact: true }).click();
      const send = await gateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey: conversation.sessionKey,
        message: "Inspect the cold-start trace on my personal agent.",
      });
      const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
      await gateway.emitGatewayEvent("agent", {
        runId,
        seq: 1,
        stream: "tool",
        ts: Date.now(),
        sessionKey: conversation.sessionKey,
        data: {
          toolCallId: "owner-trace-read",
          name: "read",
          phase: "start",
          args: { path: "private-cold-start-trace.txt" },
        },
      });
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey: conversation.sessionKey,
        state: "delta",
        deltaText: "Inspecting the trace privately before summarizing.",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Inspecting the trace privately before summarizing." }],
        },
      });
      await pane.locator(".chat-tool-row--running").waitFor();
      await pane.getByText("Inspecting the trace privately before summarizing.").waitFor();
      await gateway.emitGatewayEvent("exec.approval.requested", {
        id: "approval-space-owner",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 120_000,
        request: {
          command: "cat private-cold-start-trace.txt",
          agentId: conversation.agentId,
          sessionKey: conversation.sessionKey,
        },
      });
      const approval = pane.locator('[data-approval-id="approval-space-owner"]');
      await approval.getByRole("button", { name: "Allow once", exact: true }).waitFor();
      await expect
        .poll(() => page.locator('[data-approval-id="approval-space-owner"]').count())
        .toBe(1);
      expect(await page.locator("openclaw-exec-approval .exec-approval-card").count()).toBe(0);
      await capture(page, "owner-native-tool-and-approval");
      await approval.getByRole("button", { name: "Allow once", exact: true }).click();
      expect((await gateway.waitForRequest("exec.approval.resolve")).params).toMatchObject({
        id: "approval-space-owner",
        decision: "allow-once",
      });
      await pane.getByRole("button", { name: "Stop generating", exact: true }).click();
      expect((await gateway.waitForRequest("chat.abort")).params).toMatchObject({
        sessionKey: conversation.sessionKey,
      });
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey: conversation.sessionKey,
        state: "aborted",
      });
      await expect
        .poll(() => pane.getByRole("button", { name: "Stop generating" }).count())
        .toBe(0);
      await composer.fill("Continue with only the final summary.");
      await pane.getByRole("button", { name: "Send message", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
      const sends = await gateway.getRequests("chat.send");
      const second = sends[1].params as { idempotencyKey: string; sessionKey: string };
      expect(second.sessionKey).toBe(conversation.sessionKey);
      expect(second.idempotencyKey).not.toBe(runId);
      await gateway.emitChatFinal({
        runId: second.idempotencyKey,
        sessionKey: conversation.sessionKey,
        text: "The final summary is available for Space agent recall.",
      });
      await pane.getByText("The final summary is available for Space agent recall.").waitFor();
      expect(new URL(page.url()).pathname).toBe("/platformclaw/app/spaces");
      expect(await gateway.getRequests(`${rpc}chat.send`)).toHaveLength(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests(`${rpc}conversation.create`)).toHaveLength(1);
      await capture(page, "owner-personal-conversation-result");
      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await gateway.setMethodResponse(`${rpc}get`, {
        ...snapshot,
        space: { ...snapshot.space, role: "viewer" },
        conversations: [{ ...conversation, canWrite: false }],
      });
      await gateway.emitGatewayEvent("platformclaw.spaces.invalidated", {});
      const readonly = ui.locator("platformclaw-space-conversation-history");
      await readonly
        .getByText("The personal agent found the shared timing evidence.", { exact: true })
        .waitFor();
      expect((await gateway.waitForRequest(`${rpc}conversation.history`)).params).toMatchObject({
        spaceId: space.id,
        conversationId: conversation.id,
      });
      expect(await pane.count()).toBe(0);
      expect(await ui.locator("textarea").count()).toBe(0);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(startupCount);
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
      await capture(page, "owner-lost-write-access");
    } finally {
      await finish(context, page, name);
    }
  });

  it("keeps another member's personal tab inaccessible even through a guessed conversation URL", async () => {
    const { context, page, gateway, name } = await setup(
      "member-private-tab-isolation",
      1440,
      "editor",
    );
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}&conversation=${conversation.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      await ui.locator("#message-message-a").waitFor();
      expect(
        await ui.locator(`[role="tab"][data-conversation-id="${conversation.id}"]`).count(),
      ).toBe(0);
      expect(await ui.locator("openclaw-chat-pane").count()).toBe(0);
      expect(await ui.locator("textarea").count()).toBe(0);
      expect(await ui.textContent()).not.toContain(
        "The personal agent found the shared timing evidence.",
      );
      await gateway.emitGatewayEvent("agent", {
        runId: "owner-private-run",
        seq: 1,
        stream: "tool",
        ts: Date.now(),
        sessionKey: conversation.sessionKey,
        data: {
          toolCallId: "private-tool",
          name: "read",
          phase: "result",
          result: "Private tool result must not leak",
        },
      });
      await gateway.emitChatFinal({
        runId: "owner-private-run",
        sessionKey: conversation.sessionKey,
        text: "Another user's private final answer must not appear in this browser",
      });
      await capture(page, "member-private-tab-inaccessible");
      expect(await ui.textContent()).not.toContain("Private tool result must not leak");
      expect(await ui.textContent()).not.toContain("Another user's private final answer");
      for (const method of [
        `${rpc}conversation.history`,
        "chat.send",
        "chat.abort",
        "chat.startup",
        "chat.history",
        "sessions.patch",
        "sessions.create",
        "sessions.messages.subscribe",
        "exec.approval.resolve",
      ]) {
        expect(await gateway.getRequests(method), method).toHaveLength(0);
      }
      const expand = ui.getByRole("button", { name: `Expand ${issue.title}`, exact: true });
      if (await expand.count()) {
        await expand.click();
      }
      await ui.getByRole("button", { name: child.title, exact: true }).waitFor();
      await ui.getByRole("button", { name: `Collapse ${issue.title}`, exact: true }).click();
      expect(await ui.getByRole("button", { name: child.title, exact: true }).count()).toBe(0);
      await ui.getByRole("button", { name: `Expand ${issue.title}`, exact: true }).click();
      await ui.getByRole("button", { name: child.title, exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe(child.id);
      await ui.getByRole("button", { name: issue.title, exact: true }).click();
      await ui.getByRole("tab", { name: "Shared Q&A", exact: true }).waitFor();
    } finally {
      await finish(context, page, name);
    }
  });

  it("clears a viewer's visible conversation and search on access revocation", async () => {
    const { context, page, gateway, name } = await setup("viewer-revocation", 1440, "viewer");
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      await expect.poll(() => ui.locator("#message-message-a").isVisible()).toBe(true);
      expect(await ui.getByRole("button", { name: "Send to Space", exact: true }).count()).toBe(0);
      await ui.getByRole("button", { name: "Notes", exact: true }).click();
      expect(await ui.getByRole("button", { name: "Edit page", exact: true }).count()).toBe(0);
      await capture(page, "viewer-read-only");
      await ui.getByRole("button", { name: "Close panel", exact: true }).click();
      await gateway.setMethodResponse(`${rpc}list`, []);
      await gateway.emitGatewayEvent("platformclaw.spaces.invalidated", {});
      await expect.poll(() => ui.textContent()).not.toContain(messages[0].text);
      await expect.poll(() => ui.getByRole("alert").textContent()).toContain("no longer available");
      expect(await gateway.getRequests(`${rpc}chat.send`)).toHaveLength(0);
    } finally {
      await finish(context, page, name);
    }
  });

  it("shows recoverable loading failures and preserves cancelled edits at narrow width", async () => {
    const { context, page, gateway, name } = await setup("narrow-error-recovery", 390);
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      await expect.poll(() => ui.locator("#message-message-a").isVisible()).toBe(true);
      await ui.getByRole("button", { name: "Notes", exact: true }).click();
      await ui.getByRole("button", { name: "Edit page", exact: true }).click();
      await ui.getByLabel("Title", { exact: true }).fill("Uncommitted edit");
      await ui.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests(`${rpc}page.save`)).toHaveLength(0);
      await ui.getByRole("button", { name: "Close panel", exact: true }).click();
      await ui
        .getByRole("button", { name: "Browse Spaces and conversations", exact: true })
        .click();
      await gateway.setMethodResponse(`${rpc}list`, {
        __mockError: { code: "UNAVAILABLE", message: "Synthetic retryable service error" },
      });
      await ui.getByRole("button", { name: "Refresh", exact: true }).click();
      await ui.getByRole("button", { name: "Back to conversation", exact: true }).click();
      await expect
        .poll(() => ui.getByRole("alert").textContent())
        .toContain("Synthetic retryable service error");
      await capture(page, "narrow-load-error");
      await gateway.setMethodResponse(`${rpc}list`, [space]);
      await ui.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => ui.locator("#message-message-a").isVisible()).toBe(true);
      const overflow = await ui.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      expect(overflow).toBe(false);
      await capture(page, "narrow-restored-conversation");
    } finally {
      await finish(context, page, name);
    }
  });
  it("renders the corrected shared issue in Korean", async () => {
    const { context, page, name } = await setup("owner-korean-desktop", 1440, "owner", "ko-KR");
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      await expect
        .poll(() => ui.getByRole("button", { name: "구성원과 접근 권한", exact: true }).isVisible())
        .toBe(true);
      await expect.poll(() => ui.locator("#message-message-a").isVisible()).toBe(true);
      await expect
        .poll(() => page.locator('a[href="/platformclaw/app/spaces"]').textContent())
        .toContain("Spaces");
      await capture(page, "korean-issue-overview");
      await ui.getByRole("region", { name: "이슈 대화", exact: true }).scrollIntoViewIfNeeded();
      await capture(page, "korean-shared-conversation");
    } finally {
      await finish(context, page, name);
    }
  });
});
