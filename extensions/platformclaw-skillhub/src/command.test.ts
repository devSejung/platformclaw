import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatformClawSkillHubClient, type PlatformClawSkillHubClient } from "./client.js";
import { registerPlatformClawSkillHubCommand } from "./command.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PlatformClaw SkillHub command", () => {
  function fixture() {
    const registerCommand = vi.fn();
    const request = vi.fn<PlatformClawSkillHubClient["request"]>(async () => ({
      status: 200,
      body: { text: "Reply" },
    }));
    registerPlatformClawSkillHubCommand({ registerCommand, logger: { warn: vi.fn() } } as never, {
      request,
    });
    const command = registerCommand.mock.calls[0]![0];
    const context = {
      agentId: "agent-1",
      sessionKey: "agent:agent-1:main",
      from: "dm:42",
      to: "dm:42",
      senderId: "person.one",
      accountId: "default",
      args: "list",
      config: {},
    };
    return { command, request, context };
  }

  it.each([
    ["list", "list", "ko"],
    ["--lang=en list 2", "list 2", "en"],
    ["--lang=ko delete demo-skill --confirm", "delete demo-skill --confirm", "ko"],
    ["--lang=en", "", "en"],
    ["list --lang=en", "list --lang=en", "ko"],
    ["install --lang=en", "install --lang=en", "ko"],
  ])("forwards %s without rewriting command arguments", async (args, forwarded, locale) => {
    const f = fixture();
    await expect(f.command.handler({ ...f.context, args })).resolves.toEqual({ text: "Reply" });
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ args: forwarded, locale }),
    );
  });

  it.each([
    "--lang=fr list",
    "--lang= list",
    "--lang en list",
    "--lang=en --lang=ko delete demo --confirm",
  ])("rejects invalid language selection %s without an HTTP effect", async (args) => {
    const f = fixture();
    expect(await f.command.handler({ ...f.context, args })).toMatchObject({
      isError: true,
      text: expect.stringContaining("--lang=en or --lang=ko"),
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["en", "ko"] as const)(
    "uses %s for context, account, connection and response failures",
    async (locale) => {
      const f = fixture();
      const context = { ...f.context, args: `--lang=${locale} list` };
      expect((await f.command.handler({ ...context, to: "unknown" })).text).toContain(
        locale === "en" ? "conversation could not be verified" : "대화방 정보를 확인할 수 없습니다",
      );
      expect((await f.command.handler({ ...context, senderId: undefined })).text).toContain(
        locale === "en"
          ? "employee account could not be verified"
          : "직원 계정을 확인할 수 없습니다",
      );
      expect(f.request).not.toHaveBeenCalled();
      f.request.mockRejectedValueOnce(new Error("Synthetic connection loss"));
      expect((await f.command.handler(context)).text).toContain(
        locale === "en" ? "Check the current outcome" : "현재 처리 결과를 확인",
      );
      f.request.mockResolvedValueOnce({ status: 200, body: {} });
      expect((await f.command.handler(context)).text).toContain(
        locale === "en" ? "response could not be verified" : "응답을 확인할 수 없습니다",
      );
    },
  );

  it("uses the same configured service credential and origin for room skill checks", async () => {
    await withTempDir("platformclaw-skillhub-policy-", async (root) => {
      const tokenFile = path.join(root, "knox-token");
      await writeFile(tokenFile, "a".repeat(32));
      vi.stubEnv("PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE", tokenFile);
      vi.stubEnv(
        "PLATFORMCLAW_KNOX_CONTROL_PLANE_URL",
        "http://control.example/platformclaw/internal/knox/route",
      );
      const fetchMock = vi.fn(async () => Response.json({ excludedPaths: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const request = {
        agentId: "group-room",
        candidates: [{ name: "sheet", filePath: "/workspace/skills/sheet/SKILL.md" }],
      };
      await createPlatformClawSkillHubClient().roomSkills(request);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://control.example/platformclaw/api/internal/skill-hub/room-skills",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: `Bearer ${"a".repeat(32)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        }),
      );
    });
  });
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
        command.handler({
          agentId: "agent-1",
          sessionKey: "agent:agent-1:main",
          from: "dm:42",
          to: "dm:42",
          senderId: "person.one",
          accountId: "default",
          args: "list",
          config: {},
        }),
      ).resolves.toEqual({
        text: "## Downloadable skills\n\nNo downloadable skills on this page.",
      });
      expect(command).toMatchObject({ name: "skillhub", channels: ["knox"], requireAuth: true });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://control.example/platformclaw/internal/knox/skillhub",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            accountId: "person.one",
            args: "list",
            locale: "ko",
            context: {
              accountId: "default",
              conversationType: "dm",
              conversationId: "42",
              agentId: "agent-1",
              sessionKey: "agent:agent-1:main",
            },
          }),
        }),
      );
    });
  });
});
