import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
/** Public singleton facade for the ACP session manager control plane. */
import { AcpSessionManager } from "./manager.core.js";

export { AcpSessionManager } from "./manager.core.js";
export type {
  AcpCloseSessionInput,
  AcpCloseSessionResult,
  AcpInitializeSessionInput,
  AcpManagerObservabilitySnapshot,
  AcpRunTurnInput,
  AcpSessionResolution,
  AcpSessionRuntimeOptions,
  AcpSessionStatus,
  AcpStartupIdentityReconcileResult,
} from "./manager.types.js";

const managerState = resolveGlobalSingleton<{ manager: AcpSessionManager | null }>(
  Symbol.for("openclaw.acp.sessionManager"),
  () => ({ manager: null }),
  async (state) => {
    await state.manager?.stopIdleMaintenance?.();
    state.manager = null;
  },
);

/** Returns the process-wide ACP session manager singleton. */
export function getAcpSessionManager(): AcpSessionManager {
  if (!managerState.manager) {
    managerState.manager = new AcpSessionManager();
  }
  return managerState.manager;
}

export const testing = {
  resetAcpSessionManagerForTests() {
    void managerState.manager?.stopIdleMaintenance?.();
    managerState.manager = null;
  },
  setAcpSessionManagerForTests(manager: unknown) {
    void managerState.manager?.stopIdleMaintenance?.();
    managerState.manager = manager as AcpSessionManager | null;
  },
};
