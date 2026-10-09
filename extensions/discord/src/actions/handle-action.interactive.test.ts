import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");
const cfg: OpenClawConfig = { channels: { discord: { token: "tok" } } };

describe("handleDiscordMessageAction interactive precedence", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("normalizes legacy interactive input at the action boundary", async () => {
    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: " Inspect ",
                  action: { type: "callback", value: "plugin:opaque|value" },
                  value: "legacy-fallback",
                },
              ],
            },
          ],
        },
      },
      cfg,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    expect(handleDiscordActionMock.mock.calls[0]?.[0]).toMatchObject({
      action: "sendMessage",
      content: "",
      components: {
        blocks: [
          {
            type: "actions",
            buttons: [
              {
                label: "Inspect",
                callbackData: "plugin:opaque|value",
                callbackDataKind: "callback",
              },
            ],
          },
        ],
      },
    });
  });

  it.each([
    {
      name: "native components",
      components: { blocks: [{ type: "text", text: "Native" }] },
      presentation: undefined,
      expectedText: "Native",
    },
    {
      name: "presentation components",
      components: undefined,
      presentation: { blocks: [{ type: "text", text: "Portable" }] },
      expectedText: "Portable",
    },
  ])("keeps $name ahead of legacy input without reading it", async (entry) => {
    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        components: entry.components,
        presentation: entry.presentation,
        get interactive(): never {
          throw new Error("unexpected legacy input read");
        },
      },
      cfg,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    expect(handleDiscordActionMock.mock.calls[0]?.[0]).toMatchObject({
      components: { blocks: [{ type: "text", text: entry.expectedText }] },
    });
  });
});
