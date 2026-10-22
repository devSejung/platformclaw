import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginBlobStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
  withPluginStateLeaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveKnoxAccount } from "./accounts.js";
import {
  createKnoxInboundIdentityGuard,
  KnoxInboundIdentityConflictError,
} from "./inbound-identity.js";
import type { KnoxIngressLifecycle } from "./ingress.js";
import { createKnoxMyDelivery } from "./my-delivery.js";
import { KnoxRoutingClient, type KnoxRouteResolution } from "./routing-client.js";
import type { KnoxInboundMessage } from "./types.js";

const message = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/self-in-space.json", import.meta.url), "utf8"),
) as Extract<KnoxInboundMessage, { schemaVersion: 2 }>;
const route: KnoxRouteResolution = {
  status: "resolved",
  agentId: "personal-a",
  sessionKey: "agent:personal-a:space:registered",
  senderLinked: true,
  executionTarget: "assigned_vm",
  selfInSpace: {
    admissionId: "admission-a",
    requestId: message.messageId,
    userId: "user-a",
    spaceId: "space-a",
    pageId: "page-a",
    bindingId: "binding-a",
    bindingGeneration: 1,
    conversationId: "conversation-a",
    targetRevision: 3,
    senderAttribution: {
      id: message.sender.knoxUserId,
      profileId: "user-a",
      agentId: "personal-a",
    },
  },
};
const lifecycleFixture = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/lifecycle.json", import.meta.url), "utf8"),
) as {
  postAcceptanceFailure: { status: string; final: boolean; text: string };
  revoked: { status: string; requestIdPrefix: string };
  interrupted: { status: string; text: string };
};
let directory: string;
let clock = 100_000;
const servers: Array<ReturnType<typeof createServer>> = [];
type RunScope = Parameters<
  Parameters<ReturnType<typeof createKnoxMyDelivery>["withRequest"]>[0]["run"]
>[0];
const state: Pick<PluginRuntime["state"], "openBlobStore" | "openKeyedStore" | "withLease"> = {
  openBlobStore: <T>(options: Parameters<PluginRuntime["state"]["openBlobStore"]>[0]) =>
    createPluginBlobStoreForTests<T>("knox", options, process.env),
  openKeyedStore: <T>(options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0]) =>
    createPluginStateKeyedStoreForTests<T>("knox", { ...options, env: process.env }),
  withLease: (options, run) => withPluginStateLeaseForTests("knox", options, run),
};
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "knox-my-delivery-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  clock = 100_000;
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  resetPluginBlobStoreForTests();
  resetPluginStateStoreForTests();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function lifecycle(): KnoxIngressLifecycle {
  return {
    admission: "exclusive",
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onAbandoned: vi.fn(),
  };
}
async function harness(responses: Array<{ status: number; body: unknown; loseAck?: boolean }>) {
  const sent: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    void (async () => {
      expect(req.headers.authorization).toBe(`Bearer ${"s".repeat(32)}`);
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
      }
      sent.push(JSON.parse(body));
      const response = responses[Math.min(sent.length - 1, responses.length - 1)]!;
      if (response.loseAck) {
        req.socket.destroy();
        return;
      }
      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response.body));
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock CDEP failed to bind");
  }
  const account = resolveKnoxAccount({
    channels: {
      knox: {
        selfInSpaceEnabled: true,
        webhookSecret: "w".repeat(32),
        serviceToken: "s".repeat(32),
        outboundUrl: `http://127.0.0.1:${address.port}/outbound`,
        controlPlaneUrl: "http://control.test/route",
      },
    },
  });
  let current: KnoxRouteResolution = route;
  const resolve = vi.fn(async (params: Parameters<KnoxRoutingClient["resolve"]>[0]) =>
    params.operation === "settle"
      ? { status: "request-settled" as const, admissionId: "admission-a" }
      : current,
  );
  const options = { account, state, routingClient: { resolve }, now: () => clock };
  return {
    sent,
    options,
    resolve,
    revoke: () => {
      current = { status: "request-revoked", admissionId: "admission-a" };
    },
  };
}
const success = { status: 200, body: { ok: true, messageId: "delivery-a" } };
const retry = { status: 503, body: { ok: false, errorCode: "TEMPORARY", retryable: true } };

describe("Knox personal result delivery through SQLite and mock CDEP", () => {
  it("persists every final fragment and sends once after the turn finishes", async () => {
    const h = await harness([success]);
    const coordinator = createKnoxMyDelivery(h.options);
    await coordinator.admit(message, route);
    await coordinator.withRequest({
      message,
      route,
      lifecycle: lifecycle(),
      run: async ({ finish }) => {
        await finish({ text: "first answer", status: "final", requestId: "part-a" });
        await finish({ text: "first answer", status: "final", requestId: "part-a" });
        await finish({ text: "second answer", status: "final", requestId: "part-b" });
        expect(h.sent).toHaveLength(0);
        expect(h.resolve.mock.calls.some(([params]) => params.operation === "settle")).toBe(false);
      },
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toBe("[개인 Agent]\nfirst answer\n\nsecond answer");
    expect(h.sent[0]!.requestId).toBe(`my-final:${message.messageId}`);
  });

  it("retries an ACK-lost delivery with the exact persisted request without rerunning", async () => {
    const h = await harness([{ ...success, loseAck: true }, success]);
    const coordinator = createKnoxMyDelivery(h.options);
    const execute = vi.fn(async ({ finish }: RunScope) =>
      finish({ text: "accepted before connection closed", status: "final" }),
    );
    await coordinator.admit(message, route);
    await coordinator.withRequest({ message, route, lifecycle: lifecycle(), run: execute });
    expect(h.sent).toHaveLength(1);
    resetPluginBlobStoreForTests();
    clock += 5000;
    await createKnoxMyDelivery(h.options).recover();
    expect(execute).toHaveBeenCalledOnce();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual(h.sent[0]);
  });

  it("serializes concurrent claims for the same request", async () => {
    const h = await harness([success]);
    const coordinator = createKnoxMyDelivery(h.options);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const execute = vi.fn(async ({ finish }: RunScope) => {
      entered.resolve();
      await release.promise;
      await finish({ text: "one execution", status: "final" });
    });
    await coordinator.admit(message, route);
    const first = coordinator.withRequest({ message, route, lifecycle: lifecycle(), run: execute });
    await entered.promise;
    const duplicate = coordinator.withRequest({
      message,
      route,
      lifecycle: lifecycle(),
      run: execute,
    });
    release.resolve();
    await Promise.all([first, duplicate]);
    expect(execute).toHaveBeenCalledOnce();
    expect(h.sent).toHaveLength(1);
  });

  it("fences shutdown before publication and recovers without re-execution", async () => {
    const h = await harness([success]);
    const abort = new AbortController();
    const coordinator = createKnoxMyDelivery({ ...h.options, abortSignal: abort.signal });
    await coordinator.admit(message, route);
    await expect(
      coordinator.withRequest({
        message,
        route,
        lifecycle: lifecycle(),
        run: async ({ finish, abortSignal }) => {
          await finish({ text: "unfinished turn", status: "final" });
          abort.abort(new Error("account stopped"));
          abortSignal.throwIfAborted();
        },
      }),
    ).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
    const execute = vi.fn();
    await createKnoxMyDelivery(h.options).withRequest({
      message,
      route,
      lifecycle: lifecycle(),
      run: execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(h.sent[0]!.text).toContain("자동 재실행하지 않았습니다");
  });

  it("recovers a persisted final after reopening SQLite without executing the VM again", async () => {
    const h = await harness([retry, success]);
    const execute = vi.fn(
      async ({ finish }: RunScope) => await finish({ text: "saved answer", status: "final" }),
    );
    const first = createKnoxMyDelivery(h.options);
    await first.admit(message, route);
    await first.withRequest({ message, route, lifecycle: lifecycle(), run: execute });
    expect(execute).toHaveBeenCalledOnce();
    expect(h.sent).toHaveLength(1);
    resetPluginBlobStoreForTests();
    clock += 5000;
    await createKnoxMyDelivery({
      ...h.options,
      account: { ...h.options.account, selfInSpaceEnabled: false },
    }).recover();
    expect(execute).toHaveBeenCalledOnce();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({
      text: "[개인 Agent]\nsaved answer",
      conversationType: "room",
      chatroomId: message.conversation.conversationId,
      agentId: "personal-a",
      runId: "knox-my:admission-a",
      requestId: h.sent[0]!.requestId,
    });
    const again = createKnoxMyDelivery(h.options);
    await again.withRequest({ message, route, lifecycle: lifecycle(), run: execute });
    expect(execute).toHaveBeenCalledOnce();
    expect(h.sent).toHaveLength(2);
  });

  it("does not resend a partial delivery even when CDEP reports HTTP 502", async () => {
    const h = await harness([
      {
        status: 502,
        body: {
          ok: false,
          errorCode: "KNOX_PARTIAL_DELIVERY",
          retryable: false,
          message: "first chunk sent, second chunk failed",
        },
      },
    ]);
    const coordinator = createKnoxMyDelivery(h.options);
    await coordinator.admit(message, route);
    await coordinator.withRequest({
      message,
      route,
      lifecycle: lifecycle(),
      run: async ({ finish }) => await finish({ text: "two chunks", status: "final" }),
    });
    resetPluginBlobStoreForTests();
    clock += 5000;
    await createKnoxMyDelivery(h.options).recover();
    expect(h.sent).toHaveLength(1);
    expect(h.resolve.mock.calls.some(([params]) => params.operation === "settle")).toBe(true);
    const blobs = state.openBlobStore({
      namespace: "my-requests-v2",
      maxEntries: 1000,
      maxBytesPerEntry: 1024 * 1024,
      maxBytesPerNamespace: 64 * 1024 * 1024,
      overflowPolicy: "reject-new",
    });
    expect((await blobs.entries())[0]!.expiresAt).toBeUndefined();
  });

  it("replaces a saved private result with a safe notice when permission is revoked", async () => {
    const h = await harness([retry, success]);
    const coordinator = createKnoxMyDelivery(h.options);
    await coordinator.admit(message, route);
    await coordinator.withRequest({
      message,
      route,
      lifecycle: lifecycle(),
      run: async ({ finish }) =>
        await finish({ text: "private result from the VM", status: "final" }),
    });
    h.revoke();
    clock += 5000;
    await createKnoxMyDelivery(h.options).recover();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.status).toBe(lifecycleFixture.revoked.status);
    expect(h.sent[1]!.text).not.toContain("private result");
    expect(h.sent[1]!.requestId).toBe(
      `${lifecycleFixture.revoked.requestIdPrefix}${message.messageId}`,
    );
  });

  it("quarantines an interrupted executor and never invokes a new VM run", async () => {
    const h = await harness([success]);
    const coordinator = createKnoxMyDelivery(h.options);
    await coordinator.admit(message, route);
    const blob = state.openBlobStore({
      namespace: "my-requests-v2",
      maxEntries: 1000,
      maxBytesPerEntry: 1024 * 1024,
      maxBytesPerNamespace: 64 * 1024 * 1024,
      overflowPolicy: "reject-new",
    });
    const info = (await blob.entries())[0]!;
    const stored = await blob.lookup(info.key);
    if (!stored) {
      throw new Error("missing admitted request");
    }
    await blob.register(info.key, stored.bytes, {
      ...(info.metadata as object),
      state: "executing",
    });
    resetPluginBlobStoreForTests();
    const execute = vi.fn();
    await createKnoxMyDelivery(h.options).withRequest({
      message,
      route,
      lifecycle: lifecycle(),
      run: execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.status).toBe("error");
    expect(h.sent[0]).toMatchObject(lifecycleFixture.interrupted);
    await createKnoxMyDelivery(h.options).recover();
    expect(h.sent).toHaveLength(1);
  });

  it("persists a result larger than the keyed JSON store limit", async () => {
    const h = await harness([success]);
    const coordinator = createKnoxMyDelivery(h.options);
    await coordinator.admit(message, route);
    const text = "answer ".repeat(12000);
    await coordinator.withRequest({
      message,
      route,
      lifecycle: lifecycle(),
      run: async ({ finish }) => await finish({ text, status: "final" }),
    });
    expect(h.sent[0]!.text).toBe(`[개인 Agent]\n${text}`);
  });

  it("compacts completed results at capacity while retaining unresolved work", async () => {
    const h = await harness([success]);
    const blob = state.openBlobStore({
      namespace: "my-requests-v2",
      maxEntries: 1000,
      maxBytesPerEntry: 1024 * 1024,
      maxBytesPerNamespace: 64 * 1024 * 1024,
      overflowPolicy: "reject-new",
    });
    for (let index = 0; index < 999; index += 1) {
      await blob.register(`receipt-${index}`, Buffer.from("{}"), {
        version: 2,
        accountId: "default",
        messageId: `old-${index}`,
        state:
          index === 0
            ? "admitted"
            : index === 1
              ? "partial"
              : index === 2
                ? "unknown"
                : "delivered",
        updatedAt: clock,
        attempts: 0,
        nextAttemptAt: 0,
        notificationSent: true,
        settled: true,
      });
    }
    await createKnoxMyDelivery(h.options).admit(message, route);
    expect((await blob.entries()).length).toBeLessThan(1000);
    for (const key of ["receipt-0", "receipt-1", "receipt-2"]) {
      expect(await blob.lookup(key)).toBeDefined();
    }
    expect(await blob.lookup("receipt-3")).toBeUndefined();
  });

  it("sends accepted product failures without starting a personal agent", async () => {
    const h = await harness([success]);
    const denied: KnoxRouteResolution = { status: "space-unavailable", admissionId: "denied-a" };
    const coordinator = createKnoxMyDelivery(h.options);
    const execute = vi.fn();
    await coordinator.admit(message, denied);
    await coordinator.withRequest({ message, route: denied, lifecycle: lifecycle(), run: execute });
    expect(execute).not.toHaveBeenCalled();
    expect(h.sent[0]).toMatchObject({
      ...lifecycleFixture.postAcceptanceFailure,
      conversationType: "room",
    });
    expect(h.sent[0]!.text).not.toContain("space-a");
  });
});

describe("one Knox transport identity across both execution queues", () => {
  it("retains mode and body identity across SQLite reopen while scoping by account", async () => {
    const hasLegacyReceipt = async () => false;
    const first = createKnoxInboundIdentityGuard({ state, hasLegacyReceipt });
    const { executionMode: _executionMode, ...common } = message;
    const v1: KnoxInboundMessage = { ...common, schemaVersion: 1 };
    await first.assertInboundIdentity(v1, "default");
    await first.assertInboundIdentity(v1, "default");
    resetPluginStateStoreForTests();
    const restored = createKnoxInboundIdentityGuard({ state, hasLegacyReceipt });
    await expect(restored.assertInboundIdentity(message, "default")).rejects.toBeInstanceOf(
      KnoxInboundIdentityConflictError,
    );
    await expect(
      restored.assertInboundIdentity(
        { ...v1, message: { type: "text", text: "changed" } },
        "default",
      ),
    ).rejects.toBeInstanceOf(KnoxInboundIdentityConflictError);
    await expect(
      restored.assertInboundIdentity(message, "another-account"),
    ).resolves.toBeUndefined();
  });
});
