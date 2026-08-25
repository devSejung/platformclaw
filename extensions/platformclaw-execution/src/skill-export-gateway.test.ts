import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerPlatformClawSkillExportGateway,
  type PlatformClawSkillExportRuntime,
} from "./skill-export-gateway.js";
import { PlatformClawTargetMutationCoordinator } from "./target-mutation-coordinator.js";

type Handler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function harness(runtime: PlatformClawSkillExportRuntime) {
  const methods = new Map<string, Handler>();
  const targetMutations = new PlatformClawTargetMutationCoordinator();
  const api = {
    logger: { warn: vi.fn() },
    on: vi.fn(),
    registerGatewayMethod: vi.fn((method: string, handler: Handler) =>
      methods.set(method, handler),
    ),
  };
  const dispose = registerPlatformClawSkillExportGateway(
    api as never,
    Promise.resolve(runtime),
    targetMutations,
  );
  const call = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await methods.get(`platformclaw-execution.skillExport.${method}`)!({
      params,
      respond,
    } as never);
    return respond.mock.calls[0]!;
  };
  return { call, dispose, targetMutations };
}

describe("PlatformClaw workspace skill export Gateway", () => {
  it("prepares asynchronously, streams bounded chunks, and cleans up the capability", async () => {
    const bytes = Buffer.alloc(450_000, 7);
    const archivePath = path.join(await makeDirectory("platformclaw-export-gateway-"), "skill.zip");
    await writeFile(archivePath, bytes);
    const cleanup = vi.fn(async () => undefined);
    const exportWorkspaceSkill = vi.fn(async () => ({
      path: archivePath,
      size: bytes.length,
      cleanup,
    }));
    const gateway = harness({ exportWorkspaceSkill });
    const [ok, capability] = await gateway.call("begin", {
      agentId: "agent-one",
      slug: "demo-skill",
      version: "1.2.3",
      expectedTargetRevision: 4,
      expectedAllocationId: "allocation-one",
    });
    expect(ok).toBe(true);
    const request = { agentId: "agent-one", ...(capability as Record<string, unknown>) };
    await vi.waitFor(async () => {
      const [, result] = await gateway.call("status", request);
      expect(result).toEqual({ state: "ready", size: bytes.length });
    });
    const [, first] = await gateway.call("read", { ...request, offset: 0 });
    const firstChunk = first as { data: string; done: boolean };
    expect(Buffer.from(firstChunk.data, "base64").length).toBe(384 * 1024);
    expect(firstChunk.data.length).toBeLessThanOrEqual(512 * 1024);
    expect(firstChunk.done).toBe(false);
    const [, second] = await gateway.call("read", { ...request, offset: 384 * 1024 });
    expect((second as { done: boolean }).done).toBe(true);
    expect(await gateway.call("close", request)).toEqual([true, { ok: true }]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("disposes ready export archives when the Gateway owner stops", async () => {
    const archivePath = path.join(
      await makeDirectory("platformclaw-export-shutdown-"),
      "skill.zip",
    );
    await writeFile(archivePath, "zip");
    const cleanup = vi.fn(async () => undefined);
    const gateway = harness({
      exportWorkspaceSkill: vi.fn(async () => ({ path: archivePath, size: 3, cleanup })),
    });
    const [, capability] = await gateway.call("begin", {
      agentId: "agent-one",
      slug: "demo-skill",
      version: "1.0.0",
      expectedTargetRevision: 1,
      expectedAllocationId: "allocation-one",
    });
    const request = { agentId: "agent-one", ...(capability as Record<string, unknown>) };
    await vi.waitFor(async () => {
      const [, result] = await gateway.call("status", request);
      expect(result).toEqual({ state: "ready", size: 3 });
    });

    await gateway.dispose();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(await gateway.call("status", request)).toEqual([
      false,
      undefined,
      expect.objectContaining({ message: "workspace export expired" }),
    ]);
  });

  it("rejects another agent or capability and serializes work-location mutation", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const archivePath = path.join(
      await makeDirectory("platformclaw-export-conflict-"),
      "skill.zip",
    );
    await writeFile(archivePath, "zip");
    const gateway = harness({
      exportWorkspaceSkill: vi.fn(async () => {
        await pending;
        return { path: archivePath, size: 3, cleanup: async () => undefined };
      }),
    });
    const [, capability] = await gateway.call("begin", {
      agentId: "agent-one",
      slug: "demo-skill",
      version: "1.0.0",
      expectedTargetRevision: 1,
      expectedAllocationId: "allocation-one",
    });
    expect(gateway.targetMutations.isHeld("agent-one", "skill-export")).toBe(true);
    expect(
      await gateway.call("status", {
        agentId: "agent-two",
        ...(capability as Record<string, unknown>),
      }),
    ).toEqual([false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" })]);
    expect(gateway.targetMutations.tryAcquire("agent-one", "target-change")).toBeNull();
    release();
    await vi.waitFor(() =>
      expect(gateway.targetMutations.isHeld("agent-one", "skill-export")).toBe(false),
    );
    await gateway.call("close", {
      agentId: "agent-one",
      ...(capability as Record<string, unknown>),
    });
  });

  it("returns a visible failure and cleans up an archive removed before reading", async () => {
    const archivePath = path.join(await makeDirectory("platformclaw-export-missing-"), "skill.zip");
    await writeFile(archivePath, "zip");
    const cleanup = vi.fn(async () => undefined);
    const gateway = harness({
      exportWorkspaceSkill: vi.fn(async () => ({ path: archivePath, size: 3, cleanup })),
    });
    const [, capability] = await gateway.call("begin", {
      agentId: "agent-one",
      slug: "demo-skill",
      version: "1.0.0",
      expectedTargetRevision: 1,
      expectedAllocationId: "allocation-one",
    });
    const request = { agentId: "agent-one", ...(capability as Record<string, unknown>) };
    await vi.waitFor(async () => {
      expect((await gateway.call("status", request))[1]).toEqual({ state: "ready", size: 3 });
    });
    await rm(archivePath);
    expect(await gateway.call("read", { ...request, offset: 0 })).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("pins allocation identity and fails visibly when a replacement keeps the same revision", async () => {
    const exportWorkspaceSkill = vi.fn<PlatformClawSkillExportRuntime["exportWorkspaceSkill"]>(
      async ({ expectedAllocationId }) => {
        if (expectedAllocationId !== "replacement-allocation") {
          throw new Error("My VM work location changed; reload and retry publishing");
        }
        throw new Error("unexpected export");
      },
    );
    const gateway = harness({ exportWorkspaceSkill });
    const [, capability] = await gateway.call("begin", {
      agentId: "agent-one",
      slug: "demo-skill",
      version: "1.0.0",
      expectedTargetRevision: 1,
      expectedAllocationId: "original-allocation",
    });
    const request = { agentId: "agent-one", ...(capability as Record<string, unknown>) };
    await vi.waitFor(async () => {
      expect(await gateway.call("status", request)).toEqual([
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("work location changed") }),
      ]);
    });
    expect(exportWorkspaceSkill).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAllocationId: "original-allocation" }),
    );
  });
});
