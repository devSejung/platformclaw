import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([
    { key: "Enter", isComposing: true, keyCode: 0 },
    { key: "Escape", isComposing: true, keyCode: 0 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ])(
    "keeps rename drafts for composition $key (isComposing=$isComposing, keyCode=$keyCode)",
    async (composition) => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      });
      try {
        const page = await context.newPage();
        const original = sessionRow("agent:main:rename-composition", "Original session", 1);
        const gateway = await installMockGateway(page, {
          sessionKey: original.key,
          methodResponses: {
            "sessions.list": sessionsListResponse([original]),
            "sessions.patch": {},
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, original.key));
        const title = page.locator(".chat-pane__session-title-button");
        await expect.poll(() => title.textContent()).toContain(original.label);
        await title.click();
        const input = page.locator(".chat-pane__session-title-input");
        await input.fill("조합 중인 이름");

        // Exercise browser event semantics; this does not open a native OS IME window.
        const prevented = await input.evaluate((element, args) => {
          const event = new KeyboardEvent("keydown", {
            ...args,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        }, composition);
        expect(prevented).toBe(false);
        expect(await input.count()).toBe(1);
        expect(await input.inputValue()).toBe("조합 중인 이름");
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);

        const finalTitle = "확정한 이름";
        await input.fill(finalTitle);
        if (composition.key === "Enter") {
          await gateway.setMethodResponse(
            "sessions.list",
            sessionsListResponse([{ ...original, label: finalTitle, displayName: finalTitle }]),
          );
          await input.press("Enter");
          const patch = await waitForPatch(gateway, (params) => params.label === finalTitle);
          expect(requireRecord(patch.params)).toMatchObject({
            key: original.key,
            agentId: "main",
            label: finalTitle,
          });
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
          await expect.poll(() => title.textContent()).toContain(finalTitle);
        } else {
          await input.press("Escape");
          await input.waitFor({ state: "detached" });
          expect(await gateway.getRequests("sessions.patch")).toEqual([]);
          await expect.poll(() => title.textContent()).toContain(original.label);
        }
      } finally {
        await context.close();
      }
    },
  );
});
