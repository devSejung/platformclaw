// Plugin SDK file-lock surface re-exported for infra callers that should share
// the same durable lock semantics as plugins.
export {
  acquireFileLock,
  drainFileLockStateForTest,
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  withFileLock,
} from "../plugin-sdk/file-lock.js";
