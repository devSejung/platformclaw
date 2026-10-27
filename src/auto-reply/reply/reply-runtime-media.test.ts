import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import { getAgentMediaDir, withAgentMediaContext } from "../../media/agent-media-context.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createReplyMediaContext, createReplyMediaPathNormalizer } from "./reply-media-paths.js";

describe("runtime reply attachment staging", () => {
  let home: TempHomeEnv;
  let workspace: string;
  beforeEach(async () => {
    home = await createTempHomeEnv("runtime-reply-media-");
    workspace = path.join(home.home, "workspace");
    await fs.mkdir(workspace, { recursive: true });
  });
  afterEach(async () => {
    await home.restore();
  });

  function options() {
    return {
      cfg: { agents: { list: [{ id: "alice", workspace }] } },
      agentId: "alice",
      sessionKey: "agent:alice:main",
      workspaceDir: workspace,
      ownerScoped: true,
    };
  }

  it("materializes MEDIA from the prepared runtime instead of an identical Gateway path", async () => {
    const source = path.join(workspace, "report.txt");
    await fs.writeFile(source, "Gateway bytes must not win");
    const bytes = Buffer.from("VM bytes\n");
    const readFile = vi.fn(async () => bytes);
    const normalize = createReplyMediaPathNormalizer({
      ...options(),
      runtimeSandbox: { outboundFileAccess: { tempDir: "/tmp/private-alice", readFile } },
    });
    const { replyPayloads } = await buildReplyPayloads({
      config: options().cfg,
      payloads: [{ text: `Report\nMEDIA:${source}` }],
      isHeartbeat: false,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      replyToMode: "off",
      normalizeMediaPaths: normalize,
    });
    expect(readFile).toHaveBeenCalledWith({
      filePath: source,
      maxBytes: 5 * 1024 * 1024,
      signal: undefined,
    });
    const payload = replyPayloads[0];
    expect(payload?.mediaUrl).toBeTruthy();
    expect(await fs.readFile(payload!.mediaUrl!)).toEqual(bytes);
    expect(getReplyPayloadMetadata(payload!)?.stagedLocalMediaUrls).toEqual([payload!.mediaUrl]);
    expect(path.dirname(payload!.mediaUrl!)).toBe(path.join(getAgentMediaDir("alice"), "outbound"));
  });

  it("resets source caching between prepared attempts and preserves completed copies", async () => {
    const context = createReplyMediaContext(options());
    const sandbox = (value: string): Pick<SandboxContext, "outboundFileAccess"> => ({
      outboundFileAccess: {
        tempDir: "/tmp/private-alice",
        readFile: async () => Buffer.from(value),
      },
    });
    context.setSandbox!(sandbox("Basic copy"));
    const first = await context.normalizePayload({ mediaUrl: "report.txt" });
    context.setSandbox!(sandbox("VM copy"));
    const second = await context.normalizePayload({ mediaUrl: "report.txt" });
    expect(first.mediaUrl).not.toBe(second.mediaUrl);
    expect(await fs.readFile(first.mediaUrl!, "utf8")).toBe("Basic copy");
    expect(await fs.readFile(second.mediaUrl!, "utf8")).toBe("VM copy");
    expect((await context.normalizePayload(first)).mediaUrl).toBe(first.mediaUrl);
  });

  it("does not fall back to Gateway files when runtime reading fails", async () => {
    const source = path.join(workspace, "report.txt");
    await fs.writeFile(source, "Gateway file exists");
    const normalize = createReplyMediaPathNormalizer({
      ...options(),
      runtimeSandbox: {
        outboundFileAccess: {
          tempDir: "/tmp/private-alice",
          readFile: async () => {
            throw new Error("runtime disconnected");
          },
        },
      },
    });
    const result = await normalize({ text: "Report", mediaUrl: source });
    expect(result.mediaUrl).toBeUndefined();
    expect(result.text).toContain("⚠️ Media failed.");
    expect(getReplyPayloadMetadata(result)?.stagedLocalMediaUrls).toBeUndefined();
  });

  it("removes only its newly staged copy if authority changes before publication", async () => {
    let checks = 0;
    const normalize = createReplyMediaPathNormalizer({
      ...options(),
      runtimeSandbox: {
        outboundFileAccess: {
          tempDir: "/tmp/private-alice",
          readFile: async () => Buffer.from("private result"),
          assertCurrentAuthority: async () => {
            if (++checks === 2) {
              throw new Error("allocation revoked");
            }
          },
        },
      },
    });
    const result = await normalize({ mediaUrl: "/tmp/result.txt" });
    expect(result.mediaUrl).toBeUndefined();
    const stored = await withAgentMediaContext("alice", () =>
      fs.readdir(path.join(getAgentMediaDir(), "outbound")),
    );
    expect(stored).toEqual([]);
  });
  it("removes a copy when cancellation arrives during the final authority check", async () => {
    const controller = new AbortController();
    let checks = 0;
    const normalize = createReplyMediaPathNormalizer({
      ...options(),
      abortSignal: controller.signal,
      runtimeSandbox: {
        outboundFileAccess: {
          tempDir: "/tmp/private-alice",
          readFile: async () => Buffer.from("cancelled copy"),
          assertCurrentAuthority: async () => {
            if (++checks === 2) {
              await Promise.resolve();
              controller.abort(new Error("cancelled while checking"));
            }
          },
        },
      },
    });
    const result = await normalize({ mediaUrl: "/tmp/cancelled.txt" });
    expect(result.mediaUrl).toBeUndefined();
    expect(await fs.readdir(path.join(getAgentMediaDir("alice"), "outbound"))).toEqual([]);
  });

  it("cancels publication even after the runtime copy has completed", async () => {
    const controller = new AbortController();
    const normalize = createReplyMediaPathNormalizer({
      ...options(),
      abortSignal: controller.signal,
      runtimeSandbox: {
        outboundFileAccess: {
          tempDir: "/tmp/private-alice",
          readFile: async () => Buffer.from("completed copy"),
        },
      },
    });
    const result = await normalize({ mediaUrl: "/tmp/completed.txt" });
    expect(result.mediaUrl).toBeTruthy();
    const authority = getReplyPayloadMetadata(result)?.mediaPublishAuthority;
    expect(authority).toBeTypeOf("function");
    controller.abort(new Error("cancelled before publication"));
    await expect(authority!()).rejects.toThrow("cancelled before publication");
  });
});
