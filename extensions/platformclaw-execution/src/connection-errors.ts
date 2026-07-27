export class PlatformClawVmAuthenticationError extends Error {
  constructor() {
    super("development VM authentication failed");
    this.name = "PlatformClawVmAuthenticationError";
  }
}

export type PlatformClawVmConnectionFailure = {
  code: "INVALID_REQUEST" | "UNAVAILABLE";
  kind:
    | "vm_authentication_failed"
    | "vm_dns_failed"
    | "vm_connection_refused"
    | "vm_connection_timeout"
    | "vm_host_key_failed"
    | "vm_connection_failed";
  message: string;
  diagnostic: string;
};

function boundedDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error).slice(0, 500);
  }
  const value = error as Error & { code?: unknown; exitCode?: unknown; stderr?: unknown };
  const code = value.exitCode ?? value.code;
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  return [error.name, code === undefined ? "" : `code=${String(code)}`, stderr || error.message]
    .filter(Boolean)
    .join("; ")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 500);
}

export function classifyVmConnectionFailure(error: unknown): PlatformClawVmConnectionFailure {
  const diagnostic = boundedDiagnostic(error);
  if (error instanceof PlatformClawVmAuthenticationError) {
    return {
      code: "INVALID_REQUEST",
      kind: "vm_authentication_failed",
      message: "development VM authentication failed; update the AD password and try again",
      diagnostic,
    };
  }
  if (
    /Could not resolve hostname|Name or service not known|Temporary failure in name resolution/iu.test(
      diagnostic,
    )
  ) {
    return {
      code: "UNAVAILABLE",
      kind: "vm_dns_failed",
      message: "SafeConnect host name could not be resolved",
      diagnostic,
    };
  }
  if (/Connection refused/iu.test(diagnostic)) {
    return {
      code: "UNAVAILABLE",
      kind: "vm_connection_refused",
      message: "SafeConnect refused the SSH connection",
      diagnostic,
    };
  }
  if (/AbortError|timed out|timeout/iu.test(diagnostic)) {
    return {
      code: "UNAVAILABLE",
      kind: "vm_connection_timeout",
      message: "SafeConnect SSH connection timed out",
      diagnostic,
    };
  }
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No ED25519 host key is known/iu.test(
      diagnostic,
    )
  ) {
    return {
      code: "INVALID_REQUEST",
      kind: "vm_host_key_failed",
      message: "SafeConnect host key verification failed; ask an administrator to verify the key",
      diagnostic,
    };
  }
  return {
    code: "UNAVAILABLE",
    kind: "vm_connection_failed",
    message: "development VM connection failed; check the Gateway logs for the recorded cause",
    diagnostic,
  };
}

/** The PlatformClaw sshpass launcher preserves sshpass exit 5 for rejected credentials. */
export function isSshpassAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const result = error as { code?: unknown; exitCode?: unknown };
  return result.code === 5 || result.exitCode === 5;
}
