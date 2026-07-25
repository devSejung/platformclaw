export class PlatformClawVmAuthenticationError extends Error {
  constructor() {
    super("development VM authentication failed");
    this.name = "PlatformClawVmAuthenticationError";
  }
}

/** The PlatformClaw sshpass launcher preserves sshpass exit 5 for rejected credentials. */
export function isSshpassAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const result = error as { code?: unknown; exitCode?: unknown };
  return result.code === 5 || result.exitCode === 5;
}
