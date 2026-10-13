import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { FsSafeErrorCode } from "@openclaw/fs-safe/errors";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import type {
  SessionUploadOutcome,
  SessionUploadWorkerMessage,
  SessionUploadWorkerRequest,
  SessionUploadWorkerTarget,
} from "./sessions-files-upload-target.js";

const MAX_SESSION_UPLOAD_WORKERS = 2;
const SESSION_UPLOAD_TIMEOUT_MS = 30_000;
let activeUploads = 0;

export class SessionUploadWorkerError extends Error {
  constructor(
    readonly code: FsSafeErrorCode,
    readonly outcome: SessionUploadOutcome,
  ) {
    super(
      outcome === "unknown"
        ? "Upload outcome is unknown; refresh before retrying"
        : "Upload was not written",
    );
    this.name = "SessionUploadWorkerError";
  }
}

function resolveSessionUploadWorkerUrl(): URL {
  const currentPath = fileURLToPath(import.meta.url);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const marker = "/dist/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    return pathToFileURL(
      path.join(
        currentPath.slice(0, index + marker.length),
        "gateway",
        "server-methods",
        "sessions-files-upload.worker.js",
      ),
    );
  }
  return new URL(
    `./sessions-files-upload.worker${path.extname(currentPath) || ".js"}`,
    import.meta.url,
  );
}

export type SessionFileUploadLease = {
  run(params: {
    target: SessionUploadWorkerTarget;
    bytes: Uint8Array;
    assertCurrent(): void;
    signal?: AbortSignal;
  }): Promise<void>;
  release(): void;
};

/** Reserve before decoding or async filesystem discovery; never queue upload buffers. */
export function acquireSessionFileUploadLease(): SessionFileUploadLease | undefined {
  if (activeUploads >= MAX_SESSION_UPLOAD_WORKERS) {
    return undefined;
  }
  activeUploads += 1;
  let owner: "caller" | "worker" | "released" = "caller";
  const release = () => {
    if (owner !== "released") {
      owner = "released";
      activeUploads -= 1;
    }
  };
  return {
    release: () => {
      if (owner === "caller") {
        release();
      }
    },
    async run(params) {
      if (
        owner !== "caller" ||
        params.bytes.byteLength > MAX_TERMINAL_UPLOAD_BYTES ||
        params.signal?.aborted
      ) {
        throw new SessionUploadWorkerError("helper-unavailable", "not-written");
      }
      const workerUrl = resolveSessionUploadWorkerUrl();
      const execArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
      let worker: Worker;
      try {
        worker = new Worker(workerUrl, {
          workerData: params.target,
          execArgv,
          env: { ...process.env },
          // fs-safe's native addon opens raw fds and its finally closes them;
          // Node's unmanaged tracker only knows fs.open/fs.close-owned fds.
          // FileHandle tracking is separate. Native cleanup requires natural exit.
          trackUnmanagedFds: false,
        });
      } catch {
        throw new SessionUploadWorkerError("helper-unavailable", "not-written");
      }
      owner = "worker";
      // Native operations own fds and cleanup. Never terminate a running worker;
      // even an uncertain timeout occupies its slot until a real exit is observed.
      worker.once("exit", release);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let sent = false;
        let written = false;
        const finish = (error?: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          params.signal?.removeEventListener("abort", abort);
          if (error === undefined) {
            resolve();
          } else {
            reject(
              error instanceof Error
                ? error
                : new Error("Workspace upload failed", { cause: error }),
            );
          }
        };
        const cancel = () => {
          if (sent) {
            return;
          }
          try {
            // Node Worker.postMessage has no browser targetOrigin argument.
            // oxlint-disable-next-line unicorn/require-post-message-target-origin
            worker.postMessage({ type: "cancel" } satisfies SessionUploadWorkerRequest);
          } catch {
            /* Worker failure/exit still owns slot release. */
          }
        };
        const abort = () => {
          cancel();
          finish(new SessionUploadWorkerError("helper-failed", sent ? "unknown" : "not-written"));
        };
        const timer = setTimeout(abort, SESSION_UPLOAD_TIMEOUT_MS);
        params.signal?.addEventListener("abort", abort, { once: true });
        worker.on("message", (message: SessionUploadWorkerMessage) => {
          if (settled) {
            return;
          }
          if (message.type === "ready") {
            if (sent) {
              abort();
              return;
            }
            try {
              params.assertCurrent();
              // An in-process abort can fire synchronously inside this callback.
              if (settled) {
                return;
              }
              const bytes = Uint8Array.from(params.bytes);
              // Transfer one exact owned ArrayBuffer; Buffer pools and shared memory never cross.
              worker.postMessage({ type: "write", bytes } satisfies SessionUploadWorkerRequest, [
                bytes.buffer,
              ]);
              sent = true;
            } catch (error) {
              cancel();
              finish(error);
            }
          } else if (message.type === "written") {
            if (!sent) {
              abort();
              return;
            }
            written = true;
          } else {
            finish(new SessionUploadWorkerError(message.code, message.outcome));
          }
        });
        worker.once("error", () =>
          finish(
            new SessionUploadWorkerError("helper-unavailable", sent ? "unknown" : "not-written"),
          ),
        );
        worker.once("exit", (code) => {
          finish(
            code === 0 && written
              ? undefined
              : new SessionUploadWorkerError("helper-failed", sent ? "unknown" : "not-written"),
          );
          worker.removeAllListeners();
        });
        if (params.signal?.aborted) {
          abort();
        }
      });
    },
  };
}
