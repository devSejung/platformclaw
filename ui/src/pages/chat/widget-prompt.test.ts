import { describe, expect, it, vi } from "vitest";
import type { ChatPageHost } from "./chat-state-host.ts";
import { admitWidgetPrompt } from "./widget-prompt.ts";

describe("widget prompt admission", () => {
  it("acknowledges queue ownership before network delivery completes", async () => {
    let admitted!: () => void;
    let finish!: () => void;
    const delivery = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handleSendChat = vi.fn((_text: string, options: unknown) => {
      admitted = (options as { onAdmitted: () => void }).onAdmitted;
      return delivery;
    });
    const state = { handleSendChat } as unknown as ChatPageHost;
    let settled = false;
    const result = admitWidgetPrompt(state, "Show selection").then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    admitted();
    expect(await result).toBe(true);
    expect(handleSendChat).toHaveBeenCalledWith(
      "Show selection",
      expect.objectContaining({ literalMessage: true, ignoreReplyTarget: true }),
    );
    finish();
  });

  it.each(["refused", "failed"])("rejects %s submissions without admission", async (kind) => {
    const state = {
      handleSendChat:
        kind === "failed"
          ? vi.fn().mockRejectedValue(new Error("storage unavailable"))
          : vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatPageHost;
    expect(await admitWidgetPrompt(state, "Keep this selection")).toBe(false);
  });
});
