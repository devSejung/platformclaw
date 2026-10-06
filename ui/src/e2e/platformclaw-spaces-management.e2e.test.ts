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
  spaceFixture,
  suite,
} from "./platformclaw-spaces.e2e-helpers.ts";
suite("Space management browser workflows", () => {
  setupSpaceBrowserTests();
  it.each([
    {
      locale: "en-US",
      width: 1440,
      name: "rename-conversation-desktop",
      rename: "Rename conversation",
      title: "Title",
      cancel: "Cancel",
      save: "Save",
      shared: "Shared Q&A",
      renamed: "Revision C timing decision",
    },
    {
      locale: "ko-KR",
      width: 390,
      name: "rename-conversation-korean-narrow",
      rename: "대화 이름 바꾸기",
      title: "제목",
      cancel: "취소",
      save: "저장",
      shared: "기존 공동 Q&A",
      renamed: "C형 보드 타이밍 검토 결과",
    },
  ])("renames an owned conversation safely in $locale at $width px", async (copy) => {
    const fixture = spaceFixture(copy.locale);
    const { context, page, gateway, snapshot, name } = await setup(
      copy.name,
      copy.width,
      "owner",
      copy.locale,
      [fixture.conversation],
      { revision: 7 },
    );
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}&conversation=${conversation.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      const rename = ui.getByRole("button", { name: copy.rename, exact: true });
      const modal = ui.locator("openclaw-modal-dialog");
      const tab = ui.getByRole("tab").filter({
        has: page.locator(`[data-conversation-id="${conversation.id}"]`),
      });
      await rename.click();
      await modal.getByRole("dialog", { name: copy.rename, exact: true }).waitFor();
      const title = modal.getByLabel(copy.title, { exact: true });
      expect(await title.inputValue()).toBe(fixture.conversation.title);
      await title.fill("   ");
      await modal.getByRole("button", { name: copy.save, exact: true }).click();
      expect(await gateway.getRequests(`${rpc}conversation.rename`)).toHaveLength(0);
      await title.fill(copy.renamed);
      await modal.getByRole("button", { name: copy.cancel, exact: true }).click();
      await modal.waitFor({ state: "detached" });
      expect(await tab.textContent()).toContain(fixture.conversation.title);
      await rename.click();
      await title.fill(copy.renamed);
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      expect(await gateway.getRequests(`${rpc}conversation.rename`)).toHaveLength(0);

      await rename.click();
      await title.fill(`  ${copy.renamed}  `);
      await capture(page, `${name}-confirmation`);
      await gateway.deferNext(`${rpc}conversation.rename`);
      await modal.getByRole("button", { name: copy.save, exact: true }).click();
      expect((await gateway.waitForRequest(`${rpc}conversation.rename`)).params).toEqual({
        spaceId: space.id,
        conversationId: conversation.id,
        title: copy.renamed,
        expectedRevision: 7,
        expectedTitle: fixture.conversation.title,
      });
      expect(await modal.getByRole("button", { name: copy.save, exact: true }).isDisabled()).toBe(
        true,
      );
      expect(await modal.getByRole("button", { name: copy.cancel, exact: true }).isDisabled()).toBe(
        true,
      );
      await modal.locator("form").dispatchEvent("submit");
      await page.keyboard.press("Escape");
      expect(await modal.getByRole("dialog", { name: copy.rename, exact: true }).isVisible()).toBe(
        true,
      );
      expect(await gateway.getRequests(`${rpc}conversation.rename`)).toHaveLength(1);
      await gateway.rejectDeferred(`${rpc}conversation.rename`, {
        code: "UNAVAILABLE",
        message: "Synthetic rename service interruption",
      });
      await expect
        .poll(() => modal.getByRole("alert").textContent())
        .toContain("Synthetic rename service interruption");
      expect(await title.inputValue()).toBe(copy.renamed);
      expect(
        await ui.locator(`[data-conversation-id="${conversation.id}"]`).textContent(),
      ).toContain(fixture.conversation.title);
      await capture(page, `${name}-retryable-error`);

      const renamed = { ...fixture.conversation, title: copy.renamed };
      await gateway.setMethodResponse(`${rpc}conversation.rename`, renamed);
      await gateway.setMethodResponse(`${rpc}get`, {
        ...snapshot,
        conversations: [renamed],
      });
      await modal.getByRole("button", { name: copy.save, exact: true }).click();
      await modal.waitFor({ state: "detached" });
      await expect.poll(() => tab.textContent()).toContain(copy.renamed);
      expect(await tab.getAttribute("aria-selected")).toBe("true");
      expect((await gateway.getRequests(`${rpc}conversation.rename`)).at(-1)?.params).toMatchObject(
        {
          title: copy.renamed,
          expectedRevision: 7,
          expectedTitle: fixture.conversation.title,
        },
      );
      expect(new URL(page.url()).searchParams.get("conversation")).toBe(conversation.id);
      expect(await ui.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(false);
      await capture(page, `${name}-renamed`);
      await ui.getByRole("tab", { name: copy.shared, exact: true }).click();
      expect(await rename.count()).toBe(0);
      expect(await gateway.getRequests(`${rpc}conversation.rename`)).toHaveLength(2);
    } finally {
      await finish(context, page, name);
    }
  });

  it.each([
    { role: "owner", action: "delete", label: "Delete Space" },
    { role: "editor", action: "leave", label: "Leave Space" },
    { role: "viewer", action: "leave", label: "Leave Space" },
  ])("confirms $action as $role and clears content, search and deep links", async (copy) => {
    const { context, page, gateway, name } = await setup(
      `${copy.role}-${copy.action}-space`,
      1440,
      copy.role,
      "en-US",
      [],
      { revision: 11 },
    );
    const method = `${rpc}${copy.action}`;
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}&conversation=shared&message=message-a`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      await ui.locator("#message-message-a").waitFor();
      await ui
        .getByRole("searchbox", { name: "Search shared issues", exact: true })
        .fill("board revision");
      await ui.getByRole("button", { name: "Search shared issues", exact: true }).click();
      await ui.getByRole("region", { name: "Search results", exact: true }).waitFor();
      await ui.getByRole("button", { name: "Members and access", exact: true }).click();
      if (copy.role !== "owner") {
        expect(await ui.getByRole("button", { name: "Delete Space", exact: true }).count()).toBe(0);
      }
      const action = ui.getByRole("button", { name: copy.label, exact: true });
      const modal = ui.locator("openclaw-modal-dialog");
      await action.click();
      await modal.getByRole("dialog", { name: copy.label, exact: true }).waitFor();
      expect(await modal.textContent()).toContain(space.name);
      const warning = await modal.textContent();
      expect(warning).toMatch(/access|lose/iu);
      expect(warning).toMatch(/conversation/iu);
      if (copy.action === "delete") {
        expect(warning).toMatch(/pages/iu);
        expect(warning).toMatch(/all members/iu);
        expect(warning).toMatch(/search/iu);
        expect(warning).toMatch(/cannot be undone|irreversible/iu);
        await modal
          .getByLabel("Space name to confirm deletion", { exact: true })
          .fill("Wrong Space");
        await modal.getByRole("button", { name: copy.label, exact: true }).click();
        expect(await gateway.getRequests(method)).toHaveLength(0);
      } else {
        expect(warning).toMatch(/shared questions and answers/iu);
        expect(warning).toMatch(/remain|retain/iu);
      }
      await capture(page, `${name}-confirmation`);
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await modal.waitFor({ state: "detached" });
      await action.click();
      await modal.getByRole("dialog", { name: copy.label, exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await modal.waitFor({ state: "detached" });
      expect(await gateway.getRequests(method)).toHaveLength(0);
      expect(await ui.locator("#message-message-a").isVisible()).toBe(true);

      await action.click();
      if (copy.action === "delete") {
        await modal.getByLabel("Space name to confirm deletion", { exact: true }).fill(space.name);
      }
      await gateway.deferNext(method);
      await modal.getByRole("button", { name: copy.label, exact: true }).click();
      expect((await gateway.waitForRequest(method)).params).toEqual({
        spaceId: space.id,
        expectedRevision: 11,
        ...(copy.action === "delete" ? { confirmName: space.name } : {}),
      });
      expect(await modal.getByRole("button", { name: copy.label, exact: true }).isDisabled()).toBe(
        true,
      );
      expect(await modal.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(
        true,
      );
      await modal.locator("form").dispatchEvent("submit");
      await page.keyboard.press("Escape");
      await gateway.setMethodResponse(`${rpc}list`, []);
      await gateway.emitGatewayEvent("platformclaw.spaces.invalidated", {});
      expect(await modal.getByRole("dialog", { name: copy.label, exact: true }).isVisible()).toBe(
        true,
      );
      expect(await gateway.getRequests(method)).toHaveLength(1);
      await gateway.resolveDeferred(
        method,
        copy.action === "delete" ? { deleted: true } : { left: true },
      );
      await modal.waitFor({ state: "detached" });
      await expect.poll(() => ui.locator(".pc-space-group").count()).toBe(0);
      expect(await ui.getByRole("region", { name: "Search results", exact: true }).count()).toBe(0);
      expect(await ui.locator("#message-message-a").count()).toBe(0);
      expect(await ui.locator("openclaw-chat-pane").count()).toBe(0);
      expect(await ui.textContent()).not.toContain(issue.body);
      expect(await ui.textContent()).not.toContain(messages[0].text);
      for (const key of ["space", "page", "conversation", "message"]) {
        expect(new URL(page.url()).searchParams.has(key), key).toBe(false);
      }
      expect(await gateway.getRequests(method)).toHaveLength(1);
      await capture(page, `${name}-removed`);
    } finally {
      await finish(context, page, name);
    }
  });

  it("keeps the last owner in the Space when leaving is rejected", async () => {
    const { context, page, gateway, name } = await setup("last-owner-leave-rejected");
    try {
      await page.goto(
        `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}`,
      );
      const ui = page.locator("platformclaw-spaces-page");
      await ui.locator("#message-message-a").waitFor();
      await gateway.setMethodResponse(`${rpc}leave`, {
        __mockError: {
          code: "CONFLICT",
          message: "Assign another owner before leaving this Space.",
        },
      });
      await ui.getByRole("button", { name: "Members and access", exact: true }).click();
      await ui.getByRole("button", { name: "Leave Space", exact: true }).click();
      const modal = ui.locator("openclaw-modal-dialog");
      await modal.getByRole("dialog", { name: "Leave Space", exact: true }).waitFor();
      expect(await modal.textContent()).toMatch(/last owner/iu);
      await modal.getByRole("button", { name: "Leave Space", exact: true }).click();
      await expect
        .poll(() => modal.getByRole("alert").textContent())
        .toContain("Assign another owner");
      expect(await ui.locator(".pc-space-group").count()).toBe(1);
      expect(new URL(page.url()).searchParams.get("space")).toBe(space.id);
      expect(await gateway.getRequests(`${rpc}leave`)).toHaveLength(1);
      await capture(page, "last-owner-leave-error");
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await modal.waitFor({ state: "detached" });
      expect(await ui.locator("#message-message-a").isVisible()).toBe(true);
    } finally {
      await finish(context, page, name);
    }
  });

  it.each([
    {
      action: "delete",
      label: "Delete Space",
      retry: "Retry deletion",
      state: { deleting: true },
    },
    {
      action: "leave",
      label: "Leave Space",
      retry: "Retry leaving",
      state: { leaving: true },
    },
  ] as const)(
    "retries interrupted $action cleanup without opening inaccessible content",
    async (copy) => {
      const { context, page, gateway, name } = await setup(
        `pending-space-${copy.action}-retry`,
        1440,
        copy.action === "delete" ? "owner" : "editor",
        "en-US",
        [],
        { revision: 17, ...copy.state },
      );
      const method = `${rpc}${copy.action}`;
      try {
        await page.goto(
          `${server.baseUrl}platformclaw/app/spaces?space=${space.id}&page=${issue.id}&conversation=${conversation.id}&message=message-a`,
        );
        const ui = page.locator("platformclaw-spaces-page");
        const retry = ui.getByRole("button", { name: copy.retry, exact: true });
        await retry.waitFor();
        expect(await ui.locator(".pc-space-group-title").count()).toBe(0);
        expect(await gateway.getRequests(`${rpc}get`)).toHaveLength(0);
        expect(await ui.locator("openclaw-chat-pane").count()).toBe(0);
        expect(await ui.textContent()).not.toContain(messages[0].text);
        await retry.click();
        const modal = ui.locator("openclaw-modal-dialog");
        await modal.getByRole("dialog", { name: copy.label, exact: true }).waitFor();
        if (copy.action === "delete") {
          await modal
            .getByLabel("Space name to confirm deletion", { exact: true })
            .fill(space.name);
        }
        await gateway.deferNext(method);
        await modal.getByRole("button", { name: copy.label, exact: true }).click();
        expect((await gateway.waitForRequest(method)).params).toEqual({
          spaceId: space.id,
          expectedRevision: 17,
          ...(copy.action === "delete" ? { confirmName: space.name } : {}),
        });
        await gateway.rejectDeferred(method, {
          code: "UNAVAILABLE",
          message: "Synthetic cleanup interruption; retry the operation.",
        });
        await expect
          .poll(() => modal.getByRole("alert").textContent())
          .toContain("Synthetic cleanup interruption");
        if (copy.action === "delete") {
          expect(
            await modal.getByLabel("Space name to confirm deletion", { exact: true }).inputValue(),
          ).toBe(space.name);
        }
        await capture(page, `${name}-failure`);
        await gateway.setMethodResponse(
          method,
          copy.action === "delete" ? { deleted: true } : { left: true },
        );
        await gateway.setMethodResponse(`${rpc}list`, []);
        await modal.getByRole("button", { name: copy.label, exact: true }).click();
        await modal.waitFor({ state: "detached" });
        await expect.poll(() => retry.count()).toBe(0);
        expect(await gateway.getRequests(method)).toHaveLength(2);
        expect(await gateway.getRequests(`${rpc}get`)).toHaveLength(0);
        expect(new URL(page.url()).searchParams.has("space")).toBe(false);
      } finally {
        await finish(context, page, name);
      }
    },
  );
});
