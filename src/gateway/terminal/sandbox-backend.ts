import type { SandboxBackendTerminalPlan } from "../../agents/sandbox/backend.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createLocalTerminalBackend,
  type LocalTerminalBackendSpawner,
  type TerminalBackend,
} from "./backend.js";

const log = createSubsystemLogger("gateway/terminal");

/** Adapts a sandbox-owned transport process to the Gateway terminal backend. */
export async function createSandboxTerminalBackend(params: {
  plan: SandboxBackendTerminalPlan;
  cols: number;
  rows: number;
  env: Record<string, string>;
  spawn?: LocalTerminalBackendSpawner;
}): Promise<TerminalBackend> {
  const process = await params.plan.createProcess();
  const env = { ...params.env };
  for (const [key, value] of Object.entries(process.env ?? {})) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await process.dispose();
  };
  const disposeInBackground = () => {
    void dispose().catch((error: unknown) => {
      log.warn(`sandbox terminal cleanup failed: ${String(error)}`);
    });
  };
  let backend: TerminalBackend;
  try {
    backend = await createLocalTerminalBackend(
      {
        file: process.file,
        args: process.args,
        cwd: process.cwd,
        env,
        cols: params.cols,
        rows: params.rows,
      },
      params.spawn,
    );
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    write: (data) => backend.write(data),
    resize: (cols, rows) => backend.resize(cols, rows),
    pause: () => backend.pause(),
    resume: () => backend.resume(),
    kill: () => {
      try {
        backend.kill();
      } finally {
        disposeInBackground();
      }
    },
    onData: (callback) => backend.onData(callback),
    onExit: (callback) =>
      backend.onExit((exit) => {
        disposeInBackground();
        callback(exit);
      }),
  };
}
