import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { domainToASCII } from "node:url";
import { ControlPlaneStateError } from "./contracts.js";

export type NormalizedOpenSshHostKey = {
  algorithm: string;
  publicKey: string;
  fingerprint: string;
};

export type VmHostExecutionEnvironment = {
  pathPrepend: string[];
  variables: Record<string, string>;
};

const VM_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const VM_ENV_BLOCKED_NAMES = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "HOME",
  "IFS",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "PWD",
  "SHELL",
  "SHELLOPTS",
  "TMPDIR",
  "USER",
]);
const MAX_VM_PATH_ENTRIES = 32;
const MAX_VM_ENV_VARIABLES = 64;
const MAX_VM_ENV_VALUE_BYTES = 4096;

function isBlockedVmEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    VM_ENV_BLOCKED_NAMES.has(upper) ||
    upper.startsWith("LD_") ||
    upper.startsWith("DYLD_") ||
    upper.startsWith("OPENCLAW_") ||
    upper.startsWith("PLATFORMCLAW_")
  );
}

export function normalizeVmHostExecutionEnvironment(
  value: unknown,
): VmHostExecutionEnvironment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (value === undefined || value === null) {
      return undefined;
    }
    throw new ControlPlaneStateError("vmHost.executionEnvironment must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const rawPaths = candidate.pathPrepend ?? [];
  const rawVariables = candidate.variables ?? {};
  if (!Array.isArray(rawPaths) || rawPaths.length > MAX_VM_PATH_ENTRIES) {
    throw new ControlPlaneStateError("vmHost.pathPrepend must contain at most 32 paths");
  }
  if (!rawVariables || typeof rawVariables !== "object" || Array.isArray(rawVariables)) {
    throw new ControlPlaneStateError("vmHost.variables must be an object");
  }
  const paths = [
    ...new Set(
      rawPaths.map((entry) => {
        if (typeof entry !== "string") {
          throw new ControlPlaneStateError("vmHost.pathPrepend entries must be strings");
        }
        const normalized = entry.trim().replace(/\/+$/u, "") || "/";
        if (
          !normalized.startsWith("/") ||
          path.posix.normalize(normalized) !== normalized ||
          normalized.includes(":") ||
          normalized.includes("\u0000") ||
          normalized.includes("\r") ||
          normalized.includes("\n") ||
          normalized.split("/").some((part) => part === "." || part === "..")
        ) {
          throw new ControlPlaneStateError(
            "vmHost.pathPrepend entries must be absolute POSIX paths",
          );
        }
        return normalized;
      }),
    ),
  ];
  const entries = Object.entries(rawVariables);
  if (entries.length > MAX_VM_ENV_VARIABLES) {
    throw new ControlPlaneStateError("vmHost.variables must contain at most 64 entries");
  }
  const variables: Record<string, string> = {};
  for (const [name, rawValue] of entries.toSorted(([left], [right]) => left.localeCompare(right))) {
    if (!VM_ENV_NAME_PATTERN.test(name) || isBlockedVmEnvironmentName(name)) {
      throw new ControlPlaneStateError(`vmHost environment variable is not allowed: ${name}`);
    }
    if (typeof rawValue !== "string") {
      throw new ControlPlaneStateError(`vmHost environment variable must be a string: ${name}`);
    }
    const normalized = rawValue.trim();
    if (
      normalized.includes("\u0000") ||
      normalized.includes("\r") ||
      normalized.includes("\n") ||
      Buffer.byteLength(normalized) > MAX_VM_ENV_VALUE_BYTES
    ) {
      throw new ControlPlaneStateError(`vmHost environment variable value is invalid: ${name}`);
    }
    variables[name] = normalized;
  }
  return paths.length > 0 || Object.keys(variables).length > 0
    ? { pathPrepend: paths, variables }
    : undefined;
}

export function parseVmHostExecutionEnvironmentJson(
  value: string | null | undefined,
): VmHostExecutionEnvironment | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return normalizeVmHostExecutionEnvironment(JSON.parse(value));
  } catch (error) {
    if (error instanceof ControlPlaneStateError) {
      throw error;
    }
    throw new ControlPlaneStateError("stored VM execution environment is invalid");
  }
}

export function serializeVmHostExecutionEnvironment(value: unknown): string | undefined {
  const normalized = normalizeVmHostExecutionEnvironment(value);
  return normalized ? JSON.stringify(normalized) : undefined;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ControlPlaneStateError(`${field} must not be empty`);
  }
  return normalized;
}

function decodeOpenSshKeyBlob(value: string): Buffer {
  const unpadded = value.replace(/=+$/u, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || unpadded.length % 4 === 1) {
    throw new ControlPlaneStateError("hostKey.publicKey must be canonical OpenSSH base64");
  }
  const blob = Buffer.from(value, "base64");
  if (blob.toString("base64").replace(/=+$/u, "") !== unpadded) {
    throw new ControlPlaneStateError("hostKey.publicKey must be canonical OpenSSH base64");
  }
  return blob;
}

export function normalizeObservedOpenSshHostKey(params: {
  algorithm: string;
  publicKey: string;
}): NormalizedOpenSshHostKey {
  const algorithm = required(params.algorithm, "hostKey.algorithm");
  if (algorithm !== "ssh-ed25519") {
    throw new ControlPlaneStateError("only ssh-ed25519 SafeConnect host keys are supported");
  }
  const publicKeyParts = required(params.publicKey, "hostKey.publicKey").split(/\s+/u);
  const encodedKey = required(
    (publicKeyParts.length === 1 ? publicKeyParts[0] : publicKeyParts[1]) ?? "",
    "hostKey.publicKey",
  );
  if (publicKeyParts.length > 1 && publicKeyParts[0] !== algorithm) {
    throw new ControlPlaneStateError("host key algorithm does not match public key prefix");
  }
  const blob = decodeOpenSshKeyBlob(encodedKey);
  if (blob.length < 5) {
    throw new ControlPlaneStateError("hostKey.publicKey is not an OpenSSH key blob");
  }
  const embeddedAlgorithmLength = blob.readUInt32BE(0);
  const embeddedAlgorithmEnd = 4 + embeddedAlgorithmLength;
  if (embeddedAlgorithmLength === 0 || embeddedAlgorithmEnd >= blob.length) {
    throw new ControlPlaneStateError("hostKey.publicKey is not an OpenSSH key blob");
  }
  const embeddedAlgorithm = blob.subarray(4, embeddedAlgorithmEnd).toString("utf8");
  if (embeddedAlgorithm !== algorithm) {
    throw new ControlPlaneStateError("host key algorithm does not match key blob");
  }
  if (embeddedAlgorithmEnd + 4 > blob.length) {
    throw new ControlPlaneStateError("hostKey.publicKey is not an Ed25519 OpenSSH key blob");
  }
  const keyLength = blob.readUInt32BE(embeddedAlgorithmEnd);
  if (keyLength !== 32 || embeddedAlgorithmEnd + 4 + keyLength !== blob.length) {
    throw new ControlPlaneStateError("hostKey.publicKey is not an Ed25519 OpenSSH key blob");
  }
  const fingerprint = `SHA256:${createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/u, "")}`;
  return {
    algorithm,
    publicKey: blob.toString("base64"),
    fingerprint,
  };
}

export function normalizeOpenSshHostKey(params: {
  algorithm: string;
  publicKey: string;
  approvedFingerprint: string;
}): NormalizedOpenSshHostKey {
  const key = normalizeObservedOpenSshHostKey(params);
  if (required(params.approvedFingerprint, "hostKey.fingerprint") !== key.fingerprint) {
    throw new ControlPlaneStateError("approved host key fingerprint does not match public key");
  }
  return key;
}

function normalizeDnsName(candidate: string, field: string): string {
  const dnsName = domainToASCII(candidate.replace(/\.$/u, "")).toLowerCase();
  if (
    !dnsName ||
    dnsName.length > 253 ||
    dnsName
      .split(".")
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    throw new ControlPlaneStateError(`${field} must be a valid DNS name`);
  }
  return dnsName;
}

function normalizeDnsOrIpAddress(value: string, field: string): string {
  const candidate = required(value, field);
  if (isIP(candidate) === 4) {
    return candidate;
  }
  const ipv6Candidate =
    candidate.startsWith("[") && candidate.endsWith("]") ? candidate.slice(1, -1) : candidate;
  if (isIP(ipv6Candidate) === 6) {
    return new URL(`http://[${ipv6Candidate}]/`).hostname.slice(1, -1);
  }
  if (/^\d+(?:\.\d+){3}$/u.test(candidate)) {
    throw new ControlPlaneStateError(`${field} contains an invalid IPv4 address`);
  }
  return normalizeDnsName(candidate, field);
}

export function normalizeSafeConnectHost(value: string): string {
  return normalizeDnsOrIpAddress(value, "endpoint.host");
}

export function normalizeAdDomain(value: string): string {
  const candidate = required(value, "endpoint.adDomain");
  if (isIP(candidate) !== 0 || candidate.startsWith("[") || candidate.endsWith("]")) {
    throw new ControlPlaneStateError("endpoint.adDomain must be a valid DNS name");
  }
  return normalizeDnsName(candidate, "endpoint.adDomain");
}

export function normalizeVmTargetAddress(value: string): string {
  return normalizeDnsOrIpAddress(value, "vmHost.targetAddress");
}

export function normalizeLinuxAccount(value: string): string {
  const account = required(value, "allocation.linuxAccount");
  if (
    account.length > 255 ||
    /[\s\\+@]/u.test(account) ||
    account.includes(String.fromCharCode(0))
  ) {
    throw new ControlPlaneStateError("allocation.linuxAccount is invalid");
  }
  return account;
}
