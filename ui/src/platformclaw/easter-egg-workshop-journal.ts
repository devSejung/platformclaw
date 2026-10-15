import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  BASEBALL_RPC,
  isBaseballKboTeamId,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import type { BaseballMutation } from "./easter-egg-persistence.ts";

type StoredMutation = Pick<BaseballMutation, "method" | "params"> & { createdAt?: number };

function prefix(scope: string): string {
  return `platformclaw.baseball.pending.v1:${encodeURIComponent(scope)}:`;
}

const WORKSHOP_RECEIPT_LIMIT = 128;
type CompletedReceipt = { requestId: string; tauntClaimed: boolean; at: number };

function receiptKey(scope: string): string {
  return `platformclaw.baseball.receipts.v1:${encodeURIComponent(scope)}`;
}

function validReceipt(value: unknown): value is CompletedReceipt {
  return (
    isRecord(value) &&
    typeof value.requestId === "string" &&
    value.requestId.length <= 128 &&
    typeof value.tauntClaimed === "boolean" &&
    Number.isSafeInteger(value.at) &&
    (value.at as number) >= 0
  );
}

function readReceipts(storage: Storage, scope: string): CompletedReceipt[] {
  const value: unknown = JSON.parse(storage.getItem(receiptKey(scope)) ?? "[]");
  if (
    !Array.isArray(value) ||
    value.length > WORKSHOP_RECEIPT_LIMIT ||
    !value.every(validReceipt)
  ) {
    throw new Error("Invalid completed receipt journal");
  }
  return value;
}

export function isWorkshopJournalEvent(scope: string | null, key: string | null): boolean {
  return Boolean(scope && key && (key.startsWith(prefix(scope)) || key === receiptKey(scope)));
}

function valid(value: unknown): value is StoredMutation {
  if (!isRecord(value) || !isRecord(value.params)) {
    return false;
  }
  const { method, params } = value;
  if (
    value.createdAt !== undefined &&
    (!Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0)
  ) {
    return false;
  }
  if (
    typeof params.requestId !== "string" ||
    !params.requestId ||
    params.requestId.length > 128 ||
    !Number.isSafeInteger(params.expectedRevision) ||
    (params.expectedRevision as number) < 0
  ) {
    return false;
  }
  const extra =
    method === BASEBALL_RPC.recoverBat
      ? "action"
      : method === BASEBALL_RPC.selectTeam
        ? "teamId"
        : null;
  if (Object.keys(params).some((key) => !["requestId", "expectedRevision", extra].includes(key))) {
    return false;
  }
  return (
    method === BASEBALL_RPC.enhanceBat ||
    method === BASEBALL_RPC.equipEnhancedBat ||
    (method === BASEBALL_RPC.recoverBat &&
      ["restore", "restart"].includes(params.action as string)) ||
    (method === BASEBALL_RPC.selectTeam && isBaseballKboTeamId(params.teamId))
  );
}

/** Each intent has its own key so two tabs cannot overwrite each other's unknown request. */
export function loadPendingWorkshop(scope: string | null): StoredMutation[] {
  const storage = getSafeLocalStorage();
  if (!scope || !storage) {
    throw new Error("Pending request storage unavailable");
  }
  const start = prefix(scope);
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => key !== null && key.startsWith(start))
    .toSorted();
  const completed = new Set(readReceipts(storage, scope).map((entry) => entry.requestId));
  const pending: StoredMutation[] = [];
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw === null) {
      continue;
    }
    const value: unknown = JSON.parse(raw);
    if (!valid(value) || key !== start + value.params.requestId) {
      throw new Error("Invalid pending request journal");
    }
    if (!completed.has(value.params.requestId as string)) {
      pending.push(value);
    }
  }
  return pending.toSorted(
    (a, b) =>
      (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
      String(a.params.requestId).localeCompare(String(b.params.requestId)),
  );
}

export function savePendingWorkshop(
  scope: string | null,
  mutation: StoredMutation,
  requireExisting = false,
): boolean {
  try {
    const storage = getSafeLocalStorage();
    if (!scope || !storage || !valid(mutation)) {
      return false;
    }
    const key = prefix(scope) + mutation.params.requestId;
    if (
      readReceipts(storage, scope).some((entry) => entry.requestId === mutation.params.requestId)
    ) {
      return false;
    }
    const existing = storage.getItem(key);
    // A restored/in-flight request may never recreate an intent removed by another tab.
    if (requireExisting && !existing) {
      return false;
    }
    if (existing) {
      const stored: unknown = JSON.parse(existing);
      if (
        !valid(stored) ||
        stored.method !== mutation.method ||
        JSON.stringify(stored.params) !== JSON.stringify(mutation.params)
      ) {
        return false;
      }
    }
    const value =
      existing ??
      JSON.stringify({ method: mutation.method, params: mutation.params, createdAt: Date.now() });
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

export async function clearPendingWorkshop(
  scope: string | null,
  mutation: StoredMutation,
): Promise<void> {
  if (!scope) {
    return;
  }
  const settle = () => {
    const storage = getSafeLocalStorage();
    if (!storage) {
      throw new Error("Receipt storage unavailable");
    }
    const key = prefix(scope) + mutation.params.requestId;
    const completed = readReceipts(storage, scope);
    // Missing intent + evicted receipt means an old response; never recreate its feedback record.
    if (
      !completed.some((entry) => entry.requestId === mutation.params.requestId) &&
      storage.getItem(key)
    ) {
      completed.push({
        requestId: mutation.params.requestId as string,
        tauntClaimed: false,
        at: Date.now(),
      });
      storage.setItem(receiptKey(scope), JSON.stringify(completed.slice(-WORKSHOP_RECEIPT_LIMIT)));
    }
    storage.removeItem(key);
  };
  if (navigator.locks) {
    await navigator.locks.request(receiptKey(scope), settle);
  } else {
    settle();
  }
}

/** Claims are bounded and shared; display eligibility is checked while holding the same-origin lock. */
export async function claimWorkshopTaunt(
  scope: string | null,
  requestId: string,
  canDisplay: () => boolean = () => true,
): Promise<boolean> {
  if (!scope || !navigator.locks) {
    return false;
  }
  try {
    return await navigator.locks.request(receiptKey(scope), () => {
      const storage = getSafeLocalStorage();
      if (!storage || !canDisplay()) {
        return false;
      }
      const completed = readReceipts(storage, scope);
      const receipt = completed.find((entry) => entry.requestId === requestId);
      if (!receipt || receipt.tauntClaimed) {
        return false;
      }
      receipt.tauntClaimed = true;
      storage.setItem(receiptKey(scope), JSON.stringify(completed));
      return true;
    });
  } catch {
    return false;
  }
}
