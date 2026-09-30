import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import {
  type AuthProfileFailureReason,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
} from "../../auth-profiles.js";
import { isDtgptProvider } from "../../dtgpt-diagnostics.js";
import { buildApiErrorObservationFields } from "../../embedded-agent-error-observation.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { isConfigBackedInlineProviderApiKey, type ResolvedProviderAuth } from "../../model-auth.js";
import { log } from "../logger.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import {
  MAX_SAME_MODEL_RATE_LIMIT_RETRIES,
  resolveNextSameModelRateLimitRetryCount,
  resolveOverloadFailoverBackoffMs,
  resolveOverloadProfileRotationLimit,
  resolveRateLimitProfileRotationLimit,
  resolveSameModelRateLimitRetryDelayMs,
} from "./helpers.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;

export function createEmbeddedRunFailoverRetryController(input: {
  runParams: PreparedEmbeddedRunInput["runParams"];
  provider: string;
  modelId: string;
  globalLane: string;
  agentDir: string;
  fallbackConfigured: boolean;
  profileFailureStore: PreparedRuntime["profileFailureStore"];
  getLastProfileId: () => string | undefined;
  getSessionId: () => string;
  harnessOwnsTransport: () => boolean;
  getApiKeyInfo: () => ResolvedProviderAuth | null;
}) {
  const {
    runParams: params,
    provider,
    modelId,
    globalLane,
    agentDir,
    fallbackConfigured,
    profileFailureStore,
  } = input;
  const overloadFailoverBackoffMs = resolveOverloadFailoverBackoffMs();
  const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit();
  const rateLimitProfileRotationLimit = resolveRateLimitProfileRotationLimit();
  let rateLimitProfileRotations = 0;
  let consecutiveSameModelRateLimitRetries = 0;

  const sleepForRetry = async (delayMs: number) => {
    try {
      await sleepWithAbort(delayMs, params.abortSignal);
    } catch (error) {
      if (!params.abortSignal?.aborted) {
        throw error;
      }
      const abortError = new Error("Operation aborted", { cause: error });
      abortError.name = "AbortError";
      throw abortError;
    }
  };

  return {
    overloadProfileRotationLimit,
    rateLimitProfileRotationLimit,
    get rateLimitProfileRotations() {
      return rateLimitProfileRotations;
    },
    get consecutiveSameModelRateLimitRetries() {
      return consecutiveSameModelRateLimitRetries;
    },
    resetSameModelRateLimitRetries: () => {
      consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
        retriesSoFar: consecutiveSameModelRateLimitRetries,
        retriedSameModelRateLimit: false,
      });
    },
    maybeEscalateRateLimitProfileFallback: (paramsLocal: {
      failoverProvider: string;
      failoverModel: string;
      logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
    }) => {
      rateLimitProfileRotations += 1;
      if (rateLimitProfileRotations <= rateLimitProfileRotationLimit || !fallbackConfigured) {
        return;
      }
      const status = resolveFailoverStatus("rate_limit");
      log.warn(
        `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
      );
      paramsLocal.logFallbackDecision("fallback_model", { status });
      throw new FailoverError(
        "The AI service is temporarily rate-limited. Please try again in a moment.",
        {
          reason: "rate_limit",
          provider: paramsLocal.failoverProvider,
          model: paramsLocal.failoverModel,
          profileId: input.getLastProfileId(),
          sessionId: input.getSessionId(),
          lane: globalLane,
          status,
        },
      );
    },
    maybeMarkAuthProfileFailure: async (failure: {
      profileId?: string;
      reason?: AuthProfileFailureReason | null;
      modelId?: string;
      rawError?: string;
    }) => {
      if (params.authProfileStateMode === "read-only") {
        return;
      }
      const { profileId, reason } = failure;
      if (!reason) {
        return;
      }
      if (input.harnessOwnsTransport() && reason === "timeout") {
        return;
      }
      const observedError = buildApiErrorObservationFields(failure.rawError, { provider });
      const diagnostic =
        observedError.httpCode ||
        observedError.providerErrorType ||
        observedError.providerErrorMessagePreview ||
        observedError.rawErrorPreview ||
        observedError.rawErrorHash ||
        observedError.requestIdHash
          ? {
              httpCode: observedError.httpCode,
              errorType: observedError.providerErrorType,
              messagePreview: observedError.providerErrorMessagePreview,
              rawPreview: observedError.rawErrorPreview,
              rawHash: observedError.rawErrorHash,
              requestIdHash: observedError.requestIdHash,
            }
          : undefined;
      if (isDtgptProvider(provider)) {
        const detail = sanitizeForLog(
          observedError.providerErrorMessagePreview ?? observedError.rawErrorPreview ?? "unknown",
        );
        log.warn("dtgpt provider failure", {
          event: "dtgpt_provider_failure",
          tags: ["error_handling", "dtgpt", "provider_failure"],
          runId: params.runId,
          provider,
          model: failure.modelId ?? modelId,
          reason,
          ...observedError,
          consoleMessage:
            "DT팀 API에 현재 이상현상이 있다. seungon.jung 에게 문의해라. " +
            `provider=${sanitizeForLog(provider)} model=${sanitizeForLog(failure.modelId ?? modelId)} ` +
            `reason=${sanitizeForLog(reason)} status=${sanitizeForLog(observedError.httpCode ?? "-")} ` +
            `type=${sanitizeForLog(observedError.providerErrorType ?? "-")} error=${detail}`,
        });
      }
      if (profileId) {
        await markAuthProfileFailure({
          store: profileFailureStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
          runId: params.runId,
          modelId: failure.modelId,
          diagnostic,
        });
        return;
      }
      // Inline provider API keys have no auth profile, so record their
      // billing/auth failures under the provider-scoped inline cooldown so the
      // resolver stops handing back the exhausted key on the next turn.
      const apiKeyInfo = input.getApiKeyInfo();
      if (
        apiKeyInfo?.mode !== "api-key" ||
        !isConfigBackedInlineProviderApiKey({
          cfg: params.config,
          provider,
          source: apiKeyInfo.source,
          store: profileFailureStore,
        })
      ) {
        return;
      }
      await markInlineProviderApiKeyFailure({
        store: profileFailureStore,
        provider,
        reason,
        cfg: params.config,
        agentDir,
        runId: params.runId,
        modelId: failure.modelId,
        diagnostic,
      });
    },
    resolveAuthProfileFailureReason: (
      failoverReason: FailoverReason | null,
      opts?: { providerStarted?: boolean; transientRateLimit?: boolean },
    ) => {
      return resolveAuthProfileFailureReason({
        failoverReason,
        providerStarted: opts?.providerStarted,
        transientRateLimit: opts?.transientRateLimit,
        policy: params.authProfileFailurePolicy,
      });
    },
    maybeBackoffBeforeOverloadFailover: async (reason: FailoverReason | null) => {
      if (reason !== "overloaded" || overloadFailoverBackoffMs <= 0) {
        return;
      }
      log.warn(
        `overload backoff before failover for ${provider}/${modelId}: delayMs=${overloadFailoverBackoffMs}`,
      );
      await sleepForRetry(overloadFailoverBackoffMs);
    },
    maybeRetrySameModelRateLimit: async (retry?: {
      retryAfterSeconds?: number;
    }): Promise<boolean> => {
      if (consecutiveSameModelRateLimitRetries >= MAX_SAME_MODEL_RATE_LIMIT_RETRIES) {
        return false;
      }
      const delayMs = resolveSameModelRateLimitRetryDelayMs({
        retriesSoFar: consecutiveSameModelRateLimitRetries,
        retryAfterSeconds: retry?.retryAfterSeconds,
      });
      log.warn(
        `rate-limit same-model retry ${consecutiveSameModelRateLimitRetries + 1}/${MAX_SAME_MODEL_RATE_LIMIT_RETRIES} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)}: delayMs=${delayMs}`,
      );
      await sleepForRetry(delayMs);
      consecutiveSameModelRateLimitRetries = resolveNextSameModelRateLimitRetryCount({
        retriesSoFar: consecutiveSameModelRateLimitRetries,
        retriedSameModelRateLimit: true,
      });
      return true;
    },
  };
}
