import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_MAX_BYTES } from "../../media/store.js";
import type { ImageDescriptionRequest } from "../../plugin-sdk/media-understanding.js";
import { stageInboundMediaForSandbox } from "../inbound-media-staging.js";
import { createRemoteShellSandboxFsBridge } from "../sandbox/remote-fs-bridge.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";

// Exercise the production remote shell/Python transport with isolated filesystem
// roots. No SSH server, live credentials, or external model is used by this test.
describe.skipIf(process.platform !== "linux")("remote inbound image tool integration", () => {
  let root: string;
  let gatewayRoot: string;
  let remoteRoot: string;
  let createImageTool: (typeof import("./image-tool.js"))["createImageTool"];
  let testing: (typeof import("./image-tool.test-support.js"))["testing"];
  const describeImage = vi.fn(async (request: ImageDescriptionRequest) => ({
    text: "Image received by the separate vision provider.",
    model: request.model,
  }));
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
    "base64",
  );
  const imagePath = "media/inbound/screenshot---8cf1ae66-3663-48b4-8793-d1ca09b92d46.png";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-remote-image-"));
    gatewayRoot = path.join(root, "gateway");
    remoteRoot = path.join(root, "remote");
    await fs.mkdir(path.join(gatewayRoot, "media", "inbound"), { recursive: true });
    await fs.mkdir(remoteRoot);
    await fs.writeFile(path.join(gatewayRoot, imagePath), imageBytes);
    ({ createImageTool } = await import("./image-tool.js"));
    ({ testing } = await import("./image-tool.test-support.js"));
    describeImage.mockClear();
    testing.setProviderDepsForTest({
      buildProviderRegistry: () => new Map(),
      getMediaUnderstandingProvider: () => undefined,
      describeImageWithModel: describeImage,
      resolveImageCompressionPolicy: async () => ({}),
      loadImageWebMediaRuntime: async () => ({
        // Codec/compression is a separate boundary; retain the real image tool's
        // path resolver and bridge read adapter instead of faking image bytes.
        loadWebMedia: async (filePath, options) => {
          if (!options?.readFile || !options.sandboxValidated) {
            throw new Error("Expected a sandbox-validated remote read");
          }
          return {
            buffer: await options.readFile(filePath),
            kind: "image",
            contentType: "image/png",
          };
        },
        optimizeImageBufferForWebMedia: async ({ buffer }) => ({
          buffer,
          kind: "image",
          contentType: "image/png",
        }),
      }),
    });
  });

  afterEach(async () => {
    testing?.setProviderDepsForTest(undefined);
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function createRemoteSandbox(workspace = remoteRoot) {
    const sandbox = createSandboxTestContext({
      overrides: {
        backendId: "ssh",
        workspaceDir: gatewayRoot,
        agentWorkspaceDir: gatewayRoot,
        containerWorkdir: workspace,
      },
    });
    sandbox.fsBridge = createRemoteShellSandboxFsBridge({
      sandbox,
      runtime: {
        remoteWorkspaceDir: workspace,
        remoteAgentWorkspaceDir: workspace,
        runRemoteShellScript: async (command) => {
          command.signal?.throwIfAborted();
          const result = spawnSync(
            "sh",
            ["-c", command.script, "inbound-image-test", ...(command.args ?? [])],
            {
              input: command.stdin,
              encoding: "buffer",
              timeout: 5_000,
              maxBuffer: 12 * 1024 * 1024,
            },
          );
          if (result.error) {
            throw result.error;
          }
          const code = result.status ?? 1;
          if (code !== 0 && !command.allowFailure) {
            throw new Error(result.stderr.toString("utf8") || `Remote shell exited ${code}`);
          }
          return { stdout: result.stdout, stderr: result.stderr, code };
        },
      },
    });
    return sandbox;
  }

  function imageTool(sandbox: ReturnType<typeof createRemoteSandbox>) {
    const tool = createImageTool({
      agentDir: path.join(root, "agent"),
      workspaceDir: gatewayRoot,
      config: {
        agents: {
          defaults: {
            model: { primary: "attachment-test/text-only" },
            imageModel: { primary: "attachment-test/vision" },
          },
        },
      },
      modelHasVision: false,
      sandbox: { root: gatewayRoot, bridge: sandbox.fsBridge! },
    });
    if (!tool) {
      throw new Error("Expected image tool with explicit imageModel");
    }
    return tool;
  }

  it("fails before publication, then passes VM bytes and prompt to the separate imageModel", async () => {
    const sandbox = createRemoteSandbox();
    const tool = imageTool(sandbox);
    await expect(tool.execute("before", { image: imagePath })).rejects.toThrow();
    expect(describeImage).not.toHaveBeenCalled();

    await stageInboundMediaForSandbox({
      sandbox,
      media: [{ path: imagePath, workspaceDir: gatewayRoot, contentType: "image/png" }],
    });
    expect(await fs.readFile(path.join(remoteRoot, imagePath))).toEqual(imageBytes);
    // The tool must read the VM, not fall back to the Gateway's local copy.
    await fs.rm(path.join(gatewayRoot, imagePath));
    const result = await tool.execute("after", {
      image: imagePath,
      prompt: "Read the uploaded screenshot.",
    });
    expect(describeImage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "attachment-test",
        model: "vision",
        prompt: "Read the uploaded screenshot.",
        mime: "image/png",
        buffer: imageBytes,
      }),
    );
    expect(result.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Image received") }),
    ]);
  });

  it("publishes non-image binary files unchanged and preserves remote edits on retry", async () => {
    const sandbox = createRemoteSandbox();
    const filePath = "media/inbound/data---711741bd-3903-440a-9309-2beec281884b.bin";
    const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 10]);
    await fs.writeFile(path.join(gatewayRoot, filePath), bytes);
    const media = [
      { path: filePath, workspaceDir: gatewayRoot, contentType: "application/octet-stream" },
    ];
    await stageInboundMediaForSandbox({ sandbox, media });
    expect(await sandbox.fsBridge!.readFile({ filePath })).toEqual(bytes);
    const edited = Buffer.from([9, 8, 7, 0, 255]);
    await sandbox.fsBridge!.writeFile({ filePath, data: edited });
    await stageInboundMediaForSandbox({ sandbox, media });
    expect(await sandbox.fsBridge!.readFile({ filePath })).toEqual(edited);
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("prepares the same attachment independently after switching the execution VM", async () => {
    const otherRemoteRoot = path.join(root, "other-remote");
    await fs.mkdir(otherRemoteRoot);
    const media = [{ path: imagePath, workspaceDir: gatewayRoot, contentType: "image/png" }];
    for (const workspace of [remoteRoot, otherRemoteRoot]) {
      const sandbox = createRemoteSandbox(workspace);
      await stageInboundMediaForSandbox({ sandbox, media });
      expect(await sandbox.fsBridge!.readFile({ filePath: imagePath })).toEqual(imageBytes);
    }
  });

  it("round-trips a file at the workspace-staging size limit without text conversion or truncation", async () => {
    const sandbox = createRemoteSandbox();
    const filePath = "media/inbound/limit---e3a8a8d0-5e18-42fa-b558-211508f526fb.bin";
    const bytes = Buffer.alloc(MEDIA_MAX_BYTES);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 256;
    }
    await fs.writeFile(path.join(gatewayRoot, filePath), bytes);
    await stageInboundMediaForSandbox({
      sandbox,
      media: [
        { path: filePath, workspaceDir: gatewayRoot, contentType: "application/octet-stream" },
      ],
    });
    const actual = await sandbox.fsBridge!.readFile({ filePath });
    expect(actual.byteLength).toBe(MEDIA_MAX_BYTES);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
