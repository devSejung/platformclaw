import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { serveManagedPresentationPreview } from "./managed-presentation-preview.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const { executeContainer } = vi.hoisted(() => ({
  executeContainer:
    vi.fn<typeof import("../agents/sandbox/container-engine.js").execContainerRaw>(),
}));
vi.mock("../agents/sandbox/container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  execContainerRaw: executeContainer,
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const INPUT = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80]);
const PDF = Buffer.from("%PDF-1.7\nconverted preview\n%%EOF\n");

function result(stdout = Buffer.alloc(0), code = 0) {
  return { stdout, stderr: Buffer.alloc(0), code };
}

async function fixture(
  options: {
    input?: Buffer;
    contentType?: string;
    revalidate?: () => Promise<boolean>;
    getConfig?: () => OpenClawConfig;
    method?: string;
  } = {},
) {
  const directory = directories.make("presentation-preview-");
  const filePath = path.join(directory, "snapshot.pptx");
  await writeFile(filePath, options.input ?? INPUT);
  const handle = await open(filePath, "r");
  const response = makeMockHttpResponse();
  const revalidate = options.revalidate ?? vi.fn(async () => true);
  const run = () =>
    serveManagedPresentationPreview({
      response: response.res,
      method: options.method,
      file: { handle, stat: { size: options.input?.length ?? INPUT.length } },
      contentType:
        options.contentType ??
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      getConfig:
        options.getConfig ??
        (() => ({
          agents: {
            defaults: {
              sandbox: {
                docker: {
                  image: "test-converter:local",
                  env: { PRIVATE_TOKEN: "must-not-enter" },
                  network: "host",
                  binds: ["/secret:/secret"],
                },
              },
            },
          },
        })),
      revalidate,
    });
  return { ...response, run, revalidate, filePath, handle };
}

describe("managed PowerPoint preview", () => {
  beforeEach(() => {
    executeContainer.mockReset();
    executeContainer.mockImplementation(async (_engine, args) => {
      if (args[0] === "info") {
        return result(Buffer.from('["name=seccomp,profile=builtin","name=rootless"]'));
      }
      return result(args[0] === "start" ? PDF : Buffer.from("container"));
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ])("converts only snapshot bytes with an isolated rootless profile (%s)", async (contentType) => {
    const preview = await fixture({ contentType });
    await preview.run();
    expect(preview.res.statusCode).toBe(200);
    expect(preview.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
    expect(preview.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(preview.end).toHaveBeenCalledWith(PDF);
    expect(await readFile(preview.filePath)).toEqual(INPUT);
    const create = executeContainer.mock.calls.find(([, args]) => args[0] === "create")?.[1];
    expect(create).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--user",
        "65534:65534",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "768m",
        "--memory-swap",
        "768m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--pull",
        "never",
        "test-converter:local",
        "nproc=64:64",
        "cpu=20:21",
      ]),
    );
    expect(create?.join(" ")).not.toContain("PRIVATE_TOKEN");
    expect(create?.join(" ")).not.toContain("/secret");
    expect(create?.join(" ")).toContain("ulimit -v 2097152");
    expect(create?.join(" ")).toContain("timeout --kill-after=1s 20s libreoffice");
    expect(create).not.toContain("--volume");
    expect(create).not.toContain("--mount");
    const start = executeContainer.mock.calls.find(([, args]) => args[0] === "start");
    expect(start?.[2]?.input).toEqual(INPUT);
    expect(start?.[2]?.maxBufferBytes).toBe(16 * 1024 * 1024 + 1);
    expect(executeContainer.mock.calls.at(-1)?.[1].slice(0, 2)).toEqual(["rm", "--force"]);
    expect(preview.revalidate).toHaveBeenCalledTimes(3);
  });

  it("does not create a converter on a rootful daemon", async () => {
    executeContainer.mockResolvedValue(result(Buffer.from('["name=seccomp"]')));
    const preview = await fixture();
    await preview.run();
    expect(preview.res.statusCode).toBe(503);
    expect(executeContainer).toHaveBeenCalledOnce();
    expect(preview.end.mock.calls[0]?.[0]).toContain("rootless sandbox Docker");
    expect(preview.end.mock.calls[0]?.[0]).toMatch(/download the original/iu);
  });

  it("cleans up without processing when ownership is revoked after creation", async () => {
    let checks = 0;
    const preview = await fixture({ revalidate: async () => ++checks < 2 });
    await preview.run();
    expect(executeContainer.mock.calls.map(([, args]) => args[0])).toEqual([
      "info",
      "create",
      "rm",
    ]);
    expect(preview.end).not.toHaveBeenCalled();
    await expect(preview.handle.stat()).rejects.toThrow();
  });

  it("does not publish converted bytes after ownership is revoked", async () => {
    let checks = 0;
    const preview = await fixture({ revalidate: async () => ++checks < 3 });
    await preview.run();
    expect(executeContainer.mock.calls.some(([, args]) => args[0] === "start")).toBe(true);
    expect(preview.end).not.toHaveBeenCalled();
  });

  it.each([69, 1, 124, 0])(
    "reports unavailable or invalid conversion and removes its container (%s)",
    async (code) => {
      executeContainer.mockImplementation(async (_engine, args) => {
        if (args[0] === "info") {
          return result(Buffer.from('["name=rootless"]'));
        }
        return result(Buffer.alloc(0), args[0] === "start" ? code : 0);
      });
      const preview = await fixture();
      await preview.run();
      expect(preview.res.statusCode).toBe(code === 69 ? 503 : code === 124 ? 504 : 422);
      expect(preview.end.mock.calls[0]?.[0]).toMatch(/download the original/iu);
      expect(executeContainer.mock.calls.at(-1)?.[1][0]).toBe("rm");
    },
  );

  it("returns preview headers without PDF bytes for HEAD", async () => {
    const preview = await fixture({ method: "HEAD" });
    await preview.run();
    expect(preview.setHeader).toHaveBeenCalledWith("Content-Length", PDF.length);
    expect(preview.end).toHaveBeenCalledWith(undefined);
  });

  it("rejects an oversized snapshot before starting Docker", async () => {
    const preview = await fixture({ input: Buffer.alloc(16 * 1024 * 1024 + 1) });
    await preview.run();
    expect(preview.res.statusCode).toBe(413);
    expect(executeContainer).not.toHaveBeenCalled();
  });

  it.each(["deadline", "disconnect"])("removes a running converter after %s", async (cause) => {
    const preview = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let notifyStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStart = resolve;
    });
    executeContainer.mockImplementation(async (_engine, args, options) => {
      if (args[0] === "info") {
        return result(Buffer.from('["name=rootless"]'));
      }
      if (args[0] !== "start") {
        return result();
      }
      return await new Promise<ReturnType<typeof result>>((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
        notifyStart?.();
      });
    });
    const running = preview.run();
    await started;
    if (cause === "deadline") {
      await vi.advanceTimersByTimeAsync(25_000);
    } else {
      preview.res.destroy();
    }
    await running;
    expect(executeContainer.mock.calls.at(-1)?.[1].slice(0, 2)).toEqual(["rm", "--force"]);
    if (cause === "deadline") {
      expect(preview.res.statusCode).toBe(504);
    } else {
      expect(preview.end).not.toHaveBeenCalled();
    }
  });

  it("does not start a created converter after the operator changes its image", async () => {
    let checks = 0;
    const preview = await fixture({
      getConfig: () => ({
        agents: {
          defaults: { sandbox: { docker: { image: ++checks === 1 ? "old:local" : "new:local" } } },
        },
      }),
    });
    await preview.run();
    expect(preview.res.statusCode).toBe(503);
    expect(executeContainer.mock.calls.map(([, args]) => args[0])).toEqual([
      "info",
      "create",
      "rm",
    ]);
  });

  it("rejects concurrent work without queueing or creating another container", async () => {
    let releaseStart: (() => void) | undefined;
    let notifyStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStart = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    executeContainer.mockImplementation(async (_engine, args) => {
      if (args[0] === "info") {
        return result(Buffer.from('["name=rootless"]'));
      }
      if (args[0] === "start") {
        notifyStart?.();
        await startGate;
        return result(PDF);
      }
      return result();
    });
    const first = await fixture();
    const running = first.run();
    await started;
    try {
      const second = await fixture();
      await second.run();
      expect(second.res.statusCode).toBe(503);
      expect(executeContainer.mock.calls.filter(([, args]) => args[0] === "create")).toHaveLength(
        1,
      );
    } finally {
      releaseStart?.();
      await running;
    }
  });
});
