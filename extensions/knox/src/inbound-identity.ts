import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { knoxRequestFingerprint } from "./routing-client.js";
import { getKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage } from "./types.js";

export class KnoxInboundIdentityConflictError extends Error {
  constructor() {
    super("Knox message identity conflicts with an accepted request");
    this.name = "KnoxInboundIdentityConflictError";
  }
}

/** One transport identity spans ordinary and personal queues during rollout. */
export function createKnoxInboundIdentityGuard(
  options: {
    state?: Pick<PluginRuntime["state"], "openKeyedStore">;
    hasLegacyReceipt?: (messageId: string) => Promise<boolean>;
    hasPersonalReceipt?: (messageId: string) => Promise<boolean>;
  } = {},
) {
  const openStore = () =>
    (options.state ?? getKnoxRuntime().state).openKeyedStore<{ fingerprint: string }>({
      namespace: "inbound-identities",
      maxEntries: 40_000,
      // Native queues own durable cross-mode receipts; this bounded fingerprint
      // cache must not stop ordinary traffic when completed identities fill it.
      overflowPolicy: "evict-oldest",
      defaultTtlMs: 60 * 24 * 60 * 60 * 1000,
    });
  let store: ReturnType<typeof openStore> | undefined;
  const receipts = () => (store ??= openStore());
  const assertInboundIdentity = async (
    message: KnoxInboundMessage,
    accountId: string,
  ): Promise<void> => {
    if (message.schemaVersion === 2) {
      if (!options.hasLegacyReceipt) {
        throw new Error("Knox ingress receipt lookup is unavailable");
      }
      if (await options.hasLegacyReceipt(message.messageId)) {
        throw new KnoxInboundIdentityConflictError();
      }
    } else if (await options.hasPersonalReceipt?.(message.messageId)) {
      throw new KnoxInboundIdentityConflictError();
    }
    const key = createHash("sha256")
      .update(JSON.stringify([accountId, message.messageId]))
      .digest("hex");
    const fingerprint = knoxRequestFingerprint(message);
    await receipts().registerIfAbsent(key, { fingerprint });
    if ((await receipts().lookup(key))?.fingerprint !== fingerprint) {
      throw new KnoxInboundIdentityConflictError();
    }
  };
  return { assertInboundIdentity };
}
