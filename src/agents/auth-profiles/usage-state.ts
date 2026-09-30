/**
 * Pure cooldown and unusable-window helpers for auth profile usage state.
 * Mutation and persistence live in usage.ts; this module owns reusable state
 * predicates used by rotation and failure handling.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";

/** Returns the transient cooldown duration for a failure count: 30s -> 1m -> 5m max. */
export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  if (normalized <= 1) {
    return 30_000;
  }
  if (normalized <= 2) {
    return 60_000;
  }
  return 5 * 60_000;
}

/** Returns true for providers whose auth-profile cooldowns are provider-managed. */
export function isAuthCooldownBypassedForProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === "openrouter" || normalized === "kilocode";
}

// Per-attempt transient failures (#87462, #116464): block only the failing
// model so fallback models on the same auth profile can still try. A model that
// the provider does not serve (model_not_found) says nothing about sibling
// models, so it stays model-scoped too. Other reasons (auth, billing, format,
// server_error) remain profile-wide.
/** Returns true when a failure should only cool down the failing model. */
export function isModelScopedCooldownReason(reason: AuthProfileFailureReason | undefined): boolean {
  return reason === "rate_limit" || reason === "timeout" || reason === "model_not_found";
}

/** Resolves disabledUntil with legacy long billing windows capped to the current retry policy. */
export function resolveProfileDisabledUntil(
  stats: Pick<
    ProfileUsageStats,
    "disabledUntil" | "disabledReason" | "lastFailureAt" | "errorCount" | "failureCounts"
  >,
): number | undefined {
  const disabledUntil = asDateTimestampMs(stats.disabledUntil);
  if (stats.disabledReason !== "billing" || disabledUntil === undefined) {
    return disabledUntil;
  }

  // Billing used to enter a 5h-24h disabled lane. Treat persisted legacy rows
  // with the new transient policy immediately so upgrading does not leave a key
  // blocked for hours after the policy change.
  const lastFailureAt = asDateTimestampMs(stats.lastFailureAt);
  if (lastFailureAt === undefined) {
    return disabledUntil;
  }
  const billingFailureCount = stats.failureCounts?.billing ?? stats.errorCount ?? 1;
  const cappedUntil = lastFailureAt + calculateAuthProfileCooldownMs(billingFailureCount);
  return Math.min(disabledUntil, cappedUntil);
}

/** Resolves the latest active blocked/cooldown/disabled timestamp for a profile. */
export function resolveProfileUnusableUntil(
  stats: Pick<
    ProfileUsageStats,
    | "blockedUntil"
    | "blockedModel"
    | "blockedScope"
    | "cooldownUntil"
    | "disabledUntil"
    | "disabledReason"
    | "lastFailureAt"
    | "errorCount"
    | "failureCounts"
  >,
  forModel?: string,
): number | null {
  const blockedUntil = isBlockScopedToDifferentModel(stats, forModel)
    ? undefined
    : stats.blockedUntil;
  const values = [blockedUntil, stats.cooldownUntil, resolveProfileDisabledUntil(stats)]
    .map((value) => asDateTimestampMs(value))
    .filter((value): value is number => value !== undefined && value > 0);
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

/** Returns true when an unusable timestamp is active at the supplied clock time. */
export function isActiveUnusableWindow(until: number | undefined, now: number): boolean {
  const timestamp = asDateTimestampMs(until);
  return timestamp !== undefined && timestamp > 0 && now < timestamp;
}

function isBlockedWindowActiveForModel(
  stats: Pick<ProfileUsageStats, "blockedUntil" | "blockedModel" | "blockedScope">,
  now: number,
  forModel?: string,
): boolean {
  return (
    !isBlockScopedToDifferentModel(stats, forModel) &&
    isActiveUnusableWindow(stats.blockedUntil, now)
  );
}

function isBlockScopedToDifferentModel(
  stats: Pick<ProfileUsageStats, "blockedModel" | "blockedScope">,
  forModel?: string,
): boolean {
  // Legacy rows carried blockedModel for profile-wide blocks without a scope marker.
  // Only explicit model scope narrows them; unmarked rows stay wide until expiry.
  return Boolean(
    forModel &&
    stats.blockedScope === "model" &&
    stats.blockedModel &&
    stats.blockedModel !== forModel,
  );
}

function shouldBypassModelScopedCooldown(
  stats: Pick<
    ProfileUsageStats,
    | "blockedUntil"
    | "blockedModel"
    | "blockedScope"
    | "cooldownReason"
    | "cooldownModel"
    | "disabledUntil"
    | "disabledReason"
    | "lastFailureAt"
    | "errorCount"
    | "failureCounts"
  >,
  now: number,
  forModel?: string,
): boolean {
  return Boolean(
    forModel &&
    isModelScopedCooldownReason(stats.cooldownReason) &&
    stats.cooldownModel &&
    stats.cooldownModel !== forModel &&
    !isBlockedWindowActiveForModel(stats, now, forModel) &&
    !isActiveUnusableWindow(resolveProfileDisabledUntil(stats), now),
  );
}

/**
 * Check if a profile is currently in cooldown (due to rate limits, overload, or other transient failures).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  now?: number,
  forModel?: string,
): boolean {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return false;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  const ts = now ?? Date.now();
  // Model-aware bypass: if the cooldown was caused by a model-scoped reason on a
  // specific model and the caller is requesting a *different* model, allow it.
  // We still honour profile-wide blocked/disabled windows; they must not be
  // short-circuited by model scoping.
  if (shouldBypassModelScopedCooldown(stats, ts, forModel)) {
    return false;
  }
  const unusableUntil = resolveProfileUnusableUntil(stats, forModel);
  return unusableUntil ? ts < unusableUntil : false;
}

/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
export function getSoonestCooldownExpiry(
  store: AuthProfileStore,
  profileIds: string[],
  options?: { now?: number; forModel?: string },
): number | null {
  const ts = options?.now ?? Date.now();
  let soonest: number | null = null;
  let latestMatchingModelCooldown: number | null = null;
  for (const id of profileIds) {
    const stats = store.usageStats?.[id];
    if (!stats) {
      continue;
    }
    if (shouldBypassModelScopedCooldown(stats, ts, options?.forModel)) {
      continue;
    }
    const until = resolveProfileUnusableUntil(stats, options?.forModel);
    if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) {
      continue;
    }
    const matchingModelScopedCooldown =
      options?.forModel &&
      stats.cooldownReason === "rate_limit" &&
      stats.cooldownModel === options.forModel &&
      !isBlockedWindowActiveForModel(stats, ts, options.forModel) &&
      !isActiveUnusableWindow(resolveProfileDisabledUntil(stats), ts);
    if (matchingModelScopedCooldown) {
      latestMatchingModelCooldown =
        latestMatchingModelCooldown === null ? until : Math.max(latestMatchingModelCooldown, until);
      continue;
    }
    if (soonest === null || until < soonest) {
      soonest = until;
    }
  }
  if (soonest === null) {
    return latestMatchingModelCooldown;
  }
  if (latestMatchingModelCooldown === null) {
    return soonest;
  }
  return Math.min(soonest, latestMatchingModelCooldown);
}

/**
 * Clear expired cooldowns from all profiles in the store.
 *
 * When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
 * are removed and error counters are normally reset so the profile gets a fresh
 * start (circuit-breaker half-open -> closed). Billing is the exception: its
 * deliberate 30s -> 1m -> 5m sequence must survive the half-open retry, and a
 * successful request clears that sequence through markAuthProfileSuccess().
 *
 * `cooldownUntil` and `disabledUntil` are handled independently: if a profile
 * has both and only one has expired, only that field is cleared.
 *
 * Mutates the in-memory store; disk persistence happens lazily on the next
 * store write (e.g. `markAuthProfileSuccess` / `markAuthProfileFailure`), which
 * matches the existing save pattern throughout the auth-profiles module.
 *
 * @returns `true` if any profile was modified.
 */
export function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean {
  const usageStats = store.usageStats;
  if (!usageStats) {
    return false;
  }

  const ts = now ?? Date.now();
  let mutated = false;

  for (const [profileId, stats] of Object.entries(usageStats)) {
    if (!stats) {
      continue;
    }

    let profileMutated = false;
    const cooldownExpired =
      typeof stats.cooldownUntil === "number" &&
      Number.isFinite(stats.cooldownUntil) &&
      stats.cooldownUntil > 0 &&
      ts >= stats.cooldownUntil;
    const blockedExpired =
      typeof stats.blockedUntil === "number" &&
      Number.isFinite(stats.blockedUntil) &&
      stats.blockedUntil > 0 &&
      ts >= stats.blockedUntil;
    const effectiveDisabledUntil = resolveProfileDisabledUntil(stats);
    const disabledExpired =
      typeof effectiveDisabledUntil === "number" &&
      Number.isFinite(effectiveDisabledUntil) &&
      effectiveDisabledUntil > 0 &&
      ts >= effectiveDisabledUntil;
    const billingFailureCountBeforeClear =
      (cooldownExpired && stats.cooldownReason === "billing") ||
      (disabledExpired && stats.disabledReason === "billing")
        ? (stats.failureCounts?.billing ?? stats.errorCount ?? 1)
        : 0;

    if (cooldownExpired) {
      stats.cooldownUntil = undefined;
      stats.cooldownReason = undefined;
      stats.cooldownModel = undefined;
      profileMutated = true;
    }
    if (blockedExpired) {
      stats.blockedUntil = undefined;
      stats.blockedReason = undefined;
      stats.blockedSource = undefined;
      stats.blockedModel = undefined;
      stats.blockedScope = undefined;
      profileMutated = true;
    }
    if (disabledExpired) {
      stats.disabledUntil = undefined;
      stats.disabledReason = undefined;
      profileMutated = true;
    }

    // Reset error counters when ALL cooldowns have expired so the profile gets
    // a fair retry window. Billing deliberately retains only its own sequence
    // count so a failed half-open retry progresses 30s -> 1m -> 5m instead of
    // restarting at 30s forever. Preserves lastFailureAt for failureWindowMs
    // decay in computeNextProfileUsageStats.
    if (profileMutated && !resolveProfileUnusableUntil(stats)) {
      if (billingFailureCountBeforeClear > 0) {
        stats.errorCount = billingFailureCountBeforeClear;
        stats.failureCounts = { billing: billingFailureCountBeforeClear };
      } else {
        stats.errorCount = 0;
        stats.failureCounts = undefined;
      }
    }

    if (profileMutated) {
      usageStats[profileId] = stats;
      mutated = true;
    }
  }

  return mutated;
}
