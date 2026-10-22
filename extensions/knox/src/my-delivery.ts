import { createHash } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { KnoxIngressLifecycle } from "./ingress.js";
import { KnoxOutboundError, sendKnoxOutbound } from "./outbound.js";
import {
  KnoxRoutingClient,
  knoxRequestFingerprint,
  type KnoxRouteResolution,
} from "./routing-client.js";
import { getKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

const NAMESPACE = "my-requests-v2";
const MAX_REQUESTS = 1_000;
type State = "admitted" | "executing" | "result-ready" | "delivered" | "partial" | "unknown";
type MyMessage = Extract<KnoxInboundMessage, { schemaVersion: 2 }>;
type KnoxMyResult = {
  text: string;
  status: "final" | "error" | "timeout";
  requestId?: string;
};
type StoredResult = KnoxMyResult & { requestId: string };
type RequestRecord = {
  version: 2;
  message: MyMessage;
  fingerprint: string;
  route: KnoxRouteResolution;
  result?: StoredResult;
  resultIds?: string[];
};
type RequestMetadata = {
  version: 2;
  accountId: string;
  messageId: string;
  state: State;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  notificationSent?: boolean;
  settled?: boolean;
};
type DeliveryState = Pick<PluginRuntime["state"], "openBlobStore" | "withLease">;
type RequestScope = {
  finish: (result: KnoxMyResult) => Promise<void>;
  validate: () => Promise<void>;
  abortSignal: AbortSignal;
};

class KnoxMyAuthorizationError extends Error {
  constructor() {
    super("Knox personal Space request is no longer authorized");
    this.name = "KnoxMyAuthorizationError";
  }
}

const FAILURE_TEXT =
  "개인 Space 요청을 처리할 수 없습니다. 방 연결과 본인의 Space 실행 권한을 확인해 주세요.";
const UNKNOWN_TEXT =
  "개인 실행의 완료 여부를 확인할 수 없습니다. 작업을 자동 재실행하지 않았습니다. Space 개인방에서 확인해 주세요.";
const TIMEOUT_TEXT =
  "개인 실행이 제한 시간 내에 완료되지 않았습니다. Space 개인방에서 상태를 확인해 주세요.";

/** Owns crash-safe result delivery independently of the ingress execution claim. */
export function createKnoxMyDelivery(options: {
  account: ResolvedKnoxAccount;
  state?: DeliveryState;
  routingClient?: Pick<KnoxRoutingClient, "resolve">;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  abortSignal?: AbortSignal;
  log?: { warn?: (message: string) => void };
}) {
  const now = options.now ?? Date.now;
  const state = () => options.state ?? getKnoxRuntime().state;
  // Host blob storage commits metadata and bytes together in the shared SQLite DB.
  // Keyed JSON values are capped at 64KiB, smaller than a full inbound plus result.
  const openStore = () =>
    state().openBlobStore<RequestMetadata>({
      namespace: NAMESPACE,
      maxEntries: MAX_REQUESTS,
      maxBytesPerEntry: 1024 * 1024,
      maxBytesPerNamespace: 64 * 1024 * 1024,
      overflowPolicy: "reject-new",
    });
  let store: ReturnType<typeof openStore> | undefined;
  const storage = () => (store ??= openStore());
  const routing =
    options.routingClient ??
    new KnoxRoutingClient(
      { url: options.account.controlPlaneUrl, token: options.account.serviceToken },
      options.fetchImpl,
    );
  const keyFor = (messageId: string) =>
    createHash("sha256")
      .update(JSON.stringify([options.account.accountId, messageId]))
      .digest("hex");
  const encode = (record: RequestRecord) => Buffer.from(JSON.stringify(record), "utf8");
  const decode = (bytes: Uint8Array): RequestRecord => {
    const record = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as RequestRecord;
    if (
      record.version !== 2 ||
      record.message?.schemaVersion !== 2 ||
      record.message.executionMode !== "self_in_space" ||
      record.fingerprint !== knoxRequestFingerprint(record.message)
    ) {
      throw new Error("Stored Knox personal request requires quarantine");
    }
    return record;
  };
  const requestParams = (record: RequestRecord) => ({
    accountId: options.account.accountId,
    conversationType: "room" as const,
    conversationId: record.message.conversation.conversationId,
    knoxUserId: record.message.sender.knoxUserId,
    executionMode: "self_in_space" as const,
    requestId: record.message.messageId,
    requestFingerprint: record.fingerprint,
    admissionId:
      record.route.status === "resolved"
        ? record.route.selfInSpace?.admissionId
        : record.route.admissionId,
  });
  const validate = async (record: RequestRecord, phase: "execute" | "publish") => {
    const current = await routing.resolve({
      ...requestParams(record),
      operation: "validate",
      phase,
    });
    const original = record.route;
    if (
      current.status !== "resolved" ||
      original.status !== "resolved" ||
      !current.selfInSpace ||
      !original.selfInSpace ||
      current.agentId !== original.agentId ||
      current.sessionKey !== original.sessionKey ||
      current.executionTarget !== original.executionTarget ||
      current.selfInSpace.admissionId !== original.selfInSpace.admissionId ||
      current.selfInSpace.userId !== original.selfInSpace.userId ||
      current.selfInSpace.bindingId !== original.selfInSpace.bindingId ||
      current.selfInSpace.bindingGeneration !== original.selfInSpace.bindingGeneration ||
      current.selfInSpace.spaceId !== original.selfInSpace.spaceId ||
      current.selfInSpace.pageId !== original.selfInSpace.pageId ||
      current.selfInSpace.conversationId !== original.selfInSpace.conversationId ||
      current.selfInSpace.targetRevision !== original.selfInSpace.targetRevision
    ) {
      throw new KnoxMyAuthorizationError();
    }
  };
  const settle = async (record: RequestRecord) => {
    await routing.resolve({
      ...requestParams(record),
      operation: "settle",
      outcome: record.result?.status === "final" ? "finished" : "failed",
    });
  };
  const warning = (key: string, outcome: string) =>
    options.log?.warn?.(`knox.my.delivery ${outcome} reference=${key.slice(0, 12)}`);

  const save = async (key: string, record: RequestRecord, metadata: RequestMetadata) =>
    storage().register(
      key,
      encode(record),
      { ...metadata, updatedAt: now() },
      metadata.state === "delivered" && metadata.settled && metadata.notificationSent
        ? { ttlMs: 30 * 24 * 60 * 60 * 1000 }
        : undefined,
    );

  const publish = async (
    key: string,
    record: RequestRecord,
    metadata: RequestMetadata,
    assertOwned: () => void,
    abortSignal: AbortSignal,
  ) => {
    if (!record.result || (metadata.state === "unknown" && metadata.notificationSent)) {
      return;
    }
    if (record.result.status === "final") {
      try {
        await validate(record, "publish");
      } catch (error) {
        if (!(error instanceof KnoxMyAuthorizationError)) {
          throw error; // Infrastructure failure cannot authorize disclosure or discard the saved answer.
        }
        record.result = {
          status: "error",
          text: FAILURE_TEXT,
          requestId: `my-revoked:${record.message.messageId}`,
        };
        assertOwned();
        await save(key, record, metadata);
      }
    }
    abortSignal.throwIfAborted();
    assertOwned();
    const route = record.route;
    try {
      await sendKnoxOutbound({
        context: {
          account: options.account,
          inbound: record.message,
          agentId: route.status === "resolved" ? route.agentId : "platformclaw",
          sessionKey: route.status === "resolved" ? route.sessionKey : "",
          runId:
            route.status === "resolved" && route.selfInSpace
              ? `knox-my:${route.selfInSpace.admissionId}`
              : `knox-my:${record.message.messageId}`,
        },
        status: record.result.status,
        text: `[개인 Agent]\n${record.result.text}`,
        final: true,
        requestId: record.result.requestId,
        fetchImpl: options.fetchImpl,
        abortSignal,
      });
      assertOwned();
      metadata.state = metadata.state === "unknown" ? "unknown" : "delivered";
      metadata.notificationSent = true;
      await save(key, record, metadata);
    } catch (error) {
      assertOwned();
      metadata.attempts += 1;
      if (error instanceof KnoxOutboundError && (!error.retryable || error.deliveryOutcome)) {
        metadata.state = error.deliveryOutcome === "partial" ? "partial" : "unknown";
        metadata.notificationSent = true;
        warning(key, metadata.state);
      } else {
        // Reuse the same stored payload and requestId even after an ambiguous timeout.
        // CDEP durable idempotency is an enablement prerequisite, never assumed live proof.
        metadata.nextAttemptAt =
          now() + Math.min(300_000, 1_000 * 2 ** Math.min(metadata.attempts, 8));
        warning(key, "retry-pending");
      }
      await save(key, record, metadata);
      return;
    }
    try {
      await settle(record);
      metadata.settled = true;
      assertOwned();
      await save(key, record, metadata);
    } catch {
      warning(key, "settlement-pending");
    }
  };

  const admit = async (message: KnoxInboundMessage, route: KnoxRouteResolution) => {
    if (message.schemaVersion !== 2) {
      throw new Error("Knox personal delivery accepts only v2 requests");
    }
    const key = keyFor(message.messageId);
    // Only fully delivered and settled answers are expendable. Active, partial,
    // and unknown requests remain protected even when their quota is exhausted.
    // The control-plane receipt and ingress tombstone still prevent execution replay.
    const entries = await storage().entries();
    let count = entries.length;
    let bytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
    if (count >= MAX_REQUESTS - 1 || bytes >= 48 * 1024 * 1024) {
      for (const entry of entries.toSorted((a, b) => a.createdAt - b.createdAt)) {
        if (count < MAX_REQUESTS / 2 && bytes < 32 * 1024 * 1024) {
          break;
        }
        const metadata = entry.metadata;
        if (metadata?.state !== "delivered" || !metadata.settled || !metadata.notificationSent) {
          continue;
        }
        await storage().delete(entry.key);
        count -= 1;
        bytes -= entry.sizeBytes;
      }
    }
    const record: RequestRecord = {
      version: 2,
      message,
      fingerprint: knoxRequestFingerprint(message),
      route,
    };
    const metadata: RequestMetadata = {
      version: 2,
      accountId: options.account.accountId,
      messageId: message.messageId,
      state: "admitted",
      updatedAt: now(),
      attempts: 0,
      nextAttemptAt: 0,
    };
    await storage().registerIfAbsent(key, encode(record), metadata);
    const existing = await storage().lookup(key);
    if (!existing || decode(existing.bytes).fingerprint !== record.fingerprint) {
      throw new Error("Knox message identity conflicts with an admitted personal request");
    }
  };

  const withRequest = async (params: {
    message: KnoxInboundMessage;
    route: KnoxRouteResolution;
    lifecycle: KnoxIngressLifecycle;
    run(scope: RequestScope): Promise<void>;
  }) => {
    const key = keyFor(params.message.messageId);
    await state().withLease(
      {
        namespace: NAMESPACE,
        key,
        database: { scope: "shared" },
        leaseMs: 30_000,
        waitMs: 1000,
        signal: options.abortSignal
          ? AbortSignal.any([params.lifecycle.abortSignal, options.abortSignal])
          : params.lifecycle.abortSignal,
      },
      async (lease) => {
        const assertOwned = () => lease.assertOwned();
        const entry = await storage().lookup(key);
        if (!entry) {
          throw new Error("Knox personal request has no durable admission");
        }
        const record = decode(entry.bytes);
        const metadata = entry.metadata as RequestMetadata;
        if (record.fingerprint !== knoxRequestFingerprint(params.message)) {
          throw new Error("Knox personal request identity changed");
        }
        const commit = async () => {
          assertOwned();
          await save(key, record, metadata);
        };
        if (
          metadata.state === "delivered" ||
          metadata.state === "partial" ||
          metadata.state === "unknown"
        ) {
          if (metadata.state === "unknown" && !metadata.notificationSent) {
            await publish(key, record, metadata, assertOwned, lease.signal);
          }
          if (!metadata.settled) {
            await settle(record);
            metadata.settled = true;
            await commit();
          }
          await params.lifecycle.onAdopted();
          return;
        }
        if (metadata.state === "result-ready") {
          await publish(key, record, metadata, assertOwned, lease.signal);
          await params.lifecycle.onAdopted();
          return;
        }
        if (metadata.state === "executing") {
          // A host lease proves the previous executor is gone. Its external side effects
          // may have happened: retain an unknown outcome and never launch the VM again.
          metadata.state = "unknown";
          record.result = {
            text: UNKNOWN_TEXT,
            status: "error",
            requestId: `my-unknown:${record.message.messageId}`,
          };
          await commit();
          await publish(key, record, metadata, assertOwned, lease.signal);
          await params.lifecycle.onAdopted();
          return;
        }
        if (record.route.status !== "resolved" || !record.route.selfInSpace) {
          metadata.state = "result-ready";
          record.result = {
            text: FAILURE_TEXT,
            status: "error",
            requestId: `my-error:${record.message.messageId}`,
          };
          await commit();
          await publish(key, record, metadata, assertOwned, lease.signal);
          await params.lifecycle.onAdopted();
          return;
        }
        const finish = async (result: KnoxMyResult) => {
          const identity = createHash("sha256").update(JSON.stringify(result)).digest("hex");
          if (record.resultIds?.includes(identity)) {
            return;
          }
          record.resultIds = [...(record.resultIds ?? []), identity];
          const prior = record.result;
          const status = prior && prior.status !== "final" ? prior.status : result.status;
          // Native finalizers may emit several payloads. Capture every fragment and
          // publish one combined answer only after the originating turn settles.
          record.result = {
            status,
            text:
              status === "final"
                ? [prior?.text, result.text].filter(Boolean).join("\n\n")
                : status === "timeout"
                  ? TIMEOUT_TEXT
                  : FAILURE_TEXT,
            requestId: `my-final:${record.message.messageId}`,
          };
          const executing = metadata.state === "executing";
          if (!executing) {
            metadata.state = "result-ready";
          }
          await commit();
          if (!executing) {
            await publish(key, record, metadata, assertOwned, lease.signal);
          }
        };
        try {
          await validate(record, "execute");
        } catch (error) {
          if (!(error instanceof KnoxMyAuthorizationError)) {
            throw error;
          }
          await finish({ text: FAILURE_TEXT, status: "error" });
          await params.lifecycle.onAdopted();
          return;
        }
        metadata.state = "executing";
        await commit();
        try {
          await params.run({
            finish,
            validate: async () => {
              lease.signal.throwIfAborted();
              await validate(record, "execute");
              assertOwned();
            },
            abortSignal: lease.signal,
          });
        } catch (error) {
          if (lease.signal.aborted) {
            throw error;
          }
          // A failed execution is recorded once; delivery recovery cannot re-execute it.
          await finish({ text: FAILURE_TEXT, status: "error" });
        }
        if (!record.result) {
          metadata.state = "unknown";
          record.result = {
            text: UNKNOWN_TEXT,
            status: "error",
            requestId: `my-unknown:${record.message.messageId}`,
          };
        } else {
          metadata.state = "result-ready";
        }
        await commit();
        await publish(key, record, metadata, assertOwned, lease.signal);
      },
    );
  };

  const recover = async () => {
    if (options.abortSignal?.aborted) {
      return;
    }
    const entries = await storage().entries();
    for (const info of entries) {
      const metadata = info.metadata as RequestMetadata;
      if (
        metadata.version !== 2 ||
        metadata.accountId !== options.account.accountId ||
        metadata.state === "admitted" ||
        (metadata.settled && metadata.notificationSent) ||
        metadata.nextAttemptAt > now()
      ) {
        continue;
      }
      try {
        const entry = await storage().lookup(info.key);
        if (!entry) {
          continue;
        }
        const record = decode(entry.bytes);
        await withRequest({
          message: record.message,
          route: record.route,
          lifecycle: {
            abortSignal: options.abortSignal ?? new AbortController().signal,
            onAdopted: async () => {},
            onDeferred: () => {},
            onAbandoned: async () => {},
          } as KnoxIngressLifecycle,
          run: async () => {
            throw new Error("Recovery cannot execute a personal request");
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "PLUGIN_STATE_LEASE_TIMEOUT") {
          warning(info.key, "recovery-pending");
        }
      }
    }
  };
  return { admit, withRequest, recover };
}
