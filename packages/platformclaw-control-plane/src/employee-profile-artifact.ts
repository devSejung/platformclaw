import type { EmployeeDirectoryProfile } from "./employee-auth-client.js";

const PROFILE_SCHEMA = "platformclaw.employee-profile.v1";

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizedValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
}

function normalizedAttributes(
  attributes: EmployeeDirectoryProfile["attributes"],
): Record<string, string | readonly string[]> {
  const normalized: Array<[string, string | readonly string[]]> = [];
  for (const [rawKey, rawValue] of Object.entries(attributes).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    if (typeof rawValue === "string") {
      const value = optionalText(rawValue);
      if (value) {
        normalized.push([key, value]);
      }
      continue;
    }
    const values = normalizedValues(rawValue);
    if (values.length > 0) {
      normalized.push([key, values]);
    }
  }
  return Object.fromEntries(normalized);
}

function serializeArtifact(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/[<>&]/gu, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      default:
        return "\\u0026";
    }
  })}\n`;
}

export function renderEmployeeProfileArtifact(profile: EmployeeDirectoryProfile): string {
  const employeeId = profile.employeeId.trim();
  if (!employeeId) {
    throw new Error("employee profile requires an employee id");
  }
  return serializeArtifact({
    schema: PROFILE_SCHEMA,
    profile: {
      employeeId,
      ...(optionalText(profile.displayName)
        ? { displayName: optionalText(profile.displayName) }
        : {}),
      ...(optionalText(profile.email) ? { email: optionalText(profile.email) } : {}),
      ...(optionalText(profile.department) ? { department: optionalText(profile.department) } : {}),
      ...(optionalText(profile.part) ? { part: optionalText(profile.part) } : {}),
      ...(optionalText(profile.confluenceSpace)
        ? { confluenceSpace: optionalText(profile.confluenceSpace) }
        : {}),
      ...(optionalText(profile.notes) ? { notes: optionalText(profile.notes) } : {}),
      groups: normalizedValues(profile.groups),
      attributes: normalizedAttributes(profile.attributes),
    },
  });
}
