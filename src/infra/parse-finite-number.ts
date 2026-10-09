// Number parsing facade for legacy infra imports; implementation lives in
// normalization-core so config, timers, and CLI parsing share one contract.
export {
  parseFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  clampTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
  resolveExpiresAtMsFromDurationSeconds,
} from "../../packages/normalization-core/src/number-coercion.js";
