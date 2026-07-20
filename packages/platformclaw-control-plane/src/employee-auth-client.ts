import { isIP } from "node:net";
import type { EnterpriseAuthProvider, EnterprisePrincipal } from "./contracts.js";

export const EMPLOYEE_AUTH_LOGIN_URL_ENV = "PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL";
export const EMPLOYEE_AUTH_BEARER_TOKEN_ENV = "PLATFORMCLAW_EMPLOYEE_AUTH_BEARER_TOKEN";

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

export type EmployeeDirectoryProfile = {
  employeeId: string;
  accountId: string;
  subject: string;
  displayName?: string;
  email?: string;
  department?: string;
  part?: string;
  confluenceSpace?: string;
  notes?: string;
  groups: string[];
  attributes: Readonly<Record<string, string | readonly string[]>>;
};

export type EmployeeAuthRequestContext = {
  clientIp?: string;
  gatewayUrl?: string;
  userAgent?: string;
};

export type EmployeePasswordCredentials = {
  identifier: string;
  password: string;
};

export type EmployeeAuthenticationResult =
  | {
      status: "authenticated";
      principal: EnterprisePrincipal;
      profile: EmployeeDirectoryProfile;
    }
  | { status: "rejected"; message: string }
  | { status: "unavailable"; message: string };

export interface EmployeeAuthenticator {
  authenticatePassword(params: {
    login: EmployeePasswordCredentials;
    context: EmployeeAuthRequestContext;
  }): Promise<EmployeeAuthenticationResult>;
}

export type EmployeeAuthClientConfig = {
  loginUrl: string;
  bearerToken?: string;
  provider?: EnterpriseAuthProvider;
  timeoutMs?: number;
};

type Fetch = typeof globalThis.fetch;

type ExternalAuthFailure = {
  authenticated: false;
  message?: string;
};

type ExternalAuthSuccess = {
  authenticated: true;
  employeeId: string;
  accountId?: string;
  subject?: string;
  email?: string;
  name?: string;
  displayName?: string;
  department?: string;
  part?: string;
  confluenceSpace?: string;
  notes?: string;
  groups?: string[];
  attributes?: EmployeeDirectoryProfile["attributes"];
};

type ExternalAuthResponse = ExternalAuthFailure | ExternalAuthSuccess;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(value.map(optionalString).filter((entry): entry is string => Boolean(entry))),
  ].toSorted();
}

function parseAttributes(value: unknown): Record<string, string | readonly string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const attributes: Record<string, string | readonly string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }
    const scalar = optionalString(raw);
    if (scalar) {
      attributes[normalizedKey] = scalar;
      continue;
    }
    const values = stringArray(raw);
    if (values.length > 0) {
      attributes[normalizedKey] = values;
    }
  }
  return attributes;
}

function parseResponse(value: unknown): ExternalAuthResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.authenticated === false) {
    return { authenticated: false, message: optionalString(record.message) };
  }
  if (record.authenticated !== true) {
    return null;
  }
  const employeeId = optionalString(record.employeeId);
  if (!employeeId) {
    return null;
  }
  return {
    authenticated: true,
    employeeId,
    accountId: optionalString(record.accountId),
    subject: optionalString(record.subject),
    email: optionalString(record.email),
    name: optionalString(record.name),
    displayName: optionalString(record.displayName),
    department: optionalString(record.department),
    part: optionalString(record.part),
    confluenceSpace: optionalString(record.confluenceSpace),
    notes: optionalString(record.notes) ?? optionalString(record.note),
    groups: stringArray(record.groups),
    attributes: parseAttributes(record.attributes),
  };
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(hostname);
  const isLoopback =
    hostname === "localhost" ||
    (ipVersion === 4 && hostname.split(".", 1)[0] === "127") ||
    (ipVersion === 6 && hostname === "::1");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(
      `${EMPLOYEE_AUTH_LOGIN_URL_ENV} must use https; http is allowed only for a loopback mock`,
    );
  }
  return url.toString();
}

export function loadEmployeeAuthClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmployeeAuthClientConfig {
  const loginUrl = env[EMPLOYEE_AUTH_LOGIN_URL_ENV]?.trim();
  if (!loginUrl) {
    throw new Error(`${EMPLOYEE_AUTH_LOGIN_URL_ENV} is required`);
  }
  const bearerToken = optionalString(env[EMPLOYEE_AUTH_BEARER_TOKEN_ENV]);
  return {
    loginUrl: normalizeUrl(loginUrl),
    ...(bearerToken ? { bearerToken } : {}),
    provider: "ldap",
  };
}

export class HttpEmployeeAuthenticator implements EmployeeAuthenticator {
  private readonly config: Required<
    Pick<EmployeeAuthClientConfig, "loginUrl" | "provider" | "timeoutMs">
  > &
    Pick<EmployeeAuthClientConfig, "bearerToken">;

  constructor(
    config: EmployeeAuthClientConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.config = {
      ...config,
      loginUrl: normalizeUrl(config.loginUrl),
      provider: config.provider ?? "ldap",
      timeoutMs: config.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
    };
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      throw new Error("employee auth timeout must be a positive number");
    }
  }

  async authenticatePassword(params: {
    login: EmployeePasswordCredentials;
    context: EmployeeAuthRequestContext;
  }): Promise<EmployeeAuthenticationResult> {
    const identifier = params.login.identifier.trim();
    if (!identifier || !params.login.password) {
      return { status: "rejected", message: "identifier and password are required" };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.bearerToken) {
      headers.Authorization = `Bearer ${this.config.bearerToken}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.loginUrl, {
        method: "POST",
        redirect: "error",
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        body: JSON.stringify({
          identifier,
          password: params.login.password,
          clientIp: params.context.clientIp ?? null,
          gatewayUrl: params.context.gatewayUrl ?? null,
          userAgent: params.context.userAgent ?? null,
        }),
      });
    } catch {
      return { status: "unavailable", message: "employee authentication service unavailable" };
    }

    let parsed: ExternalAuthResponse | null;
    try {
      parsed = parseResponse(await response.json());
    } catch {
      return { status: "unavailable", message: "employee authentication response was invalid" };
    }
    if (!parsed) {
      return { status: "unavailable", message: "employee authentication response was invalid" };
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          status: "rejected",
          message: parsed.authenticated
            ? "invalid credentials"
            : (parsed.message ?? "invalid credentials"),
        };
      }
      return {
        status: "unavailable",
        message: `employee authentication failed (${response.status})`,
      };
    }
    if (!parsed.authenticated) {
      return { status: "rejected", message: parsed.message ?? "invalid credentials" };
    }

    const accountId = parsed.accountId?.toLowerCase() ?? parsed.employeeId.toLowerCase();
    // LDAP has no separate stable subject in the deployed contract. SAML can supply one later
    // without changing the control-plane identity contract.
    const subject = parsed.subject ?? accountId;
    if (this.config.provider === "saml" && !parsed.subject) {
      return {
        status: "unavailable",
        message: "SAML authentication response was missing its stable subject",
      };
    }
    const displayName = parsed.displayName ?? parsed.name;
    const profile: EmployeeDirectoryProfile = {
      employeeId: parsed.employeeId,
      accountId,
      subject,
      displayName,
      email: parsed.email,
      department: parsed.department,
      part: parsed.part,
      confluenceSpace: parsed.confluenceSpace,
      notes: parsed.notes,
      groups: parsed.groups ?? [],
      attributes: parsed.attributes ?? {},
    };
    return {
      status: "authenticated",
      profile,
      principal: {
        provider: this.config.provider,
        subject,
        accountId,
        employeeId: parsed.employeeId,
        displayName,
        email: profile.email,
        department: profile.department,
        groups: profile.groups,
      },
    };
  }
}
