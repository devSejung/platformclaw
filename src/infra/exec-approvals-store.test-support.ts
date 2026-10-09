import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import "./exec-approvals-store.js";

type ExecApprovalsStoreTestApi = {
  reset(): void;
  updateExecApprovalsInTransaction(params: {
    baseHash?: string;
    update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
  }): ExecApprovalsSnapshot | null;
};

function getTesting(): ExecApprovalsStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.execApprovalsStoreTestApi")
  ] as ExecApprovalsStoreTestApi;
}

export const testing: Pick<ExecApprovalsStoreTestApi, "reset"> = {
  reset: () => getTesting().reset(),
};

export function saveExecApprovals(file: ExecApprovalsFile): void {
  getTesting().updateExecApprovalsInTransaction({ update: () => file });
}
