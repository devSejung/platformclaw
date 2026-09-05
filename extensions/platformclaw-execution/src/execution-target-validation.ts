import path from "node:path";
import type { AssignedVmTargetSnapshot } from "./backend.js";

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

export function requireSingleLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed) || trimmed.includes(String.fromCharCode(0))) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid`);
  }
  return requireSingleLine(value, label);
}

export function parseExecutionEnvironment(
  value: unknown,
): NonNullable<AssignedVmTargetSnapshot["executionEnvironment"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("VM execution environment is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.pathPrepend) || candidate.pathPrepend.length > 32) {
    throw new Error("VM execution PATH is invalid");
  }
  const pathPrepend = candidate.pathPrepend.map((entry) => {
    const normalized = requireString(entry, "VM execution PATH");
    if (
      !path.posix.isAbsolute(normalized) ||
      path.posix.normalize(normalized) !== normalized ||
      normalized.includes(":")
    ) {
      throw new Error("VM execution PATH is invalid");
    }
    return normalized;
  });
  if (
    !candidate.variables ||
    typeof candidate.variables !== "object" ||
    Array.isArray(candidate.variables)
  ) {
    throw new Error("VM execution variables are invalid");
  }
  const entries = Object.entries(candidate.variables);
  if (entries.length > 64) {
    throw new Error("VM execution variables are invalid");
  }
  const variables: Record<string, string> = {};
  for (const [name, rawValue] of entries) {
    const upper = name.toUpperCase();
    if (
      !VM_ENV_NAME_PATTERN.test(name) ||
      VM_ENV_BLOCKED_NAMES.has(upper) ||
      upper.startsWith("LD_") ||
      upper.startsWith("DYLD_") ||
      upper.startsWith("OPENCLAW_") ||
      upper.startsWith("PLATFORMCLAW_") ||
      typeof rawValue !== "string" ||
      Buffer.byteLength(rawValue) > 4096 ||
      rawValue.includes("\u0000") ||
      rawValue.includes("\r") ||
      rawValue.includes("\n")
    ) {
      throw new Error(`VM execution variable is invalid: ${name}`);
    }
    variables[name] = rawValue;
  }
  return { pathPrepend, variables };
}

export function parseClaudeCodeExecutablePath(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const executablePath = requireString(value, "Claude Code executable path");
  if (
    !path.posix.isAbsolute(executablePath) ||
    path.posix.normalize(executablePath) !== executablePath ||
    executablePath.length > 4096
  ) {
    throw new Error("Claude Code executable path is invalid");
  }
  return executablePath;
}
