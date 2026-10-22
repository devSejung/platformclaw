import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function cliChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return env;
}

describe("one-shot CLI process exit", () => {
  it.skipIf(Boolean(process.versions.bun))(
    "drains background work before disposing the Node isolate",
    () => {
      const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
      const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
      // Match nodejs/node#66171: immediate exit can join a V8 worker waiting
      // for main-thread GC while libuv waits for an in-flight crypto job.
      const script = `
        import { pbkdf2, pbkdf2Sync } from "node:crypto";
        import { writeSync } from "node:fs";
        import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
        import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
        const forceExit = process.exit;
        process.exit = function (...args) {
          writeSync(2, "FORCED_EXIT\\n");
          return Reflect.apply(forceExit, this, args);
        };
        const keep = Array.from({ length: 1e5 }, (_, i) => ({ i }));
        const start = performance.now();
        pbkdf2Sync("a", "b", 200000, 64, "sha512");
        const iterations = Math.ceil(200000 * 1000 / (performance.now() - start));
        setTimeout(async () => {
          await runCliWithExitFinalization({
            run: async () => {
              pbkdf2("a", "b", iterations, 64, "sha512", () => {
                process.stdout.write("ASYNC_FINISHED\\n");
              });
              for (let i = 0; i < 40; i++) new Array(1e5).fill(i);
              requestExitAfterOneShotOutput(defaultRuntime, 7);
            },
            onError(error) { throw error; },
          });
        }, 300);
      `;
      const result = spawnSync(
        process.execPath,
        [
          "--stress-concurrent-allocation",
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          script,
        ],
        { encoding: "utf8", env: cliChildEnvironment(), timeout: 30_000 },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(7);
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("ASYNC_FINISHED\n");
    },
  );

  it("drains large piped stdout before a requested nonzero exit", () => {
    const env = cliChildEnvironment();
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const payloadBytes = 1024 * 1024;
    const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      await runCliWithExitFinalization({
        run: async () => {
          process.stdout.write("x".repeat(${payloadBytes}));
          requestExitAfterOneShotOutput(defaultRuntime, 7);
        },
        onError: (error) => { throw error; },
      });
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        env,
        maxBuffer: 2 * payloadBytes,
        timeout: 30_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toHaveLength(payloadBytes);
  });

  it.each([
    { name: "deferred hooks success", exitCode: 0, explicitRequest: true },
    { name: "deferred hooks failure", exitCode: 1, explicitRequest: true },
    { name: "automatic macOS system-CA success", exitCode: 0, explicitRequest: false },
  ])("keeps real dual-TTY JSON clean for $name", ({ exitCode, explicitRequest }) => {
    const env = cliChildEnvironment();
    const oneShotExitUrl = new URL("./one-shot-exit.ts", import.meta.url).href;
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const loggingStateUrl = new URL("../logging/state.ts", import.meta.url).href;
    const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${JSON.stringify(oneShotExitUrl)};
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      import { loggingState } from ${JSON.stringify(loggingStateUrl)};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeStdout(JSON.stringify({ ok: ${exitCode === 0} }));
          ${explicitRequest ? `requestExitAfterOneShotOutput(defaultRuntime, ${exitCode});` : ""}
        },
        onError: (error) => { throw error; },
        ${explicitRequest ? "" : 'env: { NODE_USE_SYSTEM_CA: "1" }, execArgv: [], platform: "darwin", markers: {},'}
      });
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", env, timeout: 30_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: exitCode === 0 });
    expect(result.stderr).toContain("\x1b[?25h");
  });

  it.each([
    { name: "fatal unhandled rejection", errorCode: "ERR_OUT_OF_MEMORY", exitCode: 1 },
    { name: "invalid configuration rejection", errorCode: "INVALID_CONFIG", exitCode: 78 },
  ])("keeps real dual-TTY JSON clean after $name", ({ errorCode, exitCode }) => {
    const env = cliChildEnvironment();
    const runtimeUrl = new URL("../runtime.ts", import.meta.url).href;
    const loggingStateUrl = new URL("../logging/state.ts", import.meta.url).href;
    const unhandledRejectionsUrl = new URL("../infra/unhandled-rejections.ts", import.meta.url)
      .href;
    const script = `
      import { defaultRuntime } from ${JSON.stringify(runtimeUrl)};
      import { loggingState } from ${JSON.stringify(loggingStateUrl)};
      import { installUnhandledRejectionHandler } from ${JSON.stringify(unhandledRejectionsUrl)};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      installUnhandledRejectionHandler();
      defaultRuntime.writeJson({ ok: false });
      const error = Object.assign(new Error("expected fatal test"), {
        code: ${JSON.stringify(errorCode)},
      });
      process.emit("unhandledRejection", error, Promise.resolve());
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", env, timeout: 30_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({ ok: false });
    expect(result.stderr).toContain("\x1b[?25h");
  });
});
