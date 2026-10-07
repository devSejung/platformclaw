import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { PLATFORMCLAW_WEB_GATEWAY_METHODS } from "../../../packages/platformclaw-control-plane/src/browser-gateway-policy.ts";
import { createChatFlowE2eSuite } from "../e2e/chat-flow.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { PLATFORMCLAW_WEB_DESCRIPTOR } from "./web-contract.ts";

const suite = createChatFlowE2eSuite();
const agentId = "personal-alice";
const mainKey = `agent:${agentId}:main`;
// Main lives behind Home; the ordinary thread list intentionally omits it.
const personalKey = `agent:${agentId}:personal-thread`;
const spaceKey = `agent:${agentId}:space-session:00000000-0000-4000-8000-000000000001`;
const space = { id: "space-one", name: "Synthetic project", role: "owner", revision: 1 };
const issue = {
  id: "issue-one",
  spaceId: space.id,
  parentId: null,
  title: "Synthetic issue",
  body: "Shared project notes",
  revision: 1,
  createdBy: "alice",
  updatedAt: 100,
};
const conversation = {
  id: "conversation-one",
  spaceId: space.id,
  pageId: issue.id,
  title: "Space investigation",
  ownerId: "alice",
  ownerName: "Alice",
  agentId,
  sessionKey: spaceKey,
  createdAt: 100,
  canWrite: true,
};
const spaceRow = { key: spaceKey, kind: "direct", label: conversation.title, updatedAt: 200 };
const personalRow = {
  key: personalKey,
  kind: "direct",
  label: "Personal conversation",
  updatedAt: 100,
};
const proofDir = path.join(process.cwd(), ".artifacts/control-ui-e2e/spaces-navigation");

async function installDocument(page: Page) {
  const response = await page.request.get(suite.server.baseUrl);
  const source = await response.text();
  const descriptor = `<meta name="platformclaw-web-descriptor" content='${JSON.stringify(PLATFORMCLAW_WEB_DESCRIPTOR)}'>`;
  await page.route("**/platformclaw/app/**", (route) =>
    route.fulfill({
      body: source.replace("</head>", `${descriptor}</head>`),
      headers: response.headers(),
      status: response.status(),
    }),
  );
  await page.route("**/platformclaw/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          accountId: "alice",
          displayName: "Alice",
          department: "Synthetic Lab",
          globalRole: "member",
        },
        agent: { agentId, state: "active" },
      },
    }),
  );
  await page.route("**/platformclaw/api/organization/**", (route) =>
    route.fulfill({ json: { requests: [] } }),
  );
}

async function installScenario(page: Page) {
  await installDocument(page);
  const historyResponses = {
    cases: [
      {
        match: { sessionKey: spaceKey },
        response: {
          messages: [{ role: "assistant", content: "Space transcript ready." }],
          sessionInfo: spaceRow,
        },
      },
      {
        match: { sessionKey: personalKey },
        response: {
          messages: [{ role: "assistant", content: "Personal transcript ready." }],
          sessionInfo: personalRow,
        },
      },
    ],
  };
  return installMockGateway(page, {
    basePath: "/platformclaw/app",
    defaultAgentId: agentId,
    sessionKey: mainKey,
    featureMethods: [...PLATFORMCLAW_WEB_GATEWAY_METHODS],
    historyMessages: [{ role: "assistant", content: "Synthetic conversation ready." }],
    methodResponses: {
      "sessions.list": { ts: 100, path: "", count: 1, sessions: [personalRow], defaults: {} },
      "platformclaw.spaces.list": [space],
      "platformclaw.spaces.get": {
        space,
        pages: [issue],
        members: [],
        conversations: [conversation],
        currentUserId: "alice",
      },
      "platformclaw.spaces.chat.history": { messages: [] },
      "platformclaw.spaces.conversation.resolve": {
        spaceId: space.id,
        pageId: issue.id,
        conversationId: conversation.id,
      },
      "chat.history": historyResponses,
      "chat.startup": historyResponses,
    },
  });
}

suite.define(() => {
  it("opens old native Space links in their Space and preserves back navigation", async () => {
    const context = await suite.newBrowserContext({ locale: "en-US", serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const gateway = await installScenario(page);
      const oldUrl = `${suite.server.baseUrl}platformclaw/app/chat/${agentId}/space-session/00000000-0000-4000-8000-000000000001`;
      await page.goto(oldUrl);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/spaces");
      expect(new URL(page.url()).searchParams.get("conversation")).toBe(conversation.id);
      await page
        .locator("platformclaw-spaces-page openclaw-chat-pane .chat-thread-inner")
        .getByText("Space transcript ready.", { exact: true })
        .waitFor();
      expect(
        (await gateway.getRequests("chat.history")).every(
          (request) =>
            !request.params || (request.params as { sessionKey?: string }).sessionKey === spaceKey,
        ),
      ).toBe(true);

      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${personalKey}"] > a.sidebar-recent-session__link`,
        )
        .click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(`/platformclaw/app/chat/${agentId}/personal-thread`);
      await page
        .locator("openclaw-chat-page .chat-thread-inner")
        .getByText("Personal transcript ready.", { exact: true })
        .waitFor();
      // A browser back to the old URL must not return to standalone Space chat.
      await page.goBack();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/platformclaw/app/spaces");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps embedded Space history and events out of personal navigation through refresh", async () => {
    const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    if (capture) {
      await mkdir(proofDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 1000 },
      ...(capture ? { recordVideo: { dir: proofDir } } : {}),
    });
    try {
      const page = await context.newPage();
      const gateway = await installScenario(page);
      const url = `${suite.server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}&conversation=${conversation.id}`;
      await page.goto(url);
      const pane = page.locator("platformclaw-spaces-page openclaw-chat-pane");
      const transcript = pane.locator(".chat-thread-inner");
      await expect.poll(() => pane.count()).toBe(1);
      await transcript.getByText("Space transcript ready.", { exact: true }).waitFor();
      await expect
        .poll(() =>
          page.locator(`.sidebar-recent-session[data-session-key="${personalKey}"]`).count(),
        )
        .toBe(1);
      expect(
        await page.locator(`.sidebar-recent-session[data-session-key="${spaceKey}"]`).count(),
      ).toBe(0);
      await gateway.emitGatewayEvent("sessions.changed", {
        reason: "updated",
        sessionKey: spaceKey,
        session: spaceRow,
      });
      await pane
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Synthetic Space question");
      await pane.getByRole("button", { name: "Send message" }).click();
      const send = await gateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({ sessionKey: spaceKey });
      await gateway.emitChatFinal({
        sessionKey: spaceKey,
        runId: (send.params as { idempotencyKey: string }).idempotencyKey,
        text: "Space event delivered.",
      });
      await transcript.getByText("Space event delivered.", { exact: true }).waitFor();
      expect(
        await page.locator(`.sidebar-recent-session[data-session-key="${spaceKey}"]`).count(),
      ).toBe(0);
      if (capture) {
        await page.screenshot({ path: path.join(proofDir, "space-embedded.png"), fullPage: true });
      }
      await page.reload();
      await transcript.getByText("Space transcript ready.", { exact: true }).waitFor();
      expect(
        await page.locator(`.sidebar-recent-session[data-session-key="${spaceKey}"]`).count(),
      ).toBe(0);
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${personalKey}"] > a.sidebar-recent-session__link`,
        )
        .click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(`/platformclaw/app/chat/${agentId}/personal-thread`);
      await page
        .locator("openclaw-chat-page .chat-thread-inner")
        .getByText("Personal transcript ready.", { exact: true })
        .waitFor();
      expect(await page.locator("platformclaw-spaces-page").count()).toBe(0);
      if (capture) {
        await page.screenshot({
          path: path.join(proofDir, "personal-navigation.png"),
          fullPage: true,
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
