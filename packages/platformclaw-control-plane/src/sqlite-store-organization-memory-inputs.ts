import { ControlPlaneStateError } from "./contracts.js";

export const MAX_TEXT_CHARS = 64 * 1024;
export const MAX_REASON_CHARS = 2_000;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_CHARS = 1_000;
const SHARED_CLAIM_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export function boundedText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ControlPlaneStateError(`${label} must contain 1-${max} characters`);
  }
  return normalized;
}

export function claimIdentity(value: string): string {
  const normalized = value.trim();
  if (!SHARED_CLAIM_ID.test(normalized)) {
    throw new ControlPlaneStateError("source claim id is invalid");
  }
  return normalized;
}

export function personalClaimLookup(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 1_000 ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new ControlPlaneStateError("personal Wiki page lookup is invalid");
  }
  return normalized;
}

export function evidenceItems(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_EVIDENCE_ITEMS) {
    throw new ControlPlaneStateError(`evidence is limited to ${MAX_EVIDENCE_ITEMS} items`);
  }
  return values.map((value) => boundedText(value, "evidence item", MAX_EVIDENCE_CHARS));
}

export function titleForClaim(text: string): string {
  const line = text.split(/\r?\n/u).find((entry) => entry.trim()) ?? "Organization memory";
  return (
    line
      .replace(/^#{1,6}\s+/u, "")
      .trim()
      .slice(0, 160) || "Organization memory"
  );
}
