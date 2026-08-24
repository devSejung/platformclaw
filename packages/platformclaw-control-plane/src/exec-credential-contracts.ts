export const EXEC_CREDENTIAL_LIMITS = {
  perUser: 32,
  valueBytes: 32 * 1024,
  aggregateBytes: 128 * 1024,
} as const;

const EXEC_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

const RESERVED_EXEC_ENV_NAMES = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "HOME",
  "IFS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "OPTERR",
  "PATH",
  "PS4",
  "PYTHONHOME",
  "PYTHONPATH",
  "SHELL",
  "SHELLOPTS",
  "SSH_AUTH_SOCK",
]);

export function normalizeExecEnvName(value: string): string {
  const name = value.trim();
  if (!EXEC_ENV_NAME_PATTERN.test(name) || RESERVED_EXEC_ENV_NAMES.has(name)) {
    throw new Error("environment variable name is invalid or reserved");
  }
  return name;
}

export type ExecCredentialEnvelope = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyId: string;
  formatVersion: 1;
};

export type StoredExecCredential = ExecCredentialEnvelope & {
  userId: string;
  envName: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export type ExecCredentialDefinition = {
  envName: string;
  configured?: boolean;
  revision?: number;
  updatedAt?: number;
};
