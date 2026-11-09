/**
 * Shared local container-engine process execution and backend selection.
 */
import { createAbortError } from "../../infra/abort-signal.js";
import { toErrorObject } from "../../infra/errors.js";
import { isPlainCommandExitFailure, spawnCommand } from "../../process/exec.js";
import { DEFAULT_SANDBOX_IMAGE, SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

export type ExecContainerRawOptions = {
  allowFailure?: boolean;
  input?: Buffer | string;
  signal?: AbortSignal;
  maxBufferBytes?: number;
};

export type SandboxContainerEngine = {
  id: "docker" | "podman";
  command: "docker" | "podman";
  displayName: "Docker" | "Podman";
  globalArgs?: readonly string[];
};

export type SandboxContainerEngineTarget = {
  key: string;
  globalArgs: string[];
};

export const DOCKER_SANDBOX_ENGINE: SandboxContainerEngine = {
  id: "docker",
  command: "docker",
  displayName: "Docker",
};

export const PODMAN_SANDBOX_ENGINE: SandboxContainerEngine = {
  id: "podman",
  command: "podman",
  displayName: "Podman",
};

export type ExecDockerRawResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

type ExecDockerRawError = Error & {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
};

function missingContainerEngineMessage(engine: SandboxContainerEngine): string {
  if (engine.id === "docker") {
    return 'Sandbox mode requires Docker, but the "docker" command was not found in PATH. Install Docker (and ensure "docker" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing.';
  }
  return 'Sandbox mode requires Podman, but the "podman" command was not found in PATH. Install Podman (and ensure "podman" is available), choose another sandbox backend, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.';
}

export async function execContainerRaw(
  engine: SandboxContainerEngine,
  args: string[],
  opts?: ExecContainerRawOptions,
): Promise<ExecDockerRawResult> {
  if (
    opts?.maxBufferBytes !== undefined &&
    (!Number.isSafeInteger(opts.maxBufferBytes) || opts.maxBufferBytes < 1)
  ) {
    throw new RangeError("Container command maxBufferBytes must be a positive safe integer");
  }
  let result;
  try {
    result = await spawnCommand([engine.command, ...(engine.globalArgs ?? []), ...args], {
      cancelSignal: opts?.signal,
      encoding: "buffer",
      input: opts?.input ?? Buffer.alloc(0),
      maxBuffer: Math.min(
        SANDBOX_COMMAND_MAX_BUFFER_BYTES,
        opts?.maxBufferBytes ?? SANDBOX_COMMAND_MAX_BUFFER_BYTES,
      ),
      reject: false,
      stripFinalNewline: false,
    });
  } catch (error) {
    if (opts?.signal?.aborted) {
      throw createAbortError("Aborted");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(missingContainerEngineMessage(engine)), {
        code: "INVALID_CONFIG",
        cause: error,
      });
    }
    throw error;
  }
  if (opts?.signal?.aborted || result.isCanceled) {
    throw createAbortError("Aborted");
  }
  if (result.failed && !isPlainCommandExitFailure(result)) {
    if (result.code === "ENOENT") {
      throw Object.assign(new Error(missingContainerEngineMessage(engine)), {
        code: "INVALID_CONFIG",
        cause: result,
      });
    }
    throw toErrorObject(result, `${engine.displayName} command execution failed`);
  }
  const stdout = Buffer.from(result.stdout);
  const stderr = Buffer.from(result.stderr);
  const exitCode = result.exitCode ?? (result.failed ? 1 : 0);
  if (exitCode !== 0 && !opts?.allowFailure) {
    const message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
    const error: ExecDockerRawError = Object.assign(
      new Error(message || `${engine.displayName} command failed (exit ${exitCode})`),
      { code: exitCode, stdout, stderr },
    );
    throw error;
  }
  return { stdout, stderr, code: exitCode };
}

export async function execContainer(
  engine: SandboxContainerEngine,
  args: string[],
  opts?: ExecContainerRawOptions,
) {
  const result = await execContainerRaw(engine, args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}

const DOCKER_DAEMON_UNAVAILABLE_MARKERS = [
  "cannot connect to the docker daemon",
  "dial unix",
  "docker daemon is not running",
  "connection refused",
];

export function isDockerDaemonUnavailable(stderr: string): boolean {
  return DOCKER_DAEMON_UNAVAILABLE_MARKERS.some((marker) => stderr.toLowerCase().includes(marker));
}

export function formatDockerDaemonUnavailableError(stderr: string): string {
  const detail = stderr.trim();
  return [
    "Sandbox mode requires Docker, but the Docker daemon is not available.",
    "Start Docker, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.",
    detail ? `Docker said: ${detail}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

async function inspectContainerImage(
  engine: SandboxContainerEngine,
  image: string,
): Promise<"exists" | "missing"> {
  const result = await execContainer(engine, ["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return "exists";
  }
  const stderr = result.stderr.trim();
  const imageMissing =
    engine.id === "docker"
      ? stderr.toLowerCase().includes("no such image")
      : /no such image|image not known|image .* not found/iu.test(stderr);
  if (imageMissing) {
    return "missing";
  }
  if (engine.id === "docker" && isDockerDaemonUnavailable(stderr)) {
    throw new Error(formatDockerDaemonUnavailableError(stderr));
  }
  if (engine.id === "docker") {
    throw new Error(`Failed to inspect sandbox image: ${stderr}`);
  }
  throw new Error(`Failed to inspect sandbox image with ${engine.displayName}: ${stderr}`);
}

export async function ensureDockerImage(image: string) {
  await ensureContainerImage(DOCKER_SANDBOX_ENGINE, image);
}

export async function ensureContainerImage(engine: SandboxContainerEngine, image: string) {
  const imageState = await inspectContainerImage(engine, image);
  if (imageState === "exists") {
    return;
  }
  if (image === DEFAULT_SANDBOX_IMAGE) {
    if (engine.id === "docker") {
      throw new Error(
        `Sandbox image not found: ${image}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
      );
    }
    throw new Error(
      `Sandbox image not found in ${engine.displayName}: ${image}. Build it with podman build -t ${image} -f scripts/docker/sandbox/Dockerfile . before enabling container sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`,
    );
  }
  if (engine.id === "docker") {
    throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
  }
  throw new Error(
    `Sandbox image not found in ${engine.displayName}: ${image}. Build or pull it first.`,
  );
}
