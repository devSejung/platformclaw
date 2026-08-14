import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { BrowserLoginResult, BrowserAuthService } from "./browser-auth-service.js";
import type { EmployeeAuthenticationResult } from "./employee-auth-client.js";

export const PLATFORMCLAW_ADSSO_PATH = "/employee/auth/adsso";
export const PLATFORMCLAW_SSO_CALLBACK_PATH = "/employee/auth/sso-callback";

const CONTRACT_VERSION = 1;
const ISSUER = "platformclaw-auth";
const AUDIENCE = "platformclaw";
const AUTH_METHOD = "saml";
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_HANDOFF_TTL_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 30;
const MAX_PROFILE_FIELD_LENGTH = 512;
const MAX_TRACKED_HANDOFFS = 4_096;

export type EmployeeSsoConfig = {
  loginUrl: string;
  handoffSecret: string;
};

type EmployeeAuthenticationSuccess = Extract<
  EmployeeAuthenticationResult,
  { status: "authenticated" }
>;

type VerifiedEmployeeSsoHandoff = {
  auth: EmployeeAuthenticationSuccess;
  expiresAtSeconds: number;
};

export type EmployeeSsoCompletion = { status: "invalid-handoff" } | BrowserLoginResult;

function readString(
  record: Record<string, unknown>,
  key: string,
  required: boolean,
): string | undefined {
  const value = record[key];
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PROFILE_FIELD_LENGTH) {
    return undefined;
  }
  return normalized;
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function verifyHandoff(
  token: string | undefined,
  secret: string,
  nowSeconds: number,
): VerifiedEmployeeSsoHandoff | null {
  if (!token || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const payloadBytes = decodeCanonicalBase64Url(parts[0] ?? "");
  const signature = decodeCanonicalBase64Url(parts[1] ?? "");
  if (!payloadBytes || !signature) {
    return null;
  }
  const expected = createHmac("sha256", secret).update(payloadBytes).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const issuedAt = record.iat;
  const expiresAt = record.exp;
  if (
    record.contractVersion !== CONTRACT_VERSION ||
    record.kind !== "sso" ||
    record.issuer !== ISSUER ||
    record.audience !== AUDIENCE ||
    record.authMethod !== AUTH_METHOD ||
    typeof issuedAt !== "number" ||
    !Number.isInteger(issuedAt) ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt) ||
    issuedAt > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
    expiresAt <= nowSeconds ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_HANDOFF_TTL_SECONDS
  ) {
    return null;
  }

  const employeeId = readString(record, "employeeId", true);
  const agentId = readString(record, "agentId", true);
  const sessionKey = readString(record, "sessionKey", true);
  if (!employeeId || !agentId || !sessionKey) {
    return null;
  }
  const accountId = employeeId.toLowerCase();
  const displayName = readString(record, "name", false);
  const email = readString(record, "email", false);
  const department = readString(record, "department", false);
  const part = readString(record, "part", false);
  const confluenceSpace = readString(record, "confluenceSpace", false);
  return {
    expiresAtSeconds: expiresAt,
    auth: {
      status: "authenticated",
      principal: {
        provider: "saml",
        // Contract v1 has no separate NameID field; its canonical login ID is stable.
        subject: accountId,
        accountId,
        employeeId,
        displayName,
        email,
        department,
        groups: [],
      },
      profile: {
        employeeId,
        accountId,
        subject: accountId,
        displayName,
        email,
        department,
        part,
        confluenceSpace,
        groups: [],
        attributes: {},
      },
    },
  };
}

export function normalizeEmployeeSsoLoginUrl(raw: string): string {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.split(".")[0] === "127");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("employee ADSSO URL must use https; http is allowed only for a loopback mock");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("employee ADSSO URL must not include credentials, query, or fragment");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith("/login") ? pathname : `${pathname}/login`;
  return url.toString();
}

export class EmployeeSsoService {
  readonly loginUrl: string;
  private readonly usedTokens = new Map<string, number>();
  private readonly pendingTokens = new Set<string>();

  constructor(
    private readonly options: {
      authService: BrowserAuthService;
      config: EmployeeSsoConfig;
      now?: () => number;
    },
  ) {
    this.loginUrl = normalizeEmployeeSsoLoginUrl(options.config.loginUrl);
    if (Buffer.byteLength(options.config.handoffSecret, "utf8") < 32) {
      throw new Error("employee ADSSO handoff secret must contain at least 32 bytes");
    }
  }

  async complete(
    token: string | undefined,
    currentSession?: { value: string },
  ): Promise<EmployeeSsoCompletion> {
    const nowSeconds = Math.floor((this.options.now ?? Date.now)() / 1000);
    for (const [digest, expiresAt] of this.usedTokens) {
      if (expiresAt <= nowSeconds) {
        this.usedTokens.delete(digest);
      }
    }
    const handoff = verifyHandoff(token, this.options.config.handoffSecret, nowSeconds);
    if (!handoff || !token) {
      return { status: "invalid-handoff" };
    }
    const digest = createHash("sha256").update(token, "utf8").digest("base64url");
    if (this.pendingTokens.has(digest) || this.usedTokens.has(digest)) {
      return { status: "invalid-handoff" };
    }
    if (this.pendingTokens.size + this.usedTokens.size >= MAX_TRACKED_HANDOFFS) {
      return { status: "invalid-handoff" };
    }
    this.pendingTokens.add(digest);
    try {
      const result = await this.options.authService.loginAuthenticated({
        auth: handoff.auth,
        currentSession,
      });
      if (result.status === "authenticated") {
        // The signed v1 token has no nonce, so retain its digest only through expiry.
        this.usedTokens.set(digest, handoff.expiresAtSeconds);
      }
      return result;
    } finally {
      this.pendingTokens.delete(digest);
    }
  }
}
