import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { SandboxOutboundFileAccess } from "../../agents/sandbox/fs-bridge.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSandboxMediaList } from "./message-action-media-normalizer.js";
import {
  collectActionMediaSourceHints,
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaParams,
} from "./message-action-params.js";

describe("message runtime attachment normalization", () => {
  it("stages all aliases, lists, and structured send sources once before a second normalization", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-runtime-media-" },
      async () => {
        const source = "/home/synthetic/project/report.txt";
        const bytes = Buffer.from("runtime attachment bytes");
        const signal = new AbortController().signal;
        const readFile = vi.fn(async () => bytes);
        const fileAccess: SandboxOutboundFileAccess = {
          tempDir: "/tmp/synthetic-private",
          readFile,
        };
        const first = { path: source, url: source };
        const second = { file_url: source };
        const args: Record<string, unknown> = {
          media: source,
          media_url: source,
          path: source,
          file_path: source,
          fileUrl: source,
          image: source,
          avatar_path: source,
          media_urls: [source, source],
          attachments: [first, second],
        };
        const options = {
          args,
          mediaPolicy: { mode: "sandbox" as const, sandboxRoot: "/unrelated/gateway/workspace" },
          sandboxOutboundFileAccess: fileAccess,
          maxBytes: 4096,
          signal,
          extraParamKeys: ["avatarPath"],
          structuredAttachments: "all" as const,
        };
        await normalizeSandboxMediaParams(options);
        const staged = args.media;
        expect(staged).toBeTypeOf("string");
        expect(staged).not.toBe(source);
        await expect(fs.readFile(String(staged))).resolves.toEqual(bytes);
        for (const key of ["media_url", "path", "file_path", "fileUrl", "image", "avatar_path"]) {
          expect(args[key]).toBe(staged);
        }
        expect(args.media_urls).toEqual([staged, staged]);
        expect(first).toEqual({ path: staged, url: staged });
        expect(second).toEqual({ file_url: staged });
        await normalizeSandboxMediaParams(options);
        await expect(
          normalizeSandboxMediaList({
            values: collectActionMediaSourceHints(args, ["avatarPath"], {
              structuredAttachments: "all",
            }),
            sandboxRoot: "/unrelated/gateway/workspace",
            sandboxOutboundFileAccess: fileAccess,
            maxBytes: 4096,
            signal,
          }),
        ).resolves.toEqual([staged]);
        expect(readFile).toHaveBeenCalledExactlyOnceWith({
          filePath: source,
          maxBytes: 4096,
          signal,
        });
      },
    );
  });

  it("does not fall back to a matching Gateway file when the runtime refuses access", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-runtime-denied-" },
      async (state) => {
        const hostPath = state.path("host-only.txt");
        await fs.writeFile(hostPath, "HOST FILE MUST NOT BE EXPORTED");
        const readFile = vi.fn(async () => {
          throw new Error("runtime access denied");
        });
        const args = { media: hostPath };
        await expect(
          normalizeSandboxMediaParams({
            args,
            mediaPolicy: { mode: "host", mediaLocalRoots: [state.root] },
            sandboxOutboundFileAccess: { tempDir: "/tmp/synthetic-private", readFile },
            maxBytes: 4096,
          }),
        ).rejects.toThrow("runtime access denied");
        expect(args.media).toBe(hostPath);
        expect(readFile).toHaveBeenCalledOnce();
      },
    );
  });

  it("keeps dry-run references on the runtime without reading or staging bytes", async () => {
    const readFile = vi.fn(async () => Buffer.from("must not read"));
    await expect(
      normalizeSandboxMediaList({
        values: [
          "/tmp/synthetic-report.txt",
          "/tmp/synthetic-report.txt",
          "https://example.test/image.png",
        ],
        sandboxRoot: "/unrelated/gateway/workspace",
        sandboxOutboundFileAccess: { tempDir: "/tmp/synthetic-private", readFile },
        dryRun: true,
      }),
    ).resolves.toEqual(["/tmp/synthetic-report.txt", "https://example.test/image.png"]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("propagates cancellation after the runtime read without returning an attachment", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "message-runtime-abort-" },
      async () => {
        const controller = new AbortController();
        const readFile = vi.fn(async () => {
          controller.abort(new Error("synthetic export cancelled"));
          return Buffer.from("runtime bytes");
        });
        await expect(
          normalizeSandboxMediaList({
            values: ["/tmp/synthetic-report.txt"],
            sandboxOutboundFileAccess: { tempDir: "/tmp/synthetic-private", readFile },
            maxBytes: 4096,
            signal: controller.signal,
          }),
        ).rejects.toThrow("synthetic export cancelled");
        expect(readFile).toHaveBeenCalledOnce();
      },
    );
  });
  it("preserves Gateway-owned buffer bytes through runtime source and payload normalization", async () => {
    const bytes = Buffer.from("Gateway attachment bytes").toString("base64");
    const args: Record<string, unknown> = {
      buffer: bytes,
      filename: "report.txt",
      contentType: "text/plain",
    };
    const readFile = vi.fn(async () => {
      throw new Error("internal buffer marker is not a runtime file");
    });
    const mediaPolicy = { mode: "sandbox" as const, sandboxRoot: "/unrelated/gateway/workspace" };
    await hydrateAttachmentParamsForAction({
      cfg: {},
      channel: "workspace",
      action: "send",
      args,
      preserveSendBuffer: true,
      mediaPolicy,
    });
    const options = {
      args,
      mediaPolicy,
      sandboxOutboundFileAccess: { tempDir: "/tmp/private", readFile },
    };
    await normalizeSandboxMediaParams(options);
    expect(
      await normalizeSandboxMediaList({ ...options, values: collectActionMediaSourceHints(args) }),
    ).toEqual(["buffer://message-send/attachment"]);
    expect(args.buffer).toBe(bytes);
    expect(readFile).not.toHaveBeenCalled();
  });
});
