import { afterEach, describe, expect, it, vi } from "vitest";
import { getFinishedSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

const command = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
const tool = () =>
  createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    notifyOnExit: false,
    backgroundMs: 10,
  });
afterEach(() => resetProcessRegistryForTests());

describe("required shell results: real synthetic processes", () => {
  it("collects output past the yield window instead of returning a running handle", async () => {
    const result = await tool().execute("required-result", {
      command: command("setTimeout(() => console.log('COLLECTED_RESULT'), 100)"),
      required: true,
      yieldMs: 10,
    });
    expect(result.details.status).toBe("completed");
    expect(JSON.stringify(result.content)).toContain("COLLECTED_RESULT");
  });

  it("collects backend-owned sandbox output and finalizes the original token once", async () => {
    const finalizeExec = vi.fn(async () => {});
    const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(async () => ({
      argv: [process.execPath, "-e", "setTimeout(() => console.log('BACKEND_COLLECTED'), 100)"],
      env: {},
      stdinMode: "pipe-open" as const,
      finalizeToken: "required-backend-token",
    }));
    const sandbox = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      notifyOnExit: false,
      sandbox: {
        containerName: "required-backend",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir: async (value) => value,
        buildExecSpec,
        finalizeExec,
      },
    });
    const result = await sandbox.execute("required-backend", {
      command: "verify-result",
      required: true,
      yieldMs: 10,
    });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(JSON.stringify(result.content)).toContain("BACKEND_COLLECTED");
    expect(buildExecSpec).toHaveBeenCalledOnce();
    expect(buildExecSpec.mock.calls[0]?.[0]).toMatchObject({ workdir: "/remote/workspace" });
    expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: "required-backend-token",
    });
  });

  it("rejects required plus explicitly detached work before execution", async () => {
    await expect(
      tool().execute("invalid-detach", {
        command: "echo harmless",
        required: true,
        background: true,
      }),
    ).rejects.toThrow(/required.*background/i);
  });

  it("rejects nonboolean required intent", async () => {
    await expect(
      tool().execute("invalid-type", { command: "echo harmless", required: "yes" } as never),
    ).rejects.toThrow(/required.*boolean/i);
  });

  it("retains an explicit detached control", async () => {
    const result = await tool().execute("detached", {
      command: command("setTimeout(() => console.log('DETACHED_RESULT'), 100)"),
      background: true,
    });
    expect(result.details.status).toBe("running");
    if (result.details.status !== "running") {
      throw new Error("expected running");
    }
    const { sessionId } = result.details;
    await expect
      .poll(() => getFinishedSession(sessionId)?.status, { timeout: 2000 })
      .toBe("completed");
  });

  it("returns failed required process output", async () => {
    const result = await tool().execute("failed", {
      command: command(
        "setTimeout(() => { console.error('EXPECTED_FAILURE'); process.exitCode = 7; }, 100)",
      ),
      required: true,
    });
    // Existing exec distinguishes terminal collection from command exit success.
    expect(result.details).toMatchObject({ status: "completed", exitCode: 7 });
    expect(JSON.stringify(result.content)).toContain("EXPECTED_FAILURE");
  });

  it("preserves the process timeout", async () => {
    const result = await tool().execute("timed-out", {
      command: command("setTimeout(() => {}, 30000)"),
      required: true,
      timeout: 0.1,
    });
    expect(result.details).toMatchObject({ status: "failed", timedOut: true });
  });

  it("cancels foreground required work before scheduled later output", async () => {
    const controller = new AbortController();
    const update = vi.fn(() => controller.abort());
    await expect(
      tool().execute(
        "cancelled",
        {
          command: command("console.log('READY'); setTimeout(() => console.log('LATE'), 1000)"),
          required: true,
        },
        controller.signal,
        update,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false])(
    "preserves automatic yield for required=%s on the same tool",
    async (required) => {
      const sharedTool = tool();
      const program = command("setTimeout(() => console.log('SHARED_RESULT'), 100)");
      const requiredResult = sharedTool.execute("shared-required", {
        command: program,
        required: true,
      });
      const ordinary = await sharedTool.execute("shared-ordinary", { command: program, required });
      expect(ordinary.details.status).toBe("running");
      if (ordinary.details.status !== "running") {
        throw new Error("expected running");
      }
      const { sessionId } = ordinary.details;
      expect((await requiredResult).details.status).toBe("completed");
      await expect
        .poll(() => getFinishedSession(sessionId)?.status, { timeout: 2000 })
        .toBe("completed");
    },
  );

  it("does not bypass configured permission denial", async () => {
    const denied = createExecTool({
      host: "gateway",
      security: "deny",
      ask: "off",
      notifyOnExit: false,
    });
    await expect(
      denied.execute("denied", { command: "echo harmless", required: true }),
    ).rejects.toThrow(/denied/i);
  });
});
