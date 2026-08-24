import { ControlPlaneConflictError, ControlPlaneStateError } from "./contracts.js";
import { required } from "./sqlite-store-core.js";

function boundedOrganizationText(value: string, field: string, max: number): string {
  const text = required(value, field);
  if (text.length > max) {
    throw new ControlPlaneStateError(`${field} must not exceed ${max} characters`);
  }
  return text;
}

export function boundedOrganizationReason(value: string, field: string): string {
  return boundedOrganizationText(value, field, 500);
}

export function boundedOrganizationScopeName(value: string): string {
  return boundedOrganizationText(value, "scope.name", 120);
}

export function assertOrganizationScopeRevision(
  actual: number,
  expected: number | undefined,
): void {
  if (expected !== undefined && actual !== expected) {
    throw new ControlPlaneConflictError(
      "organization_scope_changed",
      "organization scope changed since it was loaded",
    );
  }
}
