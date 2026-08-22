import { GatewayRequestError } from "../../api/gateway.ts";

const ACTIVE_LEAF_CHANGED_ERROR_REASON = "active-leaf-changed";

export function isActiveLeafChangedError(err: unknown): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const details = err.details;
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { reason?: unknown }).reason === ACTIVE_LEAF_CHANGED_ERROR_REASON
  );
}

export function isDefinitiveChatSendRejection(err: unknown): err is GatewayRequestError {
  if (isActiveLeafChangedError(err)) {
    return true;
  }
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const details = err.details;
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { requestDisposition?: unknown }).requestDisposition === "rejected-before-dispatch"
  );
}
