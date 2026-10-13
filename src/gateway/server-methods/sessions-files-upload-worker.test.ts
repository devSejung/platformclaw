import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkerOptions } from "node:worker_threads";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { root } from "@openclaw/fs-safe/root";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import type { SessionUploadWorkerTarget } from "./sessions-files-upload-target.js";
import {
  acquireSessionFileUploadLease,
  type SessionFileUploadLease,
} from "./sessions-files-upload-worker.js";

const hoisted = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("node:worker_threads", async () => {
  const actual = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  return {
    ...actual,
    Worker: vi.fn(function createUploadWorker(url: URL, options: WorkerOptions) {
      return hoisted.createWorker(url, options);
    }),
  };
});

class FakeWorker extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn();
  exited = false;

  exit(code = 0): void {
    if (!this.exited) {
      this.exited = true;
      this.emit("exit", code);
    }
  }
}

const target: SessionUploadWorkerTarget = {
  rootReal: "/synthetic-workspace",
  dev: 1,
  ino: 2,
  destination: { rootReal: "/synthetic-workspace", dev: 1, ino: 2 },
  relativePath: "data.bin",
  size: 3,
};
const lifecycleParams = { target, bytes: Buffer.from("abc"), assertCurrent: vi.fn() };

describe("workspace upload Worker lifecycle", { timeout: 10_000 }, () => {
  const params = lifecycleParams;
  const workers: FakeWorker[] = [];
  const leases: SessionFileUploadLease[] = [];

  function reserve(): SessionFileUploadLease {
    const lease = acquireSessionFileUploadLease();
    expect(lease).toBeDefined();
    leases.push(lease!);
    return lease!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.createWorker.mockImplementation(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
  });

  afterEach(() => {
    workers.splice(0).forEach((worker) => {
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.exit();
    });
    leases.splice(0).forEach((lease) => lease.release());
    vi.useRealTimers();
  });

  it("admits only two callers with no queue before any worker exists", () => {
    const first = reserve();
    reserve();
    expect(acquireSessionFileUploadLease()).toBeUndefined();
    expect(hoisted.createWorker).not.toHaveBeenCalled();
    first.release();
    reserve();
  });

  it("uses a fixed worker entry, copied environment, and an exact owned ArrayBuffer", async () => {
    const assertCurrent = vi.fn();
    const running = reserve().run({ ...params, assertCurrent });
    const worker = workers[0]!;
    const [url, options] = hoisted.createWorker.mock.calls[0]!;
    expect(url.pathname).toMatch(/\/sessions-files-upload\.worker\.ts$/u);
    expect(options.env).toEqual(process.env);
    expect(options.env).not.toBe(process.env);
    expect(options.trackUnmanagedFds).toBe(false);
    expect(options.workerData).toEqual(target);
    expect(options.workerData).not.toHaveProperty("bytes");
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.emit("message", { type: "ready" });
    expect(assertCurrent).toHaveBeenCalledOnce();
    const [message, transfer] = worker.postMessage.mock.calls[0]!;
    expect(message.bytes).toBeInstanceOf(Uint8Array);
    expect(message.bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(message.bytes.buffer).not.toBe(params.bytes.buffer);
    expect(message.bytes.buffer.byteLength).toBe(3);
    expect(transfer).toEqual([message.bytes.buffer]);
    worker.emit("message", { type: "written" });
    worker.exit();
    await running;
  });

  it("waits for both written confirmation and normal exit before success", async () => {
    const finish = vi.fn();
    const running = reserve().run(params).then(finish);
    const worker = workers[0]!;
    worker.emit("message", { type: "ready" });
    worker.emit("message", { type: "written" });
    await Promise.resolve();
    expect(finish).not.toHaveBeenCalled();
    worker.exit();
    await running;
    expect(finish).toHaveBeenCalledOnce();
  });

  it("cancels a rejected current-authority check before dispatching bytes", async () => {
    const authorityError = new Error("session permission revoked");
    const running = reserve().run({
      ...params,
      assertCurrent: () => {
        throw authorityError;
      },
    });
    const rejection = expect(running).rejects.toBe(authorityError);
    const worker = workers[0]!;
    worker.emit("message", { type: "ready" });
    await rejection;
    expect(worker.postMessage.mock.calls).toEqual([[{ type: "cancel" }]]);
  });

  it("does not send bytes when the authority callback synchronously aborts", async () => {
    const controller = new AbortController();
    const running = reserve().run({
      ...params,
      signal: controller.signal,
      assertCurrent: () => controller.abort(),
    });
    const rejection = expect(running).rejects.toMatchObject({ outcome: "not-written" });
    const worker = workers[0]!;
    worker.emit("message", { type: "ready" });
    await rejection;
    expect(worker.postMessage.mock.calls).toEqual([[{ type: "cancel" }]]);
  });

  it.each([false, true])(
    "keeps timed-out slots until natural exit (dispatched=%s)",
    async (dispatched) => {
      vi.useFakeTimers();
      const running = reserve().run(params);
      const rejection = expect(running).rejects.toMatchObject({
        outcome: dispatched ? "unknown" : "not-written",
      });
      reserve();
      const worker = workers[0]!;
      if (dispatched) {
        worker.emit("message", { type: "ready" });
      }
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(acquireSessionFileUploadLease()).toBeUndefined();
      expect(worker.postMessage.mock.calls.at(-1)?.[0].type).toBe(dispatched ? "write" : "cancel");
      // A late success cannot respond twice or release a still-running native slot.
      worker.emit("message", { type: "written" });
      expect(acquireSessionFileUploadLease()).toBeUndefined();
      worker.exit();
      reserve();
    },
  );

  it.each([false, true])(
    "handles abort without terminating native work (dispatched=%s)",
    async (dispatched) => {
      const controller = new AbortController();
      const running = reserve().run({ ...params, signal: controller.signal });
      const rejection = expect(running).rejects.toMatchObject({
        outcome: dispatched ? "unknown" : "not-written",
      });
      const worker = workers[0]!;
      if (dispatched) {
        worker.emit("message", { type: "ready" });
      }
      controller.abort();
      await rejection;
      expect(worker.postMessage.mock.calls.at(-1)?.[0].type).toBe(dispatched ? "write" : "cancel");
    },
  );

  it.each(["already-exists", "helper-unavailable"])(
    "preserves known no-write failure %s after GO",
    async (code) => {
      const running = reserve().run(params);
      const rejection = expect(running).rejects.toMatchObject({ code, outcome: "not-written" });
      const worker = workers[0]!;
      worker.emit("message", { type: "ready" });
      worker.emit("message", { type: "failed", code, outcome: "not-written" });
      await rejection;
    },
  );

  it("reports worker error after dispatch as unknown and retains the slot until exit", async () => {
    const running = reserve().run(params);
    const rejection = expect(running).rejects.toMatchObject({ outcome: "unknown" });
    reserve();
    const worker = workers[0]!;
    worker.emit("message", { type: "ready" });
    worker.emit("error", new Error("worker stopped unexpectedly"));
    await rejection;
    expect(acquireSessionFileUploadLease()).toBeUndefined();
    worker.exit(1);
    reserve();
  });

  it("rejects a missing fixed worker before dispatch and lets the caller release admission", async () => {
    hoisted.createWorker.mockImplementation(() => {
      throw new Error("worker entry missing");
    });
    const lease = reserve();
    await expect(lease.run(params)).rejects.toMatchObject({
      outcome: "not-written",
      code: "helper-unavailable",
    });
    lease.release();
    reserve();
  });
});

describe("actual native workspace upload Worker", { timeout: 20_000 }, () => {
  let tempRoot: string;
  let workspaceRoot: string;
  const exited: Promise<number>[] = [];
  const leases: SessionFileUploadLease[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    const actual =
      await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
    hoisted.createWorker.mockImplementation((url: URL, options: WorkerOptions) => {
      const worker = new actual.Worker(url, options);
      exited.push(
        new Promise((resolve) => {
          worker.once("exit", resolve);
        }),
      );
      return worker;
    });
    tempRoot = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-upload-worker-"),
    );
    workspaceRoot = path.join(tempRoot, "workspace");
    await fs.mkdir(workspaceRoot);
    configureFsSafeNative({ mode: "off" });
  });

  afterEach(async () => {
    await Promise.all(exited.splice(0));
    leases.splice(0).forEach((lease) => lease.release());
    // /proc observes this process's shared fd table across its Worker threads;
    // compare only this synthetic fixture, so other test activity cannot add noise.
    if (process.platform === "linux") {
      const links = await Promise.all(
        (await fs.readdir("/proc/self/fd")).map(async (fd) =>
          fs.readlink(`/proc/self/fd/${fd}`).catch(() => ""),
        ),
      );
      expect(links.filter((link) => link === tempRoot || link.startsWith(`${tempRoot}/`))).toEqual(
        [],
      );
    }
    expect((await fs.readdir(workspaceRoot)).some((name) => name.endsWith(".native.tmp"))).toBe(
      false,
    );
    await fs.rm(tempRoot, { recursive: true, force: true });
    configureFsSafeNative({ mode: "off" });
  }, 10_000);

  async function admission(bytes = Buffer.from("exact synthetic bytes"), folder = "") {
    const workspace = await root(workspaceRoot, { symlinks: "reject", hardlinks: "reject" });
    const identity = await workspace.stat(".");
    const destination = folder
      ? await root(path.join(workspace.rootReal, ...folder.split("/")), {
          symlinks: "reject",
          hardlinks: "reject",
        })
      : workspace;
    const destinationIdentity = await destination.stat(".");
    const lease = acquireSessionFileUploadLease();
    expect(lease).toBeDefined();
    leases.push(lease!);
    return {
      lease: lease!,
      params: {
        target: {
          rootReal: workspace.rootReal,
          dev: identity.dev,
          ino: identity.ino,
          destination: {
            rootReal: destination.rootReal,
            dev: destinationIdentity.dev,
            ino: destinationIdentity.ino,
          },
          relativePath: folder ? `${folder}/data.bin` : "data.bin",
          size: bytes.length,
        },
        bytes,
        assertCurrent: vi.fn(),
      },
    };
  }

  it("requires native in its own module state while the main policy stays off", async () => {
    const { lease, params } = await admission();
    await lease.run(params);
    expect(await fs.readFile(path.join(workspaceRoot, "data.bin"))).toEqual(params.bytes);
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it("creates a basename inside an ordinary existing nested destination Root", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });
    const { lease, params } = await admission(Buffer.from("nested synthetic bytes"), "src/nested");
    await lease.run(params);
    expect(await fs.readFile(path.join(workspaceRoot, "src", "nested", "data.bin"))).toEqual(
      params.bytes,
    );
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it("rejects a static in-root folder alias without creating a file", async () => {
    const original = path.join(workspaceRoot, "original");
    await fs.mkdir(original);
    await fs.symlink(
      original,
      path.join(workspaceRoot, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const { lease, params } = await admission(Buffer.from("synthetic alias upload"), "alias");
    await expect(lease.run(params)).rejects.toMatchObject({ outcome: "not-written" });
    await Promise.all(exited);
    expect(await fs.readdir(original)).toEqual([]);
  });

  it.each(["canonical-path", "inode"])(
    "rejects incorrect destination metadata %s before READY",
    async (change) => {
      const { lease, params } = await admission();
      if (change === "canonical-path") {
        params.target.destination.rootReal = tempRoot;
      } else {
        // Large Windows inode numbers may exceed JS integer precision; +1
        // can equal the original. Choose a definitely different numeric value.
        params.target.destination.ino = params.target.destination.ino === 0 ? 1 : 0;
      }
      await expect(lease.run(params)).rejects.toMatchObject({
        code: "path-mismatch",
        outcome: "not-written",
      });
      expect(params.assertCurrent).not.toHaveBeenCalled();
      await Promise.all(exited);
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    },
  );

  it("writes a full 16 MiB transfer with exact contents", async () => {
    const { lease, params } = await admission(Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES, 0xab));
    await lease.run(params);
    const saved = await fs.readFile(path.join(workspaceRoot, "data.bin"));
    expect(saved.byteLength).toBe(MAX_TERMINAL_UPLOAD_BYTES);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(
      createHash("sha256").update(params.bytes).digest("hex"),
    );
  });

  it("naturally exits two simultaneous native workers while the main mode stays off", async () => {
    const first = await admission(Buffer.from("first simultaneous synthetic upload"));
    const second = await admission(Buffer.from("second simultaneous synthetic upload"));
    first.params.target.relativePath = "first.bin";
    second.params.target.relativePath = "second.bin";
    await Promise.all([first.lease.run(first.params), second.lease.run(second.params)]);
    expect(hoisted.createWorker).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(workspaceRoot, "first.bin"))).toEqual(first.params.bytes);
    expect(await fs.readFile(path.join(workspaceRoot, "second.bin"))).toEqual(second.params.bytes);
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it("closes native descriptors after duplicate failure without changing the existing file", async () => {
    const { lease, params } = await admission();
    await fs.writeFile(path.join(workspaceRoot, "data.bin"), "existing synthetic data");
    await expect(lease.run(params)).rejects.toMatchObject({
      code: "already-exists",
      outcome: "not-written",
    });
    await Promise.all(exited);
    expect(await fs.readFile(path.join(workspaceRoot, "data.bin"), "utf8")).toBe(
      "existing synthetic data",
    );
  });

  it("reclaims both slots after repeated cancellations and uploads again", async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const admissions = [await admission(), await admission()];
      expect(acquireSessionFileUploadLease()).toBeUndefined();
      const controllers = admissions.map(() => new AbortController());
      const rejections = admissions.map(({ lease, params }, index) =>
        expect(lease.run({ ...params, signal: controllers[index]!.signal })).rejects.toMatchObject({
          outcome: "not-written",
        }),
      );
      controllers.forEach((controller) => controller.abort());
      await Promise.all(rejections);
      expect(await Promise.all(exited.slice(-2))).toEqual([0, 0]);
      expect(await fs.readdir(workspaceRoot)).toEqual([]);
    }
    const first = await admission(Buffer.from("first upload after synthetic cancellations"));
    const second = await admission(Buffer.from("second upload after synthetic cancellations"));
    expect(acquireSessionFileUploadLease()).toBeUndefined();
    first.params.target.relativePath = "first-after-cancel.bin";
    second.params.target.relativePath = "second-after-cancel.bin";
    await Promise.all([first.lease.run(first.params), second.lease.run(second.params)]);
    expect(await Promise.all(exited.slice(-2))).toEqual([0, 0]);
    expect(await fs.readFile(path.join(workspaceRoot, "first-after-cancel.bin"))).toEqual(
      first.params.bytes,
    );
    expect(await fs.readFile(path.join(workspaceRoot, "second-after-cancel.bin"))).toEqual(
      second.params.bytes,
    );
  });

  it("lets a dispatched native write finish its cleanup after an unknown abort response", async () => {
    const { lease, params } = await admission(Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES, 0x5a));
    const controller = new AbortController();
    params.assertCurrent.mockImplementation(() => queueMicrotask(() => controller.abort()));
    await expect(lease.run({ ...params, signal: controller.signal })).rejects.toMatchObject({
      outcome: "unknown",
    });
    await Promise.all(exited);
    const saved = await fs.readFile(path.join(workspaceRoot, "data.bin"));
    expect(saved.byteLength).toBe(MAX_TERMINAL_UPLOAD_BYTES);
    expect(createHash("sha256").update(saved).digest("hex")).toBe(
      createHash("sha256").update(params.bytes).digest("hex"),
    );
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });

  it("rejects a root pathname replaced during transfer instead of repinning a new root", async () => {
    const { lease, params } = await admission();
    const original = path.join(tempRoot, "original");
    await fs.rename(workspaceRoot, original);
    await fs.mkdir(workspaceRoot);
    await expect(lease.run(params)).rejects.toMatchObject({
      code: "path-mismatch",
      outcome: "not-written",
    });
    expect(await fs.readdir(workspaceRoot)).toEqual([]);
    expect(await fs.readdir(original)).toEqual([]);
  });

  it("rechecks the pinned root after ready and before create", async () => {
    const { lease, params } = await admission();
    const { renameSync, mkdirSync } = await import("node:fs");
    const original = path.join(tempRoot, "original");
    params.assertCurrent.mockImplementation(() => {
      renameSync(workspaceRoot, original);
      mkdirSync(workspaceRoot);
    });
    await expect(lease.run(params)).rejects.toMatchObject({
      code: "path-mismatch",
      outcome: "not-written",
    });
    expect(await fs.readdir(workspaceRoot)).toEqual([]);
    expect(await fs.readdir(original)).toEqual([]);
  });

  it("fails closed with native missing even when the copied environment requests off", async () => {
    // Copy the exact installed package and production source into an independent
    // fixture, excluding only the native binaries. All imports remain public.
    const fixtureRoot = path.join(tempRoot, "native-missing");
    const packageRoot = fileURLToPath(
      new URL("../", import.meta.resolve("@openclaw/fs-safe/root")),
    );
    const fixturePackage = path.join(fixtureRoot, "node_modules", "@openclaw", "fs-safe");
    await fs.mkdir(fixturePackage, { recursive: true });
    await fs.copyFile(
      path.join(packageRoot, "package.json"),
      path.join(fixturePackage, "package.json"),
    );
    await fs.cp(path.join(packageRoot, "dist"), path.join(fixturePackage, "dist"), {
      recursive: true,
      filter: (source) => path.basename(source) !== "native",
    });
    await fs.writeFile(path.join(fixtureRoot, "package.json"), '{"type":"module"}');
    const fixtureMethods = path.join(fixtureRoot, "src", "gateway", "server-methods");
    const fixtureSchema = path.join(fixtureRoot, "packages", "gateway-protocol", "src", "schema");
    await fs.mkdir(fixtureMethods, { recursive: true });
    await fs.mkdir(fixtureSchema, { recursive: true });
    for (const file of ["sessions-files-upload.worker.ts", "sessions-files-upload-target.ts"]) {
      await fs.copyFile(new URL(`./${file}`, import.meta.url), path.join(fixtureMethods, file));
    }
    await fs.copyFile(
      new URL(
        "../../../packages/gateway-protocol/src/schema/terminal-constants.ts",
        import.meta.url,
      ),
      path.join(fixtureSchema, "terminal-constants.ts"),
    );
    expect(await fs.readdir(path.join(fixturePackage, "dist"))).not.toContain("native");
    const actual =
      await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
    hoisted.createWorker.mockImplementation((_url: URL, options: WorkerOptions) => {
      const worker = new actual.Worker(
        pathToFileURL(path.join(fixtureMethods, "sessions-files-upload.worker.ts")),
        {
          ...options,
          env: { ...process.env, FS_SAFE_NATIVE_MODE: "off" },
        },
      );
      exited.push(
        new Promise((resolve) => {
          worker.once("exit", resolve);
        }),
      );
      return worker;
    });
    const { lease, params } = await admission();
    await expect(lease.run(params)).rejects.toMatchObject({
      code: "helper-unavailable",
      outcome: "not-written",
    });
    expect(await fs.readdir(workspaceRoot)).toEqual([]);
    expect(getFsSafeNativeConfig().mode).toBe("off");
  });
});
