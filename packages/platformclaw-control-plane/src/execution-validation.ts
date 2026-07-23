import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { ControlPlaneStateError } from "./contracts.js";

export type NormalizedOpenSshHostKey = {
  algorithm: string;
  publicKey: string;
  fingerprint: string;
};

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

export function normalizeOpenSshHostKey(params: {
  algorithm: string;
  publicKey: string;
  approvedFingerprint: string;
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
  if (required(params.approvedFingerprint, "hostKey.fingerprint") !== fingerprint) {
    throw new ControlPlaneStateError("approved host key fingerprint does not match public key");
  }
  return {
    algorithm,
    publicKey: blob.toString("base64"),
    fingerprint,
  };
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
