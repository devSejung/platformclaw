import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getMediaDir } from "../media/store.js";
import { stageInboundMediaForSandbox } from "./inbound-media-staging.js";
import type { SandboxFsBridge, SandboxFsStat } from "./sandbox/fs-bridge.types.js";

type CreateFileExclusive = NonNullable<SandboxFsBridge["createFileExclusive"]>;

function createExclusiveMock(implementation: CreateFileExclusive = async () => "created") {
  return vi.fn<CreateFileExclusive>(implementation);
}

function createBridge(params?: {
  stat?: () => Promise<SandboxFsStat | null>;
  create?: CreateFileExclusive;
}) {
  return {
    resolvePath: ({ filePath }) => ({
      relativePath: filePath,
      containerPath: `/remote/workspace/${filePath}`,
    }),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    writeFile: vi.fn(async () => undefined),
    createFileExclusive: vi.fn<CreateFileExclusive>(params?.create ?? (async () => "created")),
    mkdirp: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    stat: vi.fn(params?.stat ?? (async () => null)),
  } satisfies SandboxFsBridge;
}

async function withWorkspace(fn: (workspaceDir: string) => Promise<void>): Promise<void> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-projection-"));
  try {
    await fn(workspaceDir);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

async function writeInbound(workspaceDir: string, relativePath: string, bytes: Buffer) {
  const absolutePath = path.join(workspaceDir, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes);
}

describe("stageInboundMediaForSandbox", () => {
  it("rejects a managed image or document whose local staging failed before any VM access", async () => {
    await withWorkspace(async (workspaceDir) => {
      const bridge = createBridge();
      for (const name of ["screenshot.png", "report.csv", "archive.zip"]) {
        await expect(
          stageInboundMediaForSandbox({
            sandbox: { workspaceDir, fsBridge: bridge },
            media: [{ path: path.join(getMediaDir(), "inbound", name) }],
          }),
        ).rejects.toThrow("Inbound attachment was not staged");
      }
      expect(bridge.stat).not.toHaveBeenCalled();
      expect(bridge.createFileExclusive).not.toHaveBeenCalled();
    });
  });

  it("preserves the managed PDF host fallback without publishing an unowned VM file", async () => {
    await withWorkspace(async (workspaceDir) => {
      const bridge = createBridge();
      const result = await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, fsBridge: bridge },
        media: [
          {
            path: path.join(getMediaDir(), "inbound", "large.pdf"),
            contentType: "application/pdf",
          },
        ],
      });
      expect(result.staged).toEqual([]);
      expect(bridge.stat).not.toHaveBeenCalled();
    });
  });

  it("fails closed when an enabled sandbox lacks a bridge for staged attachments", async () => {
    await withWorkspace(async (workspaceDir) => {
      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: undefined },
          media: [{ path: "media/inbound/input.png", workspaceDir }],
        }),
      ).rejects.toThrow("require a sandbox filesystem bridge");
    });
  });

  it("publishes exact binary bytes for Unicode and spaced inbound names across MIME types", async () => {
    await withWorkspace(async (workspaceDir) => {
      const relativePath =
        "media/inbound/openclaw-staged-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/측정 data.bin";
      const bytes = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x41, 0x00]);
      await writeInbound(workspaceDir, relativePath, bytes);
      const create = createExclusiveMock();
      const bridge = createBridge({ create });

      const result = await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, fsBridge: bridge },
        media: [{ path: relativePath, workspaceDir, contentType: "application/octet-stream" }],
      });

      expect(result).toEqual({
        staged: [{ index: 0, path: relativePath, status: "created" }],
        skipped: [],
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: relativePath, data: bytes, mkdir: true }),
      );
    });
  });

  it("keeps two uploads with the same original name isolated by their stored UUID paths", async () => {
    await withWorkspace(async (workspaceDir) => {
      const first = "media/inbound/photo---11111111-1111-4111-8111-111111111111.png";
      const second = "media/inbound/photo---22222222-2222-4222-8222-222222222222.png";
      await writeInbound(workspaceDir, first, Buffer.from("first"));
      await writeInbound(workspaceDir, second, Buffer.from("second"));
      const create = createExclusiveMock();
      const bridge = createBridge({ create });

      await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, fsBridge: bridge },
        media: [
          { path: first, workspaceDir, contentType: "image/png" },
          { path: second, workspaceDir, contentType: "image/png" },
        ],
      });

      expect(create.mock.calls.map(([call]) => call.filePath)).toEqual([first, second]);
      expect(create.mock.calls.map(([call]) => call.data.toString("utf8"))).toEqual([
        "first",
        "second",
      ]);
    });
  });

  it("reuses an existing regular target without reading or writing the Gateway source", async () => {
    await withWorkspace(async (workspaceDir) => {
      const relativePath = "media/inbound/report---33333333-3333-4333-8333-333333333333.pdf";
      const create = createExclusiveMock();
      const bridge = createBridge({
        create,
        stat: async () => ({ type: "file", size: 7, mtimeMs: 1 }),
      });

      const result = await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, fsBridge: bridge },
        media: [{ path: relativePath, workspaceDir, contentType: "application/pdf" }],
      });

      expect(result.staged).toEqual([{ index: 0, path: relativePath, status: "reused" }]);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("accepts an absolute staged fact only when it resolves inside its declared workspace", async () => {
    await withWorkspace(async (workspaceDir) => {
      const relativePath = "media/inbound/absolute---99999999-9999-4999-8999-999999999999.bin";
      const bytes = Buffer.from([9, 9, 0, 255]);
      await writeInbound(workspaceDir, relativePath, bytes);
      const create = createExclusiveMock();
      const bridge = createBridge({ create });

      await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, fsBridge: bridge },
        media: [
          {
            path: path.join(workspaceDir, ...relativePath.split("/")),
            workspaceDir,
            staged: true,
          },
        ],
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: relativePath, data: bytes, cwd: workspaceDir }),
      );
    });
  });

  it("binds a staged fact owned by the canonical agent workspace to that bridge mount", async () => {
    await withWorkspace(async (workspaceDir) => {
      const agentWorkspaceDir = path.join(workspaceDir, ".openclaw", "agent");
      await fs.mkdir(agentWorkspaceDir, { recursive: true });
      const relativePath = "media/inbound/agent---aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.bin";
      await writeInbound(agentWorkspaceDir, relativePath, Buffer.from("agent"));
      const create = createExclusiveMock();
      const bridge = createBridge({ create });

      await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, agentWorkspaceDir, fsBridge: bridge },
        media: [{ path: relativePath, workspaceDir: agentWorkspaceDir, staged: true }],
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: relativePath, cwd: agentWorkspaceDir }),
      );
    });
  });

  it.each(["directory", "other"] as const)(
    "rejects an existing %s instead of treating it as an idempotent media file",
    async (type) => {
      await withWorkspace(async (workspaceDir) => {
        const relativePath = "media/inbound/collision---44444444-4444-4444-8444-444444444444.bin";
        const create = createExclusiveMock();
        const bridge = createBridge({
          create,
          stat: async () => ({ type, size: 0, mtimeMs: 1 }),
        });

        await expect(
          stageInboundMediaForSandbox({
            sandbox: { workspaceDir, fsBridge: bridge },
            media: [{ path: relativePath, workspaceDir }],
          }),
        ).rejects.toThrow(/not a regular file/i);
        expect(create).not.toHaveBeenCalled();
      });
    },
  );

  it("rechecks a racing exclusive-create collision and preserves the winner", async () => {
    await withWorkspace(async (workspaceDir) => {
      const relativePath = "media/inbound/race---55555555-5555-4555-8555-555555555555.dat";
      const bytes = Buffer.from([5, 4, 3, 0, 2, 1]);
      await writeInbound(workspaceDir, relativePath, bytes);
      let statCalls = 0;
      const bridge = createBridge({
        create: createExclusiveMock(async () => "exists"),
        stat: async () =>
          statCalls++ === 0 ? null : { type: "file", size: bytes.length, mtimeMs: 1 },
      });

      const result = await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, fsBridge: bridge },
        media: [{ path: relativePath, workspaceDir }],
      });

      expect(result.staged).toEqual([{ index: 0, path: relativePath, status: "reused" }]);
      expect(bridge.createFileExclusive).toHaveBeenCalledWith(
        expect.objectContaining({ data: bytes }),
      );
    });
  });

  it("keeps failed publication retryable and does not rewrite a later existing file", async () => {
    await withWorkspace(async (workspaceDir) => {
      const relativePath = "media/inbound/retry---66666666-6666-4666-8666-666666666666.bin";
      await writeInbound(workspaceDir, relativePath, Buffer.from("gateway"));
      let remoteExists = false;
      const create = createExclusiveMock(async () => {
        if (!remoteExists) {
          remoteExists = true;
          throw new Error("remote transport failed after publication");
        }
        throw new Error("retry must not write an existing target");
      });
      const bridge = createBridge({
        create,
        stat: async () => (remoteExists ? { type: "file", size: 6, mtimeMs: 1 } : null),
      });

      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: relativePath, workspaceDir }],
        }),
      ).rejects.toThrow("remote transport failed after publication");
      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: relativePath, workspaceDir }],
        }),
      ).resolves.toMatchObject({
        staged: [{ path: relativePath, status: "reused" }],
      });
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  it("turns an abort after publication into a retry that reuses the published file", async () => {
    await withWorkspace(async (workspaceDir) => {
      const relativePath = "media/inbound/post-abort---bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.bin";
      await writeInbound(workspaceDir, relativePath, Buffer.from("payload"));
      const controller = new AbortController();
      let remoteExists = false;
      const create = createExclusiveMock(async () => {
        remoteExists = true;
        controller.abort(new DOMException("cancelled after publish", "AbortError"));
        return "created";
      });
      const bridge = createBridge({
        create,
        stat: async () => (remoteExists ? { type: "file", size: 7, mtimeMs: 1 } : null),
      });

      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: relativePath, workspaceDir, staged: true }],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: relativePath, workspaceDir, staged: true }],
        }),
      ).resolves.toMatchObject({
        staged: [{ path: relativePath, status: "reused" }],
      });
      expect(create).toHaveBeenCalledTimes(1);
    });
  });

  it("honors cancellation before remote filesystem side effects", async () => {
    await withWorkspace(async (workspaceDir) => {
      const controller = new AbortController();
      controller.abort(new DOMException("cancelled", "AbortError"));
      const bridge = createBridge();

      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [
            {
              path: "media/inbound/cancelled---77777777-7777-4777-8777-777777777777.bin",
              workspaceDir,
            },
          ],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(bridge.stat).not.toHaveBeenCalled();
      expect(bridge.createFileExclusive).not.toHaveBeenCalled();
    });
  });

  it("enforces the bounded host read before publishing", async () => {
    await withWorkspace(async (workspaceDir) => {
      const relativePath = "media/inbound/large---88888888-8888-4888-8888-888888888888.bin";
      await writeInbound(workspaceDir, relativePath, Buffer.alloc(5, 1));
      const bridge = createBridge();

      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: relativePath, workspaceDir }],
          maxBytes: 4,
        }),
      ).rejects.toThrow();
      expect(bridge.createFileExclusive).not.toHaveBeenCalled();
    });
  });

  it("skips facts that do not claim staged ownership and does not touch the bridge", async () => {
    await withWorkspace(async (workspaceDir) => {
      const bridge = createBridge();
      const result = await stageInboundMediaForSandbox({
        sandbox: { workspaceDir, fsBridge: bridge },
        media: [
          {},
          { path: "media/inbound/no-owner.bin" },
          { path: "/tmp/unrelated-host-file.bin" },
        ],
      });

      expect(result.staged).toEqual([]);
      expect(result.skipped.map((entry) => entry.reason)).toEqual([
        "missing-path",
        "missing-workspace-dir",
        "missing-workspace-dir",
      ]);
      expect(bridge.stat).not.toHaveBeenCalled();
      expect(bridge.createFileExclusive).not.toHaveBeenCalled();
    });
  });

  it("fails closed for malformed facts that claim staged workspace ownership", async () => {
    await withWorkspace(async (workspaceDir) => {
      const bridge = createBridge();

      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: "media/inbound/relative-owner.bin", workspaceDir: "relative/workspace" }],
        }),
      ).rejects.toThrow(/workspace must be absolute/i);
      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: "other/file.bin", workspaceDir }],
        }),
      ).rejects.toThrow(/not a managed media\/inbound path/i);
      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: "media/inbound/../escape.bin", workspaceDir }],
        }),
      ).rejects.toThrow(/not a managed media\/inbound path/i);
      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: path.join(workspaceDir, "outside.bin"), workspaceDir, staged: true }],
        }),
      ).rejects.toThrow(/not a managed media\/inbound path/i);
      await expect(
        stageInboundMediaForSandbox({
          sandbox: { workspaceDir, fsBridge: bridge },
          media: [{ path: "media/inbound/no-owner.bin", staged: true }],
        }),
      ).rejects.toThrow(/missing its owning workspace/i);
      expect(bridge.createFileExclusive).not.toHaveBeenCalled();
    });
  });

  it("rejects a staged source workspace outside the sandbox-owned roots", async () => {
    await withWorkspace(async (workspaceDir) => {
      const otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-other-workspace-"));
      try {
        const bridge = createBridge();
        await expect(
          stageInboundMediaForSandbox({
            sandbox: { workspaceDir, fsBridge: bridge },
            media: [
              {
                path: "media/inbound/not-owned.bin",
                workspaceDir: otherWorkspace,
                staged: true,
              },
            ],
          }),
        ).rejects.toThrow(/does not match an active sandbox workspace/i);
        expect(bridge.stat).not.toHaveBeenCalled();
        expect(bridge.createFileExclusive).not.toHaveBeenCalled();
      } finally {
        await fs.rm(otherWorkspace, { recursive: true, force: true });
      }
    });
  });

  it("is a no-op when there is no backend filesystem bridge", async () => {
    await withWorkspace(async (workspaceDir) => {
      await expect(
        stageInboundMediaForSandbox({
          sandbox: null,
          media: [{ path: "media/inbound/unprojected.bin", workspaceDir, staged: true }],
        }),
      ).resolves.toEqual({ staged: [], skipped: [] });
    });
  });
});
