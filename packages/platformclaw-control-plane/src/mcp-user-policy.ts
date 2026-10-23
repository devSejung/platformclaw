import { createHash } from "node:crypto";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertAdditionalMcpHeader,
  parseMcpHeaderGuides,
  type McpHeaderGuide,
} from "./mcp-header-policy.js";

export type UserMcpAuthKind = "bearer" | "api_key" | "oauth";
export type UserMcpServerPolicy = {
  serverName: string;
  credentialMode: "none" | "shared" | "personal";
  auth?: UserMcpAuthKind;
  headerName?: string;
  scope?: string;
  url: string;
  enabled: boolean;
  commonHeaderNames: string[];
  configuredOAuth: boolean;
  headerGuides: McpHeaderGuide[];
};

export function mcpPolicyFingerprint(policy: UserMcpServerPolicy): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        policy.url,
        policy.credentialMode,
        policy.auth ?? null,
        policy.headerName ?? null,
        policy.scope ?? null,
      ]),
    )
    .digest("hex");
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validPolicy(value: unknown): value is UserMcpServerPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.serverName === "string" &&
    policy.serverName.length > 0 &&
    policy.serverName.length <= 128 &&
    policy.serverName.trim() === policy.serverName &&
    isSafeHttpUrl(policy.url) &&
    (policy.credentialMode === "none" ||
      policy.credentialMode === "shared" ||
      policy.credentialMode === "personal") &&
    (policy.credentialMode !== "personal" ||
      policy.auth === "bearer" ||
      policy.auth === "api_key" ||
      policy.auth === "oauth") &&
    typeof policy.enabled === "boolean" &&
    typeof policy.configuredOAuth === "boolean" &&
    Array.isArray(policy.commonHeaderNames) &&
    policy.commonHeaderNames.every((name) => typeof name === "string") &&
    Array.isArray(policy.headerGuides) &&
    (policy.auth !== "api_key" ||
      (typeof policy.headerName === "string" &&
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(policy.headerName))) &&
    (policy.scope === undefined ||
      (typeof policy.scope === "string" &&
        policy.scope.length <= 2_048 &&
        !policy.scope.includes("\0") &&
        !policy.scope.includes("\r") &&
        !policy.scope.includes("\n")))
  );
}

export function protectedMcpHeaders(policy: UserMcpServerPolicy): string[] {
  return [
    ...policy.commonHeaderNames,
    ...(policy.credentialMode === "personal"
      ? [policy.auth === "api_key" ? policy.headerName! : "Authorization"]
      : []),
    ...(policy.configuredOAuth ? ["Authorization"] : []),
  ];
}

export function validateAdditionalMcpHeaders(
  headers: Record<string, string>,
  policy: UserMcpServerPolicy,
) {
  for (const name of Object.keys(headers)) {
    assertAdditionalMcpHeader(name, protectedMcpHeaders(policy));
  }
  return headers;
}

export function parseMcpUserCatalog(value: unknown): UserMcpServerPolicy[] {
  const result = asNullableRecord(value);
  if (!Array.isArray(result?.servers) || !result.servers.every(validPolicy)) {
    throw new Error("MCP catalog response is invalid");
  }
  for (const policy of result.servers) {
    if (policy.auth === "api_key") {
      assertAdditionalMcpHeader(policy.headerName!, []);
    }
    parseMcpHeaderGuides(policy.headerGuides, protectedMcpHeaders(policy));
  }
  return result.servers;
}
