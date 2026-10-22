import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeModule from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from "./one-shot-exit.js";

const successfulRun = async () => {};
const ignoreError = () => {};

describe("one-shot CLI exit", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.useFakeTimers();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);
    vi.spyOn(runtimeModule, "restoreRuntimeTerminalState").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ["NODE_USE_SYSTEM_CA", { NODE_USE_SYSTEM_CA: "1" }, []],
    ["execArgv", {}, ["--use-system-ca"]],
    ["underscored execArgv", {}, ["--use_system_ca"]],
    ["NODE_OPTIONS", { NODE_OPTIONS: "'--use-system-ca'" }, []],
    ["underscored NODE_OPTIONS", { NODE_OPTIONS: "--use_system_ca" }, []],
  ] as const)(
    "allows natural macOS system CA command completion from %s",
    async (_label, env, execArgv) => {
      process.exitCode = 3;
      await runCliWithExitFinalization({
        run: successfulRun,
        onError: ignoreError,
        env: env as NodeJS.ProcessEnv,
        execArgv,
        platform: "darwin",
        markers: {},
      });

      expect(process.exitCode).toBe(3);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(runtimeModule.restoreRuntimeTerminalState).toHaveBeenCalledExactlyOnceWith(
        "runtime exit",
        { resumeStdinIfPaused: false },
      );
    },
  );

  it.each([
    ["non-macOS", "linux" as const, { NODE_USE_SYSTEM_CA: "1" }, []],
    ["system CA disabled", "darwin" as const, { NODE_USE_SYSTEM_CA: "0" }, []],
  ])("does not finalize after completion when %s", async (_label, platform, env, execArgv) => {
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: env as NodeJS.ProcessEnv,
      execArgv: execArgv as string[],
      platform,
      markers: {},
    });

    expect(process.exitCode).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeModule.restoreRuntimeTerminalState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not finalize a long-lived command until its run promise settles", async () => {
    let finishRun: (() => void) | undefined;
    const runPromise = runCliWithExitFinalization({
      run: async () =>
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        }),
      onError: ignoreError,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(process.exitCode).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeModule.restoreRuntimeTerminalState).not.toHaveBeenCalled();

    finishRun?.();
    await runPromise;
    expect(process.exitCode).toBe(0);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeModule.restoreRuntimeTerminalState).toHaveBeenCalledOnce();
  });

  it("reports failures and replaces a pending successful exit before finalizing", async () => {
    const order: string[] = [];
    vi.mocked(runtimeModule.restoreRuntimeTerminalState).mockImplementation(() => {
      order.push(`finalized:${String(process.exitCode)}`);
    });
    requestExitAfterOneShotOutput(defaultRuntime, 0);

    await runCliWithExitFinalization({
      run: async () => {
        throw new Error("command failed");
      },
      onError: async () => {
        await Promise.resolve();
        order.push("reported");
        process.exitCode = 6;
      },
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    expect(process.exitCode).toBe(6);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(order).toEqual(["reported", "finalized:6"]);
  });

  it("normalizes a Node integer-string process exit code", async () => {
    process.exitCode = "9";
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    expect(process.exitCode).toBe(9);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("preserves a command-specific exit code when system CA completion also requests exit", async () => {
    requestExitAfterOneShotOutput(defaultRuntime, 7);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    expect(process.exitCode).toBe(7);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("defers a requested exit until the outer finalizer", async () => {
    expect(requestExitAfterOneShotOutput(defaultRuntime, 2)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(process.exitCode).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeModule.restoreRuntimeTerminalState).not.toHaveBeenCalled();

    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: {},
      execArgv: [],
      platform: "linux",
      markers: {},
    });
    expect(process.exitCode).toBe(2);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("does not request exits for embedded custom runtimes", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    expect(requestExitAfterOneShotOutput(runtime)).toBe(false);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      runtime,
      env: { NODE_USE_SYSTEM_CA: "1" },
      execArgv: [],
      platform: "darwin",
      markers: {},
    });

    expect(process.exitCode).toBeUndefined();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtimeModule.restoreRuntimeTerminalState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses finalization inside Vitest workers but not spawned CLI children", async () => {
    const inheritedTestEnv = { VITEST: "1", VITEST_WORKER_ID: "1" } as NodeJS.ProcessEnv;
    requestExitAfterOneShotOutput(defaultRuntime, 7);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: inheritedTestEnv,
      execArgv: [],
      platform: "linux",
      markers: { tinypoolState: {} },
    });
    expect(process.exitCode).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeModule.restoreRuntimeTerminalState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    requestExitAfterOneShotOutput(defaultRuntime, 7);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: inheritedTestEnv,
      execArgv: [],
      platform: "linux",
      markers: {},
    });
    expect(process.exitCode).toBe(7);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(runtimeModule.restoreRuntimeTerminalState).toHaveBeenCalledOnce();
  });

  it("forces the current exit code only when a completed command remains alive for five seconds", async () => {
    requestExitAfterOneShotOutput(defaultRuntime, 5);
    await runCliWithExitFinalization({
      run: successfulRun,
      onError: ignoreError,
      env: {},
      execArgv: [],
      platform: "linux",
      markers: {},
    });

    expect(process.exitCode).toBe(5);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    process.exitCode = 6;
    await vi.advanceTimersByTimeAsync(1);
    expect(defaultRuntime.exit).toHaveBeenCalledExactlyOnceWith(6);
  });
});
