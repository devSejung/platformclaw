/**
 * Process-local registry that lets Talk protocol methods resolve opaque
 * `sessionId` values to the concrete relay or managed-room backend.
 */
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { formatError } from "./server-utils.js";

type TalkConnectionCleanupKind = "realtime-relay" | "transcription-relay" | "client" | "creation";
type TalkConnectionCleanup = () => void | Promise<void>;
type TalkConnectionCreation = { active: boolean };

export type UnifiedTalkSessionRecord =
  | {
      kind: "realtime-relay";
      connId: string;
      relaySessionId: string;
    }
  | {
      kind: "transcription-relay";
      connId: string;
      transcriptionSessionId: string;
    }
  | {
      kind: "managed-room";
      handoffId: string;
      token: string;
      roomId: string;
    };

const unifiedTalkSessions = resolveGlobalMap<string, UnifiedTalkSessionRecord>(
  Symbol.for("openclaw.unifiedTalkSessions"),
  "close-and-restart",
);
const talkConnectionCleanups = resolveGlobalMap<
  string,
  Map<TalkConnectionCleanupKind, TalkConnectionCleanup>
>(Symbol.for("openclaw.talkConnectionCleanups"), "close-and-restart");
const pendingTalkCreations = resolveGlobalMap<string, Set<TalkConnectionCreation>>(
  Symbol.for("openclaw.pendingTalkCreations"),
  "close-and-restart",
);

/**
 * Keeps one owner cleanup per relay kind until the connection closes.
 * Replacing by kind stays bounded while the owner cleanup scans all live sessions.
 */
export function registerTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: TalkConnectionCleanup,
): void {
  const cleanups =
    talkConnectionCleanups.get(connId) ??
    new Map<TalkConnectionCleanupKind, TalkConnectionCleanup>();
  cleanups.set(kind, cleanup);
  talkConnectionCleanups.set(connId, cleanups);
}

/** Fence asynchronous creation planning until the concrete session owns connection cleanup. */
export async function withTalkConnectionCreation<T>(
  connId: string,
  create: (assertActive: () => void) => Promise<T>,
): Promise<T> {
  const creations = pendingTalkCreations.get(connId) ?? new Set<TalkConnectionCreation>();
  const creation = { active: true };
  creations.add(creation);
  pendingTalkCreations.set(connId, creations);
  registerTalkConnectionCleanup(connId, "creation", () => {
    pendingTalkCreations.delete(connId);
    for (const pending of creations) {
      pending.active = false;
    }
  });
  try {
    return await create(() => {
      if (!creation.active) {
        throw new Error("Talk connection closed during session creation");
      }
    });
  } finally {
    creation.active = false;
    creations.delete(creation);
    if (!creations.size && pendingTalkCreations.get(connId) === creations) {
      pendingTalkCreations.delete(connId);
      const cleanups = talkConnectionCleanups.get(connId);
      cleanups?.delete("creation");
      if (!cleanups?.size) {
        talkConnectionCleanups.delete(connId);
      }
    }
  }
}

/** Runs and forgets every Talk cleanup owned by a disconnected gateway connection. */
export async function cleanupTalkConnection(
  connId: string,
  log: { warn: (message: string) => void },
): Promise<void> {
  const cleanups = talkConnectionCleanups.get(connId);
  if (!cleanups) {
    return;
  }
  // Delete first so cleanup failures or re-entrancy cannot retain stale connection owners.
  talkConnectionCleanups.delete(connId);
  const pending: Promise<void>[] = [];
  const recordFailure = (kind: TalkConnectionCleanupKind, error: unknown) => {
    log.warn(
      `failed to run ${kind} Talk cleanup after connection disconnect: ${formatError(error)}`,
    );
  };
  // Invoke every owner before awaiting so each connection fence takes effect immediately.
  for (const [kind, cleanup] of cleanups) {
    try {
      pending.push(
        Promise.resolve(cleanup()).catch((error: unknown) => recordFailure(kind, error)),
      );
    } catch (error) {
      recordFailure(kind, error);
    }
  }
  await Promise.all(pending);
}

/** Associates a public Talk session id with its concrete gateway backend. */
export function rememberUnifiedTalkSession(
  sessionId: string,
  session: UnifiedTalkSessionRecord,
): void {
  unifiedTalkSessions.set(sessionId, session);
}

/** Resolves a Talk session id or throws the protocol-facing unknown-session error. */
export function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord {
  const session = unifiedTalkSessions.get(sessionId);
  if (!session) {
    throw new Error("Unknown Talk session");
  }
  return session;
}

/** Removes a Talk session id after the concrete backend closes. */
export function forgetUnifiedTalkSession(sessionId: string): void {
  unifiedTalkSessions.delete(sessionId);
}

/** Enforces that a relay-backed Talk session is controlled by its owner socket. */
export function requireUnifiedTalkSessionConn(
  session: Extract<UnifiedTalkSessionRecord, { connId: string }>,
  connId: string | undefined,
): string {
  if (!connId || session.connId !== connId) {
    throw new Error("Talk session is not owned by this connection");
  }
  return connId;
}
