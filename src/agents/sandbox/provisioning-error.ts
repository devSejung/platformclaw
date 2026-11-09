import { collectErrorGraphCandidates, formatErrorMessage } from "../../infra/errors.js";

const SANDBOX_PROVISIONING_ERROR_CODE = "sandbox_provisioning";
const SANDBOX_SKILL_REFRESH_BUSY_CODE = "sandbox-skill-refresh-busy";

/** A managed skill mount update must wait for the current sandbox owner to finish. */
export class SandboxSkillRefreshBusyError extends Error {
  readonly code = SANDBOX_SKILL_REFRESH_BUSY_CODE;

  constructor() {
    super("Please try again shortly while the sandbox applies the updated skill settings.");
    this.name = "SandboxSkillRefreshBusyError";
  }
}

export function isSandboxSkillRefreshBusyError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (candidate) => [
    candidate.cause,
    candidate.error,
    ...(Array.isArray(candidate.errors) ? candidate.errors : []),
  ]).some(
    (candidate) =>
      candidate instanceof SandboxSkillRefreshBusyError ||
      (typeof candidate === "object" &&
        candidate !== null &&
        "code" in candidate &&
        candidate.code === SANDBOX_SKILL_REFRESH_BUSY_CODE),
  );
}

/** Model-independent sandbox setup failure that must not consume model fallbacks. */
class SandboxProvisioningError extends Error {
  readonly code = SANDBOX_PROVISIONING_ERROR_CODE;
  readonly backendId: string;

  constructor(message: string, params: { backendId: string; cause?: unknown }) {
    super(message, { cause: params.cause });
    this.name = "SandboxProvisioningError";
    this.backendId = params.backendId;
  }
}

/** Preserve an existing typed failure or attach sandbox ownership to a backend setup error. */
export function toSandboxProvisioningError(error: unknown, backendId: string) {
  if (error instanceof SandboxProvisioningError) {
    return error;
  }
  const message =
    formatErrorMessage(error) || `Sandbox backend "${backendId}" provisioning failed.`;
  return new SandboxProvisioningError(message, { backendId, cause: error });
}

/** Recognize the provisioning marker through ordinary error-wrapper cause chains. */
export function isSandboxProvisioningError(error: unknown, seen: Set<object> = new Set()): boolean {
  if (error instanceof SandboxProvisioningError) {
    return true;
  }
  if (!error || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    cause?: unknown;
    error?: unknown;
    errors?: unknown;
  };
  if (
    candidate.name === "SandboxProvisioningError" &&
    candidate.code === SANDBOX_PROVISIONING_ERROR_CODE
  ) {
    return true;
  }
  return [
    candidate.cause,
    candidate.error,
    ...(Array.isArray(candidate.errors) ? candidate.errors : []),
  ].some((nested) => isSandboxProvisioningError(nested, seen));
}
