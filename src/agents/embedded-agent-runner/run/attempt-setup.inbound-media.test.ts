import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaFact } from "../../../media/media-facts.js";
import { isSandboxProvisioningError } from "../../sandbox/provisioning-error.js";
import { createSandboxTestContext } from "../../sandbox/test-fixtures.js";

const mocks = vi.hoisted(() => ({ resolveSandboxContext: vi.fn(), stageInboundMedia: vi.fn() }));
vi.mock("../../sandbox.js", () => ({ resolveSandboxContext: mocks.resolveSandboxContext }));
vi.mock("../../inbound-media-staging.js", () => ({
  stageInboundMediaForSandbox: mocks.stageInboundMedia,
}));
import { resolveAttemptWorkspaceSandbox } from "./attempt-setup.js";

describe("attempt inbound-media provisioning", () => {
  let workspaceDir: string;
  const media: MediaFact[] = [
    { path: "media/inbound/screen.png", contentType: "image/png" },
    { path: "media/inbound/report.pdf", contentType: "application/pdf" },
    { path: "media/inbound/data.csv", contentType: "text/csv" },
  ];

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-inbound-"));
    mocks.resolveSandboxContext.mockReset();
    mocks.stageInboundMedia.mockReset().mockResolvedValue({ staged: [], skipped: [] });
  });
  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  function params(overrides: Partial<Parameters<typeof resolveAttemptWorkspaceSandbox>[0]> = {}) {
    return {
      workspaceDir,
      sessionId: "inbound-test",
      sessionKey: "agent:main:main",
      config: {},
      media: media.map((fact) => ({
        path: fact.path,
        contentType: fact.contentType,
        workspaceDir,
      })),
      ...overrides,
    };
  }
  function sandbox(name: string) {
    return createSandboxTestContext({
      overrides: {
        backendId: "ssh",
        containerName: name,
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
      },
    });
  }

  it("awaits attachment publication on the exact sandbox resolved for this attempt", async () => {
    const target = sandbox("vm-one");
    mocks.resolveSandboxContext.mockResolvedValue(target);
    const input = params();
    const result = await resolveAttemptWorkspaceSandbox(input);
    expect(result.sandbox).toBe(target);
    expect(mocks.resolveSandboxContext).toHaveBeenCalledTimes(1);
    expect(mocks.stageInboundMedia).toHaveBeenCalledExactlyOnceWith({
      sandbox: target,
      media: input.media,
      signal: undefined,
    });
    expect(mocks.resolveSandboxContext.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stageInboundMedia.mock.invocationCallOrder[0]!,
    );
  });

  it("stages workspace media instead of prompt projection aliases", async () => {
    const target = sandbox("vm-one");
    mocks.resolveSandboxContext.mockResolvedValue(target);
    const promptMedia: MediaFact[] = [
      { path: "/gateway/raw-image-alias.png", contentType: "image/png" },
    ];
    const workspaceMedia: MediaFact[] = [
      {
        path: "media/inbound/original-audio.ogg",
        contentType: "audio/ogg",
        workspaceDir,
      },
    ];

    await resolveAttemptWorkspaceSandbox(params({ media: promptMedia, workspaceMedia }));

    expect(mocks.stageInboundMedia).toHaveBeenCalledExactlyOnceWith({
      sandbox: target,
      media: workspaceMedia,
      signal: undefined,
    });
  });

  it("treats an explicit empty workspace carrier as no files instead of falling back", async () => {
    mocks.resolveSandboxContext.mockResolvedValue(sandbox("vm-one"));

    await resolveAttemptWorkspaceSandbox(
      params({
        media: [{ path: "/gateway/raw-image-alias.png", contentType: "image/png" }],
        workspaceMedia: [],
      }),
    );

    expect(mocks.stageInboundMedia).not.toHaveBeenCalled();
  });

  it("does not carry a previous VM publication decision into a new attempt", async () => {
    const targets = [sandbox("vm-one"), sandbox("vm-two")];
    for (const target of targets) {
      mocks.resolveSandboxContext.mockResolvedValueOnce(target);
      await resolveAttemptWorkspaceSandbox(params());
    }
    expect(mocks.resolveSandboxContext).toHaveBeenCalledTimes(2);
    expect(mocks.stageInboundMedia.mock.calls.map(([call]) => call.sandbox)).toEqual(targets);
  });

  it("marks transfer failure as model-independent sandbox provisioning", async () => {
    mocks.resolveSandboxContext.mockResolvedValue(sandbox("vm-one"));
    const cause = new Error("remote write unavailable");
    mocks.stageInboundMedia.mockRejectedValue(cause);
    const error = await resolveAttemptWorkspaceSandbox(params()).catch(
      (failure: unknown) => failure,
    );
    expect(isSandboxProvisioningError(error)).toBe(true);
    expect(error).toMatchObject({ cause, backendId: "ssh", message: "remote write unavailable" });
  });

  it("preserves cancellation rather than wrapping it as a provisioning failure", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    mocks.resolveSandboxContext.mockResolvedValue(sandbox("vm-one"));
    mocks.stageInboundMedia.mockRejectedValue(reason);
    await expect(
      resolveAttemptWorkspaceSandbox(params({ abortSignal: controller.signal })),
    ).rejects.toBe(reason);
    expect(mocks.stageInboundMedia.mock.calls[0]?.[0]?.signal).toBe(controller.signal);
  });

  it("does not transfer for host execution or a turn without attachments", async () => {
    mocks.resolveSandboxContext.mockResolvedValueOnce(null);
    await resolveAttemptWorkspaceSandbox(params());
    mocks.resolveSandboxContext.mockResolvedValueOnce(sandbox("vm-one"));
    await resolveAttemptWorkspaceSandbox(params({ media: undefined }));
    expect(mocks.stageInboundMedia).not.toHaveBeenCalled();
  });

  it("rejects a conflicting cwd before any attachment transfer", async () => {
    mocks.resolveSandboxContext.mockResolvedValue(sandbox("vm-one"));
    await expect(
      resolveAttemptWorkspaceSandbox(params({ cwd: path.join(workspaceDir, "different") })),
    ).rejects.toThrow("cwd override is not supported");
    expect(mocks.stageInboundMedia).not.toHaveBeenCalled();
  });
});
