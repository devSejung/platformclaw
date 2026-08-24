import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPlatformClawSkillHubCommand } from "./command.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PlatformClaw SkillHub command", () => {
  it("registers for Knox and forwards the linked employee identity", async () => {
    await withTempDir("platformclaw-skillhub-command-", async (root) => {
      const tokenFile = path.join(root, "knox-token");
      await writeFile(tokenFile, "a".repeat(32));
      vi.stubEnv("PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE", tokenFile);
      vi.stubEnv(
        "PLATFORMCLAW_KNOX_CONTROL_PLANE_URL",
        "http://control.example/platformclaw/internal/knox/route",
      );
      const registerCommand = vi.fn();
      registerPlatformClawSkillHubCommand({
        registerCommand,
        logger: { warn: vi.fn() },
      } as never);
      const command = registerCommand.mock.calls[0]?.[0];
      const fetchMock = vi.fn(async () =>
        Response.json({ text: "## Downloadable skills\n\nNo downloadable skills on this page." }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        command.handler({ senderId: "person.one", accountId: "default", args: "list", config: {} }),
      ).resolves.toEqual({
        text: "## Downloadable skills\n\nNo downloadable skills on this page.",
      });
      expect(command).toMatchObject({ name: "skillhub", channels: ["knox"], requireAuth: true });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://control.example/platformclaw/internal/knox/skillhub",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ accountId: "person.one", args: "list" }),
        }),
      );
    });
  });
});
