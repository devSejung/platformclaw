import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { terminalState: "error", preTerminalRead: false },
    { terminalState: "aborted", preTerminalRead: false },
    { terminalState: "error", preTerminalRead: true },
    { terminalState: "aborted", preTerminalRead: true },
  ] as const)(
    "waits for interrupted $terminalState history before an immediate retry without a session message (pre-terminal read: $preTerminalRead)",
    async ({ terminalState, preTerminalRead }) => {
      const context = await suite.newBrowserContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const sessionId = "control-ui-e2e-session";
      const gateway = await installMockGateway(page, {
        historyMessages: [],
        sessionInfo: { key: "main", sessionId, activeLeafEntryId: null },
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("first request");
        await page.getByRole("button", { name: "Send message" }).click();
        const first = requireRecord((await gateway.waitForRequest("chat.send")).params);
        const runId = requireString(first.idempotencyKey, "interrupted run");
        const previousReads = (await gateway.getRequests("chat.history")).length;
        if (preTerminalRead) {
          await gateway.deferNext("chat.history");
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: "main",
            phase: "message",
          });
          await waitForRequests(gateway, "chat.history", previousReads + 1);
        }
        await gateway.deferNext("chat.history");
        await gateway.emitGatewayEvent("chat", {
          sessionKey: "main",
          runId,
          state: terminalState,
          errorMessage: "The response service was interrupted.",
        });
        await waitForRequests(gateway, "chat.history", previousReads + (preTerminalRead ? 2 : 1));
        if (preTerminalRead) {
          await gateway.resolveDeferred("chat.history", {
            messages: [],
            sessionId,
            sessionInfo: { key: "main", sessionId, activeLeafEntryId: "stale-leaf" },
          });
        }
        await composer.fill("try again");
        await page.getByRole("button", { name: "Send message" }).click();
        await expectRequestCountStable(gateway, "chat.send", 1);

        await gateway.resolveDeferred("chat.history", {
          messages: [{ role: "user", content: [{ type: "text", text: "first request" }] }],
          sessionId,
          sessionInfo: { key: "main", sessionId, activeLeafEntryId: "interrupted-user" },
        });
        const requests = await waitForRequests(gateway, "chat.send", 2);
        expect(requireRecord(requests[1]?.params)).toMatchObject({
          message: "try again",
          expectedLeafEntryId: "interrupted-user",
          sessionId,
        });
        expect(
          await page
            .getByText("The thread switched branches — review and resend.", { exact: true })
            .count(),
        ).toBe(0);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("recovers a follow-up after the first response history read fails", async () => {
    const context = await suite.newBrowserContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const sessionId = "control-ui-e2e-session";
    const gateway = await installMockGateway(page, {
      historyMessages: [],
      sessionInfo: { key: "main", sessionId, activeLeafEntryId: null },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("first request");
      await page.getByRole("button", { name: "Send message" }).click();
      const first = requireRecord((await gateway.waitForRequest("chat.send")).params);
      expect(first.expectedLeafEntryId).toBeNull();
      const runId = requireString(first.idempotencyKey, "first run");
      const previousReads = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("chat.history");
      await gateway.emitGatewayEvent("session.message", {
        key: "main",
        sessionKey: "main",
        clientRunId: runId,
        hasActiveRun: false,
        session: {
          key: "main",
          kind: "direct",
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
        },
      });
      await gateway.emitChatFinal({ runId, text: "first response" });
      await waitForRequests(gateway, "chat.history", previousReads + 1);
      await gateway.rejectDeferred("chat.history", {
        code: "INVALID_REQUEST",
        message: "history temporarily unavailable",
      });
      await page
        .getByText(/history temporarily unavailable/)
        .first()
        .waitFor();

      await gateway.setMethodResponse("chat.history", {
        messages: [{ role: "assistant", content: [{ type: "text", text: "first response" }] }],
        sessionId,
        sessionInfo: { key: "main", sessionId, activeLeafEntryId: "first-response" },
      });
      await composer.fill("next request");
      await page.getByRole("button", { name: "Send message" }).click();
      const requests = await waitForRequests(gateway, "chat.send", 2);
      expect(requireRecord(requests[1]?.params)).toMatchObject({
        message: "next request",
        expectedLeafEntryId: "first-response",
        sessionId,
      });
      expect((await gateway.getRequests("chat.history")).length).toBeGreaterThan(previousReads + 1);
      expect(
        await page
          .getByText("The thread switched branches — review and resend.", { exact: true })
          .count(),
      ).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
