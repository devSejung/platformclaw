import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getAgentMediaDir, withAgentMediaContext } from "../../media/agent-media-context.js";
import { resolveInboundMediaReference } from "../../media/media-reference.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const session = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadSessionEntry: session.load,
}));
vi.mock("../../infra/voicewake-routing.js", () => ({
  loadVoiceWakeRoutingConfig: async () => ({
    version: 1,
    defaultTarget: { mode: "current" },
    routes: [],
    updatedAtMs: 0,
  }),
  resolveVoiceWakeRouteByTrigger: () => ({ sessionKey: "agent:voice-owner:main" }),
}));
import { prepareAgentContentPhase } from "./agent-content-phase.js";
import type { RespondFn } from "./types.js";

describe("routed attachment ownership", () => {
  it("offloads an image under the effective voice-wake Agent and selects that Agent's catalog", async () => {
    await withOpenClawTestState({ prefix: "voice-routed-media-" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: {
            main: { default: true, model: "anthropic/claude-sonnet-4-6" },
            "voice-owner": { model: "anthropic/claude-sonnet-4-6" },
          },
        },
      };
      await state.writeConfig(cfg);
      session.load.mockImplementation((key: string) => ({
        cfg,
        canonicalKey: key,
        entry: undefined,
        storePath: path.join(state.sessionsDir(), "sessions.sqlite"),
      }));
      const loadGatewayModelCatalog = vi.fn(async () => [
        {
          id: "claude-sonnet-4-6",
          name: "Vision",
          provider: "anthropic",
          input: ["text", "image"] as ("text" | "image")[],
        },
      ]);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=",
        "base64",
      );
      // A valid PNG plus trailing bytes forces the real offload/storage boundary.
      const bytes = Buffer.concat([png, Buffer.alloc(2_000_000)]);
      const result = await prepareAgentContentPhase({
        request: {
          message: "Describe the image",
          voiceWakeTrigger: "voice",
          idempotencyKey: "voice-routed-attachment",
        },
        cfg,
        context: {
          logGateway: createSubsystemLogger("test.voice-routed-media"),
          loadGatewayModelCatalog,
        },
        respond: vi.fn<RespondFn>(),
        isRawModelRun: false,
        normalizedAttachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "voice.png",
            content: bytes.toString("base64"),
          },
        ],
        requestedSessionKeyRaw: "agent:main:main",
        requestedSessionKey: "agent:main:main",
        knownAgents: ["main", "voice-owner"],
      });
      expect(result).toMatchObject({
        agentId: "voice-owner",
        requestedSessionKey: "agent:voice-owner:main",
      });
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith({
        agentId: "voice-owner",
        readOnly: false,
      });
      expect(result?.media).toHaveLength(1);
      const media = result!.media[0]!;
      expect(
        media.path?.startsWith(path.join(getAgentMediaDir("voice-owner"), "inbound") + path.sep),
      ).toBe(true);
      expect(await fs.readFile(media.path!)).toEqual(bytes);
      await withAgentMediaContext("voice-owner", async () => {
        expect((await resolveInboundMediaReference(media.url!))?.physicalPath).toBe(
          await fs.realpath(media.path!),
        );
      });
      await withAgentMediaContext("main", async () => {
        await expect(resolveInboundMediaReference(media.url!)).rejects.toThrow();
      });
    });
  });
});
