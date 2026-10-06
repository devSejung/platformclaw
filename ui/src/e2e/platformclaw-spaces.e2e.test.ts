import { expect, it } from "vitest";
import {
  capture,
  conversation,
  finish,
  issue,
  messages,
  rpc,
  server,
  setup,
  setupSpaceBrowserTests,
  space,
  suite,
  alice,
  bob,
  child,
  nativeSessionCases,
} from "./platformclaw-spaces.e2e-helpers.ts";
suite("Team Space rendered browser workflows", () => {
  setupSpaceBrowserTests();

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
      const people = ui.getByRole("combobox", { name: "Employee name or account ID" });
      await people.fill("Bob");
      await ui
        .getByRole("option", { name: `Invite ${bob.displayName} (${bob.accountId})`, exact: true })
        .waitFor();
      expect((await gateway.getRequests(`${rpc}people`)).at(-1)?.params).toMatchObject({
        spaceId: space.id,
        query: "Bob",
      });
      await capture(page, "owner-member-search-suggestions");
      await people.press("ArrowDown");
      await people.press("Enter");
      const confirmation = ui.getByRole("alertdialog");
      await expect.poll(() => confirmation.textContent()).toContain("only their own agent tabs");
      expect(await confirmation.textContent()).toContain("questions and final answers");
      expect(await confirmation.textContent()).toContain("tools and credentials stay private");
      await capture(page, "owner-invite-confirmation");
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests(`${rpc}member.set`)).toHaveLength(0);
      await people.fill("bob.syn");
      await ui
        .getByRole("option", { name: `Invite ${bob.displayName} (${bob.accountId})`, exact: true })
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

  it.each(nativeSessionCases)(
    "creates an owned $locale Space conversation with canonical tools, approvals and interruption",
    async (copy) => {
      const { context, page, gateway, snapshot, fixture, name } = await setup(
        `${copy.prefix}-personal-session`,
        1440,
        "owner",
        copy.locale,
      );
      try {
        await page.goto(
          `${server.baseUrl}platformclaw/app/spaces?space=${fixture.space.id}&page=${fixture.issue.id}`,
        );
        const ui = page.locator("platformclaw-spaces-page");
        await expect
          .poll(() => page.locator("html").getAttribute("lang"))
          .toBe(copy.locale === "ko-KR" ? "ko" : "en");
        await ui.getByRole("heading", { name: fixture.issue.title, exact: true }).waitFor();
        await ui.getByRole("button", { name: copy.newConversation, exact: true }).click();
        await ui.getByLabel(copy.titleLabel, { exact: true }).fill(fixture.conversation.title);
        await expect
          .poll(() => ui.locator(".pc-space-panel-hint").textContent())
          .toContain(copy.sharingPrivate);
        expect(await ui.locator(".pc-space-panel-hint").textContent()).toContain(
          copy.sharingPublic,
        );
        await capture(page, `${copy.prefix}-conversation-sharing-notice`);
        await gateway.setMethodResponse(`${rpc}get`, {
          ...snapshot,
          conversations: [fixture.conversation],
        });
        await gateway.deferNext(`${rpc}conversation.create`);
        const create = ui.getByRole("button", { name: copy.createConversation, exact: true });
        await create.click();
        const creation = await gateway.waitForRequest(`${rpc}conversation.create`);
        expect(creation.params).toMatchObject({
          spaceId: fixture.space.id,
          pageId: fixture.issue.id,
          title: fixture.conversation.title,
          requestId: expect.any(String),
        });
        expect(await create.isDisabled()).toBe(true);
        expect(await gateway.getRequests(`${rpc}conversation.create`)).toHaveLength(1);
        await gateway.resolveDeferred(`${rpc}conversation.create`, fixture.conversation);
        const tab = ui.getByRole("tab").filter({
          has: page.locator(`[data-conversation-id="${fixture.conversation.id}"]`),
        });
        await expect.poll(() => tab.getAttribute("aria-selected")).toBe("true");
        await expect.poll(() => tab.textContent()).toContain(copy.personalAgent);
        expect(new URL(page.url()).pathname).toBe("/platformclaw/app/spaces");
        const pane = ui.locator("openclaw-chat-pane");
        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        await composer.fill(copy.question);
        await pane.getByRole("button", { name: copy.sendMessage, exact: true }).click();
        const send = await gateway.waitForRequest("chat.send");
        expect(send.params).toMatchObject({
          sessionKey: fixture.conversation.sessionKey,
          message: copy.question,
        });
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        await gateway.emitGatewayEvent("agent", {
          runId,
          seq: 1,
          stream: "tool",
          ts: Date.now(),
          sessionKey: fixture.conversation.sessionKey,
          data: {
            toolCallId: "owner-trace-read",
            name: "read",
            phase: "start",
            args: { path: copy.tracePath },
          },
        });
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: fixture.conversation.sessionKey,
          state: "delta",
          deltaText: copy.progress,
          message: {
            role: "assistant",
            content: [{ type: "text", text: copy.progress }],
          },
        });
        await pane.locator(".chat-tool-row--running").waitFor();
        await pane.getByText(copy.progress).waitFor();
        await gateway.emitGatewayEvent("exec.approval.requested", {
          id: "approval-space-owner",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
          request: {
            command: `cat ${copy.tracePath}`,
            agentId: fixture.conversation.agentId,
            sessionKey: fixture.conversation.sessionKey,
          },
        });
        const approval = pane.locator('[data-approval-id="approval-space-owner"]');
        await approval.getByRole("button", { name: copy.allowOnce, exact: true }).waitFor();
        expect(await approval.locator(".exec-approval-title").textContent()).toBe(
          copy.approvalTitle,
        );
        await expect
          .poll(() => page.locator('[data-approval-id="approval-space-owner"]').count())
          .toBe(1);
        expect(await page.locator("openclaw-exec-approval .exec-approval-card").count()).toBe(0);
        await capture(page, `${copy.prefix}-native-tool-and-approval`);
        await approval.getByRole("button", { name: copy.allowOnce, exact: true }).click();
        expect((await gateway.waitForRequest("exec.approval.resolve")).params).toMatchObject({
          id: "approval-space-owner",
          decision: "allow-once",
        });
        await pane.getByRole("button", { name: copy.stopGenerating, exact: true }).click();
        expect((await gateway.waitForRequest("chat.abort")).params).toMatchObject({
          sessionKey: fixture.conversation.sessionKey,
        });
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey: fixture.conversation.sessionKey,
          state: "aborted",
        });
        await expect
          .poll(() => pane.getByRole("button", { name: copy.stopGenerating }).count())
          .toBe(0);
        await composer.fill(copy.resume);
        await pane.getByRole("button", { name: copy.sendMessage, exact: true }).click();
        await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
        const sends = await gateway.getRequests("chat.send");
        expect(sends).toHaveLength(2);
        const secondSend = sends[1];
        if (!secondSend) {
          throw new Error("Expected the resumed conversation to send a second chat request.");
        }
        const second = secondSend.params as { idempotencyKey: string; sessionKey: string };
        expect(second.sessionKey).toBe(fixture.conversation.sessionKey);
        expect(second.idempotencyKey).not.toBe(runId);
        await gateway.emitChatFinal({
          runId: second.idempotencyKey,
          sessionKey: fixture.conversation.sessionKey,
          text: copy.finalAnswer,
        });
        const finalAnswer = pane.getByRole("paragraph").filter({ hasText: copy.finalAnswer });
        await finalAnswer.waitFor();
        expect(await finalAnswer.textContent()).toBe(copy.finalAnswer);
        expect(new URL(page.url()).pathname).toBe("/platformclaw/app/spaces");
        expect(await gateway.getRequests(`${rpc}chat.send`)).toHaveLength(0);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await gateway.getRequests(`${rpc}conversation.create`)).toHaveLength(1);
        await capture(page, `${copy.prefix}-personal-conversation-result`);
        const startupCount = (await gateway.getRequests("chat.startup")).length;
        await gateway.setMethodResponse(`${rpc}get`, {
          ...snapshot,
          space: { ...snapshot.space, role: "viewer" },
          conversations: [{ ...fixture.conversation, canWrite: false }],
        });
        await gateway.emitGatewayEvent("platformclaw.spaces.invalidated", {});
        const readonly = ui.locator("platformclaw-space-conversation-history");
        await readonly.getByText(copy.historyAnswer, { exact: true }).waitFor();
        expect((await gateway.waitForRequest(`${rpc}conversation.history`)).params).toMatchObject({
          spaceId: fixture.space.id,
          conversationId: fixture.conversation.id,
        });
        expect(await pane.count()).toBe(0);
        expect(await ui.locator("textarea").count()).toBe(0);
        expect(
          await ui
            .getByRole("button", {
              name: copy.locale === "ko-KR" ? "대화 이름 바꾸기" : "Rename conversation",
              exact: true,
            })
            .count(),
        ).toBe(0);
        expect(await gateway.getRequests("chat.startup")).toHaveLength(startupCount);
        expect(await gateway.getRequests("chat.send")).toHaveLength(2);
        await capture(page, `${copy.prefix}-lost-write-access`);
      } finally {
        await finish(context, page, name);
      }
    },
  );

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
        await ui
          .getByRole("tab")
          .filter({
            has: page.locator(`[data-conversation-id="${conversation.id}"]`),
          })
          .count(),
      ).toBe(0);
      expect(await ui.locator("openclaw-chat-pane").count()).toBe(0);
      expect(await ui.locator("textarea").count()).toBe(0);
      expect(
        await ui.getByRole("button", { name: "Rename conversation", exact: true }).count(),
      ).toBe(0);
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
