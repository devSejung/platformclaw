#!/usr/bin/env node
export function stripVersionDecorators(reference: unknown): unknown;
export function parseSnapshotKey(snapshotKey: unknown): {
  packageName: unknown;
  reference: unknown;
  version: unknown;
};
export function collectProdResolvedPackagesFromLockfile(
  lockfileText: unknown,
): Map<unknown, unknown>;
export function collectAllResolvedPackagesFromLockfile(
  lockfileText: unknown,
): Map<unknown, unknown>;
export function createBulkAdvisoryPayload(versionsByPackage: unknown): unknown;
export function getReviewedSecurityPatchRegistrations(): {
  specifier: string;
  patchPath: string;
  installHash: string;
}[];
export function verifyReviewedSecurityPatches(options: {
  rootDir: string;
  lockfileText: string;
  requiredPatchSpecifiers?: string[];
}): Promise<void>;
export function filterVerifiedPatchedAdvisories<T extends Record<string, unknown[]>>({
  rootDir,
  lockfileText,
  advisoriesByPackage,
  versionsByPackage,
}: {
  rootDir: string;
  lockfileText: string;
  advisoriesByPackage: T;
  versionsByPackage?: unknown;
}): Promise<T>;
export function filterFindingsBySeverity(
  advisoriesByPackage: unknown,
  minSeverity: unknown,
  versionsByPackage?: unknown,
): {
  packageName: string;
  id: unknown;
  severity: string;
  title: unknown;
  url: unknown;
  vulnerableVersions: unknown;
}[];
export function readBoundedBulkAdvisoryErrorText(
  response: unknown,
  maxChars?: number,
  options?: Record<string, unknown>,
): Promise<string>;
export function fetchBulkAdvisories({
  payload,
  fetchImpl,
  registryBaseUrl,
  responseBodyMaxBytes,
  timeoutMs,
  maxAttempts,
  sleepImpl,
}: {
  payload: unknown;
  fetchImpl?: typeof fetch | undefined;
  registryBaseUrl?: string | undefined;
  responseBodyMaxBytes?: unknown;
  timeoutMs?: number | undefined;
  maxAttempts?: number | undefined;
  sleepImpl?: ((delayMs: number) => Promise<void>) | undefined;
}): Promise<unknown>;
export function runPnpmAuditProd({
  rootDir,
  fetchImpl,
  stdout,
  stderr,
  minSeverity,
}?: {
  rootDir?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  stdout?: Pick<NodeJS.WriteStream, "write"> | undefined;
  stderr?: Pick<NodeJS.WriteStream, "write"> | undefined;
  minSeverity?: string | undefined;
}): Promise<0 | 1>;
export function parseArgs(argv: unknown): {
  minSeverity: string;
};
