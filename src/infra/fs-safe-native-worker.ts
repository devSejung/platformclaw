// Isolated workers may require native filesystem safety without changing the host policy.
import { isMainThread } from "node:worker_threads";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

export function requireFsSafeNativeInWorker(): void {
  if (isMainThread) {
    throw new Error("Native filesystem policy override requires an isolated worker");
  }
  configureFsSafeNative({ mode: "require" });
}
