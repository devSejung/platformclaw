/** Close/reset path for ACP runtime sessions and persisted manager metadata. */
import {
  identityHasStableSessionId,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import { toAcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import {
  discardPersistedManagerRuntimeState,
  isRecoverableManagerAcpxExitError,
  tryPrepareFreshManagerRuntimeSession,
} from "./manager.runtime-resume-state.js";
import type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpSessionManagerDeps,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { requireReadySessionMeta, resolveAcpSessionResolutionError } from "./manager.utils.js";

/** Closes an ACP session runtime handle and optionally discards persistent state/meta. */
export async function runManagerCloseSession(params: {
  input: AcpCloseSessionInput;
  sessionKey: string;
  deps: Pick<AcpSessionManagerDeps, "getRuntimeBackend">;
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
}): Promise<AcpCloseSessionResult> {
  const { input, sessionKey } = params;
  if (input.onRetired && !input.retainClosedMeta) {
    throw new Error("retirement cleanup requires retained ACP identity");
  }
  if (input.retainClosedMeta && (input.clearMeta || input.cacheOnly)) {
    throw new Error("retained ACP retirement cannot clear metadata or be cache-only");
  }
  if (input.cacheOnly === true) {
    if (input.clearMeta === true) {
      throw new Error("cache-only ACP retirement cannot clear persisted session metadata");
    }
    const runtimeClosed = await params.runtimeHandles.close({
      sessionKey,
      reason: input.reason,
      ...(input.discardPersistentState ? { discardPersistentState: true } : {}),
      ...(input.expectedHandle ? { expectedHandle: input.expectedHandle } : {}),
      throwOnError: true,
    });
    return {
      runtimeClosed,
      metaCleared: false,
    };
  }

  const resolution = params.resolveSession({
    cfg: input.cfg,
    sessionKey,
  });
  const resolutionError = resolveAcpSessionResolutionError(resolution);
  if (resolutionError) {
    if (input.requireAcpSession ?? true) {
      throw resolutionError;
    }
    return {
      runtimeClosed: false,
      metaCleared: false,
    };
  }
  const meta = requireReadySessionMeta(resolution);
  if (
    input.expectedLifecycleRevision &&
    resolution.kind === "ready" &&
    resolution.entry?.lifecycleRevision !== input.expectedLifecycleRevision
  ) {
    return { runtimeClosed: false, metaCleared: false };
  }
  const currentIdentity = resolveSessionIdentityFromMeta(meta);
  const shouldSkipRuntimeClose =
    meta.state === "closed" ||
    (input.discardPersistentState &&
      currentIdentity != null &&
      !identityHasStableSessionId(currentIdentity));

  let runtimeClosed = false;
  let runtimeNotice: string | undefined;
  if (shouldSkipRuntimeClose) {
    if (input.discardPersistentState) {
      await tryPrepareFreshManagerRuntimeSession({
        deps: params.deps,
        cfg: input.cfg,
        meta,
        sessionKey,
        logPrefix: "acp close fast-reset",
      });
    }
    params.runtimeHandles.clear(sessionKey);
  } else {
    try {
      const { runtime: ensuredRuntime, handle } = await params.ensureRuntimeHandle({
        cfg: input.cfg,
        sessionKey,
        meta,
      });
      await withAcpRuntimeErrorBoundary({
        run: async () =>
          await ensuredRuntime.close({
            handle,
            reason: input.reason,
            discardPersistentState: input.discardPersistentState,
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
      runtimeClosed = true;
      params.runtimeHandles.clear(sessionKey);
    } catch (error) {
      const acpError = toAcpRuntimeError({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP close failed before completion.",
      });
      if (
        input.allowBackendUnavailable &&
        (acpError.code === "ACP_BACKEND_MISSING" ||
          acpError.code === "ACP_BACKEND_UNAVAILABLE" ||
          (input.discardPersistentState && acpError.code === "ACP_SESSION_INIT_FAILED") ||
          (input.discardPersistentState && acpError.code === "ACP_BACKEND_UNSUPPORTED_CONTROL") ||
          isRecoverableManagerAcpxExitError(acpError.message))
      ) {
        if (input.discardPersistentState) {
          await tryPrepareFreshManagerRuntimeSession({
            deps: params.deps,
            cfg: input.cfg,
            meta,
            sessionKey,
            logPrefix: "acp close recovery",
            missingBackendError: acpError,
          });
        }
        // Treat unavailable backends as terminal for this cached handle so it
        // cannot continue counting against maxConcurrentSessions.
        params.runtimeHandles.clear(sessionKey);
        runtimeNotice = acpError.message;
      } else {
        throw acpError;
      }
    }
  }

  let metaCleared = false;
  if (
    input.discardPersistentState &&
    !input.clearMeta &&
    !input.retainClosedMeta &&
    meta.state !== "closed"
  ) {
    await discardPersistedManagerRuntimeState({
      cfg: input.cfg,
      sessionKey,
      writeSessionMeta: params.writeSessionMeta,
    });
  }

  if (input.retainClosedMeta) {
    // The actor lock owns both process retirement and its durable classification.
    // A separate maintenance write could otherwise close a replacement lifecycle.
    await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      mutate: (current) => (current ? { ...current, state: "closed" } : undefined),
      failOnError: true,
    });
    // Binding IDs may be reused by a replacement conversation. Finish route
    // cleanup before releasing the actor to the next initialize operation.
    await input.onRetired?.();
  }

  if (input.clearMeta) {
    await params.writeSessionMeta({
      cfg: input.cfg,
      sessionKey,
      mutate: (_current, entry) => {
        if (!entry) {
          return null;
        }
        return null;
      },
      failOnError: true,
    });
    metaCleared = true;
  }

  return {
    runtimeClosed,
    runtimeNotice,
    metaCleared,
  };
}
