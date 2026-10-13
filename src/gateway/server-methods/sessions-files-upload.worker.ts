import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { MAX_TERMINAL_UPLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { requireFsSafeNativeInWorker } from "../../infra/fs-safe-native-worker.js";
import { FsSafeError, root, type Root } from "../../infra/fs-safe.js";
import {
  MAX_SESSION_UPLOAD_NAME_BYTES,
  verifySessionUploadFolder,
  verifySessionUploadRoot,
  type SessionUploadWorkerMessage,
  type SessionUploadWorkerRequest,
  type SessionUploadWorkerTarget,
} from "./sessions-files-upload-target.js";

if (!parentPort) {
  throw new Error("Workspace upload requires an isolated worker");
}
const port = parentPort;
const target = workerData as SessionUploadWorkerTarget;
let workspace: Root | undefined;
let destination: Root | undefined;
let cancelled = false;
let started = false;

// This module is loaded only in a Worker with its own module state and copied
// environment. Main-process fs-safe policy remains unchanged.
requireFsSafeNativeInWorker();

function report(message: SessionUploadWorkerMessage): void {
  // Node MessagePort is not the browser Window API and has no targetOrigin.
  port.postMessage(message);
}

function fail(error: unknown, mayHaveWritten: boolean): void {
  const code = error instanceof FsSafeError ? error.code : "helper-failed";
  const noWrite = !mayHaveWritten || code === "already-exists" || code === "helper-unavailable";
  report({ type: "failed", code, outcome: noWrite ? "not-written" : "unknown" });
  port.close();
}

async function prepare(): Promise<void> {
  if (
    Buffer.byteLength(path.posix.basename(target.relativePath), "utf8") >
    MAX_SESSION_UPLOAD_NAME_BYTES
  ) {
    throw new FsSafeError("invalid-path", "Upload file name is too long");
  }
  const prepared = await root(target.rootReal, { symlinks: "reject", hardlinks: "reject" });
  await verifySessionUploadRoot(prepared, target);
  const folder = path.posix.dirname(target.relativePath);
  await verifySessionUploadFolder(prepared, folder === "." ? "" : folder);
  const destinationPath = path.resolve(
    prepared.rootReal,
    ...(folder === "." ? [] : folder.split("/")),
  );
  if (target.destination.rootReal !== destinationPath) {
    throw new FsSafeError("path-mismatch", "Upload destination does not match the selected folder");
  }
  const preparedDestination =
    folder === "."
      ? prepared
      : await root(destinationPath, { symlinks: "reject", hardlinks: "reject" });
  if (preparedDestination.rootReal !== destinationPath) {
    throw new FsSafeError("path-mismatch", "Upload folder is an alias");
  }
  await verifySessionUploadRoot(preparedDestination, target.destination);
  await verifySessionUploadRoot(prepared, target);
  if (cancelled) {
    return;
  }
  workspace = prepared;
  destination = preparedDestination;
  report({ type: "ready" });
}

async function write(bytes: Uint8Array): Promise<void> {
  let mayHaveWritten = false;
  try {
    if (
      !workspace ||
      !destination ||
      !(bytes instanceof Uint8Array) ||
      !(bytes.buffer instanceof ArrayBuffer) ||
      bytes.byteLength !== target.size ||
      bytes.byteLength > MAX_TERMINAL_UPLOAD_BYTES
    ) {
      throw new FsSafeError("too-large", "Workspace upload payload is invalid");
    }
    await verifySessionUploadRoot(workspace, target);
    const folder = path.posix.dirname(target.relativePath);
    await verifySessionUploadFolder(workspace, folder === "." ? "" : folder);
    await verifySessionUploadRoot(destination, target.destination);
    if (cancelled) {
      port.close();
      return;
    }
    // Require mode fails before mutation if the native addon cannot load.
    // Once creation starts, cancellation must let native finally cleanup run.
    mayHaveWritten = true;
    // Preserve this prepared Root: native create fences its opened root fd
    // against the initial selected-folder identity before creating the temp file.
    await destination.create(path.posix.basename(target.relativePath), Buffer.from(bytes), {
      mkdir: false,
      mode: 0o600,
    });
    report({ type: "written" });
    port.close();
  } catch (error) {
    fail(error, mayHaveWritten);
  }
}

port.on("message", (message: SessionUploadWorkerRequest) => {
  if (message.type === "cancel") {
    cancelled = true;
    if (!started) {
      port.close();
    }
    return;
  }
  if (started || !workspace || cancelled) {
    fail(new FsSafeError("invalid-path", "Workspace upload was not admitted"), false);
    return;
  }
  started = true;
  void write(message.bytes);
});

void prepare().catch((error: unknown) => fail(error, false));
