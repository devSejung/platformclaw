import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { registerTalkConnectionCleanup } from "./talk-session-registry.js";
import { formatForLog } from "./ws-log.js";

/** One native transport, including a replacement being prepared for the same call. */
export class TalkClientSessionOwner {
  private accepting = true;
  private cancelProvider: (() => Promise<void>) | undefined;
  private canceling: Promise<void> | undefined;
  private serverHeld = false;

  attachCancellation(cancel: () => Promise<void>): void {
    this.cancelProvider = cancel;
  }

  get isClosing(): boolean {
    return !this.accepting;
  }
  get hasCancellation(): boolean {
    return this.cancelProvider !== undefined;
  }

  get holdsServerResource(): boolean {
    return this.serverHeld;
  }

  /** The concrete provider calls this immediately before allocating native resources. */
  serverSessionStarting(): void {
    this.assertAccepting();
    const pending = [...pendingTransports].find((entry) => entry.owner === this);
    if (pending?.callKey) {
      assertServerCallCapacity(pending.callKey, this);
    }
    this.serverHeld = true;
  }

  /** A provider terminal notification is authority to release its exact handle. */
  notifyClosed(): void {
    this.stopAdmissions();
    releaseNativeOwner(this);
  }

  assertAccepting(): void {
    if (!this.accepting) {
      throw new Error("Realtime browser voice session is closed");
    }
  }

  stopAdmissions(): void {
    this.accepting = false;
  }

  async cancel(): Promise<void> {
    this.stopAdmissions();
    if (!this.canceling && this.cancelProvider) {
      const cancel = this.cancelProvider;
      this.canceling = Promise.resolve()
        .then(cancel)
        .catch((error: unknown) => {
          this.canceling = undefined;
          throw error;
        });
    }
    if (this.canceling) {
      await this.canceling;
      this.notifyClosed();
    }
  }

  consultSignal(providerSignal?: AbortSignal): {
    signal: AbortSignal;
    markStarted: () => void;
    cleanup: () => void;
  } {
    this.assertAccepting();
    const controller = new AbortController();
    let started = false;
    const onAbort = () => {
      // Closing a voice transport stops new work, while already admitted runs
      // keep confirmation/effect capture and finish under their run authority.
      if (this.accepting || !started) {
        controller.abort(providerSignal?.reason);
      }
    };
    if (providerSignal?.aborted) {
      onAbort();
    } else {
      providerSignal?.addEventListener("abort", onAbort, { once: true });
    }
    return {
      signal: controller.signal,
      markStarted: () => {
        this.assertAccepting();
        started = true;
      },
      cleanup: () => providerSignal?.removeEventListener("abort", onAbort),
    };
  }
}

type NativeTransport = {
  owner: TalkClientSessionOwner;
  connId?: string;
  closing?: boolean;
  callKey?: string;
};
type NativeCall = {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  transports: Set<NativeTransport>;
  accepting: boolean;
  closeRecord: () => Promise<void>;
  warn: (message: string) => void;
  recordClosing?: Promise<void>;
  recordClosed?: boolean;
  recordConnId?: string;
  recordHasServerTransport?: boolean;
};
const nativeCalls = new Map<string, NativeCall>();
const pendingTransports = new Set<NativeTransport>();
// Includes candidates and failed cancellations: no live handle is evicted for admission.
const MAX_NATIVE_TALK_HANDLES = 64;
const MAX_PENDING_NATIVE_TALK_HANDLES = 16;
const MAX_NATIVE_TALK_HANDLES_PER_CALL = 2;

function releaseNativeOwner(owner: TalkClientSessionOwner): void {
  for (const pending of pendingTransports) {
    if (pending.owner === owner) {
      pendingTransports.delete(pending);
    }
  }
  for (const [callKey, call] of nativeCalls) {
    for (const transport of call.transports) {
      if (transport.owner === owner) {
        call.transports.delete(transport);
      }
    }
    if (!call.transports.size && (call.accepting || call.recordClosed)) {
      nativeCalls.delete(callKey);
    }
  }
}

function nativeHandleCount(): number {
  return (
    pendingTransports.size +
    [...nativeCalls.values()].reduce((count, call) => count + Math.max(1, call.transports.size), 0)
  );
}

function assertCallAdmission(callKey: string, owner?: TalkClientSessionOwner): void {
  const call = nativeCalls.get(callKey);
  const pending = [...pendingTransports].filter(
    (entry) => entry.callKey === callKey && entry.owner !== owner,
  );
  if (
    (call && (!call.accepting || [...call.transports].some((entry) => entry.closing))) ||
    pending.some((entry) => entry.owner.isClosing)
  ) {
    throw new Error("Native Talk cleanup is incomplete; close this voice call before reconnecting");
  }
}

function assertServerCallCapacity(callKey: string, owner?: TalkClientSessionOwner): void {
  assertCallAdmission(callKey, owner);
  const call = nativeCalls.get(callKey);
  const pending = [...pendingTransports].filter(
    (entry) =>
      entry.callKey === callKey && entry.owner !== owner && entry.owner.holdsServerResource,
  );
  if ((call?.transports.size ?? 0) + pending.length >= MAX_NATIVE_TALK_HANDLES_PER_CALL) {
    throw new Error(
      "This voice call already has a replacement transport; wait for it to finish or close the call",
    );
  }
}
function key(agentId: string, voiceSessionId: string): string {
  return `${agentId}\0${voiceSessionId}`;
}

function registerConnection(connId: string, warn: (message: string) => void): void {
  registerTalkConnectionCleanup(connId, "client", () =>
    closeTalkClientSessionsForConnection(connId).catch((error: unknown) => {
      warn(`native Talk connection cleanup failed: ${formatForLog(error)}`);
    }),
  );
}

/** Fence creates that finish after their Gateway connection has already closed. */
export async function createOwnedTalkClientSession<T>(params: {
  owner: TalkClientSessionOwner;
  connId?: string;
  warn: (message: string) => void;
  create: () => Promise<T>;
  cancel: (session: T) => Promise<void>;
  resume?: { agentId: string; voiceSessionId: string };
}): Promise<T> {
  if (
    nativeHandleCount() >= MAX_NATIVE_TALK_HANDLES ||
    pendingTransports.size >= MAX_PENDING_NATIVE_TALK_HANDLES
  ) {
    throw new Error("Too many native Talk transports; close a voice call and try again");
  }
  const callKey = params.resume
    ? key(params.resume.agentId, params.resume.voiceSessionId)
    : undefined;
  if (callKey) {
    assertCallAdmission(callKey);
  }
  const pending = { owner: params.owner, connId: params.connId, callKey };
  pendingTransports.add(pending);
  if (params.connId) {
    registerConnection(params.connId, params.warn);
  }
  try {
    const session = await params.create();
    params.owner.attachCancellation(async () => await params.cancel(session));
    try {
      params.owner.assertAccepting();
    } catch (error) {
      await params.owner.cancel();
      throw error;
    }
    return session;
  } catch (error) {
    params.owner.stopAdmissions();
    // A failed provider cancellation remains owned and counted for explicit retry.
    if (!params.owner.hasCancellation) {
      pendingTransports.delete(pending);
    }
    throw error;
  }
}

/** Retain the provider-owned cancellation boundary until call or connection close. */
export function retainTalkClientSession(
  params: Omit<
    NativeCall,
    | "transports"
    | "accepting"
    | "recordClosing"
    | "recordClosed"
    | "recordConnId"
    | "recordHasServerTransport"
  > & {
    owner: TalkClientSessionOwner;
    connId?: string;
  },
): void {
  params.owner.assertAccepting();
  const callKey = key(params.agentId, params.voiceSessionId);
  const pending = [...pendingTransports].find((entry) => entry.owner === params.owner);
  const existing = nativeCalls.get(callKey);
  assertCallAdmission(callKey, params.owner);
  if (existing && existing.sessionKey !== params.sessionKey) {
    throw new Error("Voice session owner changed");
  }
  if (!params.owner.holdsServerResource) {
    // Pure browser credentials leave no provider resource to retain. The durable
    // logical record still gates transcripts, tool calls, and explicit close.
    if (pending) {
      pendingTransports.delete(pending);
    }
    if (existing) {
      existing.recordHasServerTransport = false;
      existing.recordConnId = params.connId;
    }
    return;
  }
  assertServerCallCapacity(callKey, params.owner);
  if (!pending && nativeHandleCount() >= MAX_NATIVE_TALK_HANDLES) {
    throw new Error("Too many native Talk transports; close a voice call and try again");
  }
  if (existing && !existing.accepting) {
    throw new Error("Realtime browser voice session is closing");
  }
  const call: NativeCall = existing ?? {
    ...params,
    accepting: true,
    transports: new Set<NativeTransport>(),
  };
  call.recordConnId = params.connId;
  call.recordHasServerTransport = true;
  call.transports.add({ owner: params.owner, connId: params.connId });
  nativeCalls.set(callKey, call);
  if (pending) {
    pendingTransports.delete(pending);
  }
  if (params.connId) {
    registerConnection(params.connId, params.warn);
  }
}

function closeRecordOnce(call: NativeCall): Promise<void> {
  if (!call.recordClosing) {
    call.recordClosing = Promise.resolve().then(async () => {
      try {
        await call.closeRecord();
        call.recordClosed = true;
      } catch (error) {
        call.recordClosing = undefined;
        throw error;
      }
    });
  }
  return call.recordClosing;
}

async function closeTransports(
  call: NativeCall,
  transports: NativeTransport[],
  closeRecord: boolean,
): Promise<void> {
  // Fence every callback synchronously before durable close or provider awaits.
  for (const transport of transports) {
    transport.closing = true;
    transport.owner.stopAdmissions();
  }
  const shouldCloseRecord =
    closeRecord ||
    (call.recordHasServerTransport === true &&
      [...call.transports].every((transport) => transport.closing));
  if (shouldCloseRecord) {
    call.accepting = false;
  }
  const results = await Promise.allSettled([
    ...(shouldCloseRecord ? [closeRecordOnce(call)] : []),
    ...transports.map(async (transport) => {
      await transport.owner.cancel();
      call.transports.delete(transport);
    }),
  ]);
  if (!call.transports.size && (call.accepting || call.recordClosed)) {
    nativeCalls.delete(key(call.agentId, call.voiceSessionId));
  }
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) {
    throw new AggregateError(errors, "Native Talk session cleanup failed");
  }
}

/** Close all native transports for the exact logical call, preserving run policy. */
export async function closeTalkClientSession(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  closeRecord: () => Promise<void>;
}): Promise<void> {
  const call = nativeCalls.get(key(params.agentId, params.voiceSessionId));
  if (!call) {
    await params.closeRecord();
    return;
  }
  if (call.sessionKey !== params.sessionKey) {
    throw new Error("Voice session owner changed");
  }
  call.closeRecord = params.closeRecord;
  await closeTransports(call, [...call.transports], true);
}

/** Connection cleanup also owns calls that never reached an explicit client close. */
async function closeTalkClientSessionsForConnection(connId: string): Promise<void> {
  const work: Promise<void>[] = [];
  for (const pending of pendingTransports) {
    if (pending.connId === connId) {
      work.push(pending.owner.cancel());
    }
  }
  for (const call of nativeCalls.values()) {
    const transports = [...call.transports].filter((transport) => transport.connId === connId);
    if (transports.length) {
      work.push(
        closeTransports(
          call,
          transports,
          call.recordHasServerTransport === true && transports.length === call.transports.size,
        ),
      );
    } else if (!call.accepting && !call.transports.size && call.recordConnId === connId) {
      work.push(closeTransports(call, [], true));
    }
  }
  const results = await Promise.allSettled(work);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) {
    throw new AggregateError(errors, "Native Talk connection cleanup failed");
  }
}

export function hasOwnedActiveTalkClientRun(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  clientConnId?: string;
  sessionKey: string;
}): boolean {
  // Browser steering is only allowed for the connection that owns the live
  // browser session; agent-owned consult runs use the relay steering path.
  const connId = normalizeOptionalString(params.clientConnId);
  const sessionKey = params.sessionKey.trim();
  if (!connId || !sessionKey) {
    return false;
  }
  for (const entry of params.context.chatAbortControllers.values()) {
    if (entry.sessionKey === sessionKey && entry.ownerConnId === connId && entry.kind !== "agent") {
      return true;
    }
  }
  return false;
}
