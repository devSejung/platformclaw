import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import type {
  SessionTranscriptSubstringParams,
  SessionTranscriptSubstringResult,
} from "./session-transcript-search.js";

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (result: SessionTranscriptSubstringResult) => void;
    reject: (error: Error) => void;
  }
>();

function searchWorkerUrl(): URL {
  const currentPath = fileURLToPath(import.meta.url);
  const distMarker = "/dist/";
  const distIndex = currentPath.replaceAll(path.sep, "/").lastIndexOf(distMarker);
  if (distIndex >= 0) {
    return pathToFileURL(
      path.join(
        currentPath.slice(0, distIndex + distMarker.length),
        "config",
        "sessions",
        "session-transcript-search.worker.js",
      ),
    );
  }
  return new URL(`./session-transcript-search.worker${path.extname(currentPath)}`, import.meta.url);
}

function getSearchWorker(): Worker {
  if (worker) {
    return worker;
  }
  const url = searchWorkerUrl();
  const current = new Worker(url, {
    execArgv: url.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined,
  });
  worker = current;
  const fail = (error: Error) => {
    if (worker !== current) {
      return;
    }
    worker = undefined;
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
    void current.terminate();
  };
  current.on(
    "message",
    (message: { id: number; result?: SessionTranscriptSubstringResult; error?: string }) => {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.result) {
        request?.resolve(message.result);
      } else {
        request?.reject(new Error(message.error ?? "Session search failed"));
      }
      if (pending.size === 0) {
        current.unref();
      }
    },
  );
  current.once("error", fail);
  current.once("exit", (code) => fail(new Error(`Session search worker exited with code ${code}`)));
  current.unref();
  return current;
}

/** One warm, bounded worker keeps literal scans away from the Gateway event loop. */
export async function searchSessionTranscriptSubstrings(
  params: SessionTranscriptSubstringParams,
): Promise<SessionTranscriptSubstringResult> {
  if (pending.size >= 32) {
    throw new Error("Session search is busy. Try again shortly.");
  }
  const current = getSearchWorker();
  const id = ++nextId;
  const result = await new Promise<SessionTranscriptSubstringResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    current.ref();
    // Node Worker.postMessage has a transfer list, not the browser targetOrigin contract.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    current.postMessage({ id, params });
  });
  if (result.indexing) {
    startSessionTranscriptIndexReconcile({
      agentId: params.agentId,
      ...(params.env ? { env: params.env } : {}),
      ...(params.storePath
        ? {
            path: resolveSqliteTargetFromSessionStorePath(params.storePath, {
              agentId: params.agentId,
            }).path,
          }
        : {}),
    });
  }
  return result;
}
