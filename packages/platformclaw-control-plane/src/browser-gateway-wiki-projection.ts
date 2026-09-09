import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type JsonObject = Record<string, unknown>;
export type ProjectionFailure = (message: string) => never;

const MAX_LIST_ITEMS = 100;
const MAX_TEXT_CHARS = 16 * 1024;

export function failObject(value: unknown, label: string, fail: ProjectionFailure): JsonObject {
  return isRecord(value) ? value : fail(`Gateway returned invalid ${label}`);
}

export function text(
  value: unknown,
  label: string,
  fail: ProjectionFailure,
  max = MAX_TEXT_CHARS,
): string {
  return typeof value === "string" && value.length <= max
    ? value
    : fail(`Gateway returned invalid ${label}`);
}

export function count(value: unknown, label: string, fail: ProjectionFailure): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail(`Gateway returned invalid ${label}`);
}

export function score(value: unknown, label: string, fail: ProjectionFailure): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(`Gateway returned invalid ${label}`);
}

export function optionalText(
  value: unknown,
  label: string,
  fail: ProjectionFailure,
  max = MAX_TEXT_CHARS,
): string | undefined {
  return value === undefined ? undefined : text(value, label, fail, max);
}

export function stringList(value: unknown, label: string, fail: ProjectionFailure): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    return fail(`Gateway returned invalid ${label}`);
  }
  return value.map((entry) => text(entry, label, fail));
}

export function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  fail: ProjectionFailure,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fail(`${label} must be one of: ${allowed.join(", ")}`);
}

export function positiveInteger(
  value: unknown,
  label: string,
  max: number,
  fail: ProjectionFailure,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : fail(`${label} must be an integer from 1 to ${max}`);
}
