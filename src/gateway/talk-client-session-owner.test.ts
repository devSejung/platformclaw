import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { cancelInternalRealtimeVoiceBrowserSession } from "../talk/provider-internal.js";
import {
  closeTalkClientSession,
  createOwnedTalkClientSession,
  retainTalkClientSession,
  TalkClientSessionOwner,
} from "./talk-client-session-owner.js";
import { cleanupTalkConnection } from "./talk-session-registry.js";

const call = { agentId: "main", sessionKey: "agent:main:voice", voiceSessionId: "native-voice" };
const warn = vi.fn();
function retain(
  owner: TalkClientSessionOwner,
  closeRecord: () => Promise<void>,
  connId = "native-owner",
) {
  owner.serverSessionStarting();
  retainTalkClientSession({ ...call, owner, closeRecord, connId, warn });
}

afterEach(async () => {
  await cleanupTalkConnection("native-owner", { warn });
  await cleanupTalkConnection("replacement-owner", { warn });
});

describe("native Talk transport ownership", () => {
  it("closes the retained real provider cancellation hook while preserving an admitted consult", async () => {
    const providerSignal = new AbortController();
    const cancelBrowserSession = vi.fn(() =>
      providerSignal.abort(new Error("native transport closed")),
    );
    const provider: RealtimeVoiceProviderPlugin = {
      id: "native-test",
      label: "Native Test",
      isConfigured: () => true,
      createBridge: () => {
        throw new Error("No relay bridge is involved");
      },
    };
    Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
      value: { isBrowserSessionConfigured: () => true, cancelBrowserSession },
    });
    const session = {
      provider: provider.id,
      transport: "webrtc" as const,
      clientSecret: "test-ephemeral",
    };
    const request = {
      agentId: "main",
      workspaceDir: "/tmp/test-voice",
      initialItems: [],
      providerConfig: {},
    };
    const owner = new TalkClientSessionOwner();
    owner.attachCancellation(
      async () => await cancelInternalRealtimeVoiceBrowserSession({ provider, request, session }),
    );
    const closeRecord = vi.fn(async () => undefined);
    retain(owner, closeRecord);
    const consult = owner.consultSignal(providerSignal.signal);
    consult.markStarted();
    await closeTalkClientSession({ ...call, closeRecord });
    expect(cancelBrowserSession).toHaveBeenCalledExactlyOnceWith(request, session);
    expect(closeRecord).toHaveBeenCalledOnce();
    expect(consult.signal.aborted).toBe(false);
    expect(() => owner.consultSignal()).toThrow("voice session is closed");
    consult.cleanup();
  });

  it("cancels a native create that resolves after its Gateway connection disconnects", async () => {
    const owner = new TalkClientSessionOwner();
    const cancel = vi.fn(async () => undefined);
    let resolve: ((session: { id: string }) => void) | undefined;
    const creating = createOwnedTalkClientSession({
      owner,
      connId: "native-owner",
      warn,
      create: async () =>
        await new Promise<{ id: string }>((done) => {
          resolve = done;
        }),
      cancel,
    });
    const disconnecting = cleanupTalkConnection("native-owner", { warn });
    expect(() => owner.assertAccepting()).toThrow("voice session is closed");
    resolve?.({ id: "pending-transport" });
    await expect(creating).rejects.toThrow("voice session is closed");
    await disconnecting;
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: "pending-transport" });
  });

  it("owns replacements independently until the logical call's last connection closes", async () => {
    const old = new TalkClientSessionOwner();
    const replacement = new TalkClientSessionOwner();
    const oldCancel = vi.fn(async () => undefined);
    const replacementCancel = vi.fn(async () => undefined);
    const closeRecord = vi.fn(async () => undefined);
    old.attachCancellation(oldCancel);
    replacement.attachCancellation(replacementCancel);
    retain(old, closeRecord);
    retain(replacement, closeRecord, "replacement-owner");
    await cleanupTalkConnection("unrelated-owner", { warn });
    expect(oldCancel).not.toHaveBeenCalled();
    await cleanupTalkConnection("native-owner", { warn });
    expect(oldCancel).toHaveBeenCalledOnce();
    expect(replacementCancel).not.toHaveBeenCalled();
    expect(closeRecord).not.toHaveBeenCalled();
    expect(() => replacement.assertAccepting()).not.toThrow();
    await cleanupTalkConnection("replacement-owner", { warn });
    expect(replacementCancel).toHaveBeenCalledOnce();
    expect(closeRecord).toHaveBeenCalledOnce();
  });

  it("keeps the connection fence active between provider creation and durable call adoption", async () => {
    const owner = new TalkClientSessionOwner();
    const cancel = vi.fn(async () => undefined);
    await createOwnedTalkClientSession({
      owner,
      connId: "native-owner",
      warn,
      create: async () => ({ id: "created" }),
      cancel,
    });
    const disconnecting = cleanupTalkConnection("native-owner", { warn });
    expect(() => retain(owner, async () => undefined)).toThrow("voice session is closed");
    await disconnecting;
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: "created" });
  });

  it("closes the logical call when replacement connections disconnect concurrently", async () => {
    const old = new TalkClientSessionOwner();
    const replacement = new TalkClientSessionOwner();
    let release: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    old.attachCancellation(async () => await stopped);
    replacement.attachCancellation(async () => await stopped);
    const closeRecord = vi.fn(async () => undefined);
    retain(old, closeRecord);
    retain(replacement, closeRecord, "replacement-owner");
    const first = cleanupTalkConnection("native-owner", { warn });
    const second = cleanupTalkConnection("replacement-owner", { warn });
    release?.();
    await Promise.all([first, second]);
    expect(closeRecord).toHaveBeenCalledOnce();
  });

  it("retains failed provider cleanup for an explicit retry with admissions already stopped", async () => {
    const owner = new TalkClientSessionOwner();
    const cancel = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("provider close failed"));
    const closeRecord = vi.fn(async () => undefined);
    owner.attachCancellation(cancel);
    retain(owner, closeRecord);
    await expect(closeTalkClientSession({ ...call, closeRecord })).rejects.toThrow(
      "cleanup failed",
    );
    expect(() => owner.assertAccepting()).toThrow("voice session is closed");
    const create = vi.fn(async () => ({}));
    await expect(
      createOwnedTalkClientSession({
        owner: new TalkClientSessionOwner(),
        connId: "native-owner",
        resume: call,
        warn,
        create,
        cancel: async () => undefined,
      }),
    ).rejects.toThrow("cleanup is incomplete");
    expect(create).not.toHaveBeenCalled();
    await closeTalkClientSession({ ...call, closeRecord });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("retires naturally closed transports across repeated resumes without interrupting the candidate", async () => {
    const closeRecord = vi.fn(async () => undefined);
    let current = new TalkClientSessionOwner();
    current.attachCancellation(async () => undefined);
    retain(current, closeRecord);
    for (let index = 0; index < 12; index++) {
      const candidate = new TalkClientSessionOwner();
      const cancel = vi.fn(async () => undefined);
      await createOwnedTalkClientSession({
        owner: candidate,
        connId: "native-owner",
        resume: call,
        warn,
        create: async () => ({ index }),
        cancel,
      });
      retain(candidate, closeRecord);
      expect(() => current.assertAccepting()).not.toThrow();
      const overflowCreate = vi.fn(async () => ({}));
      const overflowOwner = new TalkClientSessionOwner();
      await expect(
        createOwnedTalkClientSession({
          owner: overflowOwner,
          connId: "native-owner",
          resume: call,
          warn,
          create: async () => {
            overflowOwner.serverSessionStarting();
            return await overflowCreate();
          },
          cancel: async () => undefined,
        }),
      ).rejects.toThrow("already has a replacement");
      expect(overflowCreate).not.toHaveBeenCalled();
      current.notifyClosed();
      expect(() => candidate.assertAccepting()).not.toThrow();
      expect(cancel).not.toHaveBeenCalled();
      current = candidate;
    }
    expect(closeRecord).not.toHaveBeenCalled();
  });

  it("keeps the original usable when replacement startup fails and its provider closes", async () => {
    const original = new TalkClientSessionOwner();
    original.attachCancellation(async () => undefined);
    const closeRecord = vi.fn(async () => undefined);
    retain(original, closeRecord);
    const candidate = new TalkClientSessionOwner();
    await createOwnedTalkClientSession({
      owner: candidate,
      connId: "replacement-owner",
      resume: call,
      warn,
      create: async () => ({}),
      cancel: async () => undefined,
    });
    retain(candidate, closeRecord, "replacement-owner");
    candidate.notifyClosed();
    expect(() => original.assertAccepting()).not.toThrow();
    const retry = new TalkClientSessionOwner();
    await createOwnedTalkClientSession({
      owner: retry,
      connId: "replacement-owner",
      resume: call,
      warn,
      create: async () => ({}),
      cancel: async () => undefined,
    });
    retain(retry, closeRecord, "replacement-owner");
    expect(closeRecord).not.toHaveBeenCalled();
  });

  it("rejects global native handle overflow before calling a provider", async () => {
    for (let index = 0; index < 64; index++) {
      const owner = new TalkClientSessionOwner();
      owner.serverSessionStarting();
      owner.attachCancellation(async () => undefined);
      retainTalkClientSession({
        ...call,
        voiceSessionId: `bounded-${index}`,
        owner,
        closeRecord: async () => undefined,
        connId: "native-owner",
        warn,
      });
    }
    const create = vi.fn(async () => ({}));
    await expect(
      createOwnedTalkClientSession({
        owner: new TalkClientSessionOwner(),
        connId: "native-owner",
        warn,
        create,
        cancel: async () => undefined,
      }),
    ).rejects.toThrow("Too many native Talk transports");
    expect(create).not.toHaveBeenCalled();
  });

  it("retains a failed unadopted cancellation and rejects another resume until cleanup succeeds", async () => {
    const owner = new TalkClientSessionOwner();
    const cancel = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("pending cleanup failed"));
    await createOwnedTalkClientSession({
      owner,
      connId: "native-owner",
      resume: call,
      warn,
      create: async () => ({}),
      cancel,
    });
    await expect(owner.cancel()).rejects.toThrow("pending cleanup failed");
    const create = vi.fn(async () => ({}));
    await expect(
      createOwnedTalkClientSession({
        owner: new TalkClientSessionOwner(),
        connId: "native-owner",
        resume: call,
        warn,
        create,
        cancel: async () => undefined,
      }),
    ).rejects.toThrow("cleanup is incomplete");
    expect(create).not.toHaveBeenCalled();
    await owner.cancel();
    expect(cancel).toHaveBeenCalledTimes(2);
    const retry = new TalkClientSessionOwner();
    await createOwnedTalkClientSession({
      owner: retry,
      connId: "native-owner",
      resume: call,
      warn,
      create,
      cancel: async () => undefined,
    });
    retain(retry, async () => undefined);
    expect(create).toHaveBeenCalledOnce();
  });

  it("keeps failed durable close admission fenced until its idempotent retry completes", async () => {
    const owner = new TalkClientSessionOwner();
    const cancel = vi.fn(async () => undefined);
    owner.attachCancellation(cancel);
    const closeRecord = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("transcript still needs retry"));
    retain(owner, closeRecord);
    await expect(closeTalkClientSession({ ...call, closeRecord })).rejects.toThrow(
      "cleanup failed",
    );
    const create = vi.fn(async () => ({}));
    await expect(
      createOwnedTalkClientSession({
        owner: new TalkClientSessionOwner(),
        connId: "native-owner",
        resume: call,
        warn,
        create,
        cancel: async () => undefined,
      }),
    ).rejects.toThrow("cleanup is incomplete");
    expect(create).not.toHaveBeenCalled();
    await closeTalkClientSession({ ...call, closeRecord });
    expect(closeRecord).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps unresolved creates counted after disconnect and rejects pending overflow before provider effects", async () => {
    let resolve: (() => void) | undefined;
    const waiting = new Promise<void>((done) => {
      resolve = done;
    });
    const cancel = vi.fn(async () => undefined);
    const creating = Array.from({ length: 16 }, () =>
      createOwnedTalkClientSession({
        owner: new TalkClientSessionOwner(),
        connId: "native-owner",
        warn,
        create: async () => {
          await waiting;
          return {};
        },
        cancel,
      }),
    );
    const create = vi.fn(async () => ({}));
    await cleanupTalkConnection("native-owner", { warn });
    await expect(
      createOwnedTalkClientSession({
        owner: new TalkClientSessionOwner(),
        connId: "native-owner",
        warn,
        create,
        cancel,
      }),
    ).rejects.toThrow("Too many native Talk transports");
    expect(create).not.toHaveBeenCalled();
    resolve?.();
    const results = await Promise.allSettled(creating);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(16);
  });

  it("does not retain sequential browser-only credentials or interrupt an old candidate", async () => {
    const closeRecord = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const original = new TalkClientSessionOwner();
    for (let index = 0; index < 68; index++) {
      const owner = index === 0 ? original : new TalkClientSessionOwner();
      await createOwnedTalkClientSession({
        owner,
        connId: "native-owner",
        resume: call,
        warn,
        create: async () => ({ index }),
        cancel,
      });
      retainTalkClientSession({ ...call, owner, connId: "native-owner", closeRecord, warn });
    }
    expect(() => original.assertAccepting()).not.toThrow();
    expect(cancel).not.toHaveBeenCalled();
    expect(closeRecord).not.toHaveBeenCalled();
    await closeTalkClientSession({ ...call, closeRecord });
    expect(closeRecord).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not let an old server connection close a later pure browser replacement's logical call", async () => {
    const server = new TalkClientSessionOwner();
    const cancel = vi.fn(async () => undefined);
    const closeRecord = vi.fn(async () => undefined);
    server.attachCancellation(cancel);
    retain(server, closeRecord);
    const browser = new TalkClientSessionOwner();
    await createOwnedTalkClientSession({
      owner: browser,
      connId: "replacement-owner",
      resume: call,
      warn,
      create: async () => ({}),
      cancel: async () => undefined,
    });
    retainTalkClientSession({
      ...call,
      owner: browser,
      connId: "replacement-owner",
      closeRecord,
      warn,
    });
    await cleanupTalkConnection("native-owner", { warn });
    expect(cancel).toHaveBeenCalledOnce();
    expect(closeRecord).not.toHaveBeenCalled();
    expect(() => browser.assertAccepting()).not.toThrow();
    await closeTalkClientSession({ ...call, closeRecord });
    expect(closeRecord).toHaveBeenCalledOnce();
  });
});
