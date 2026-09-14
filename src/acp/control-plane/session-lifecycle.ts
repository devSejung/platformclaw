/** ACP runtime cleanup helpers bound to Gateway session lifecycle mutations. */
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readAcpSessionMeta } from "../runtime/session-meta.js";
import { getAcpSessionManager } from "./manager.js";

/**
 * Retires only a warm process-local ACP runtime handle before archive. A cold
 * session stays cold: persisted metadata/resume identity is left untouched and
 * no runtime ensure/authentication path is entered.
 */
export async function closeAcpRuntimeForArchive(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<ErrorShape | null> {
  if (!readAcpSessionMeta({ cfg: params.cfg, sessionKey: params.sessionKey })) {
    return null;
  }
  try {
    await getAcpSessionManager().closeSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      reason: "session-archive",
      cacheOnly: true,
    });
    return null;
  } catch (error) {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      `Could not archive ACP session ${params.sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}
