import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const CODING_AGENT_IDS = ["claude", "codex", "opencode"] as const;
export type CodingAgentId = (typeof CODING_AGENT_IDS)[number];

export const CLAUDE_GATEWAY_ENVIRONMENT_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ADMIN_API_URL",
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
] as const;
export type ClaudeGatewayEnvironmentKey = (typeof CLAUDE_GATEWAY_ENVIRONMENT_KEYS)[number];
export type ClaudeGatewayEnvironment = Record<ClaudeGatewayEnvironmentKey, string>;

type CodingAgentConfigurationBase = {
  enabled: boolean;
  executablePath: string;
};

export type ClaudeCodingAgentConfiguration = CodingAgentConfigurationBase & {
  agent: "claude";
  environment: ClaudeGatewayEnvironment;
};

export type PlainCodingAgentConfiguration = CodingAgentConfigurationBase & {
  agent: "codex" | "opencode";
};

export type CodingAgentConfiguration =
  | ClaudeCodingAgentConfiguration
  | PlainCodingAgentConfiguration;

export type CodingAgentDiagnosticStage = "executable" | "helper" | "acp";
export type CodingAgentDiagnosticStatus = "passed" | "failed" | "skipped";

export type CodingAgentDiagnostic = {
  stage: CodingAgentDiagnosticStage;
  status: CodingAgentDiagnosticStatus;
  message: string;
};

export type CodingAgentProbeResult = {
  agent: CodingAgentId;
  executablePath?: string;
  reportedVersion?: string;
  environment?: Partial<ClaudeGatewayEnvironment>;
  diagnostics: CodingAgentDiagnostic[];
};

export type CodingAgentVmProbeResult = CodingAgentProbeResult & {
  allocationId: string;
  targetRevision: number;
};

export type CodingAgentCheckSnapshot = Omit<CodingAgentProbeResult, "environment"> & {
  checkedAt: number;
};

export type PersonalCodingAgentSettings = {
  hasSavedConfiguration: boolean;
  configuration: CodingAgentConfiguration;
  lastCheck?: CodingAgentCheckSnapshot;
};

const MAX_EXECUTABLE_PATH_BYTES = 4096;
const MAX_ENVIRONMENT_VALUE_BYTES = 4096;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 2048;
const MAX_REPORTED_VERSION_BYTES = 512;
const TEXT_ENCODER = new TextEncoder();

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
  });
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${extra.join(", ")}`);
  }
}

export function isCodingAgentId(value: unknown): value is CodingAgentId {
  return typeof value === "string" && CODING_AGENT_IDS.some((agent) => agent === value);
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    TEXT_ENCODER.encode(value).byteLength > maxBytes ||
    containsControlCharacter(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function executablePath(value: unknown, enabled: boolean): string {
  const path = boundedString(
    value,
    "coding agent executable path",
    MAX_EXECUTABLE_PATH_BYTES,
  ).trim();
  const pathParts = path.split("/");
  if (
    path &&
    (!path.startsWith("/") ||
      path.endsWith("/") ||
      path.includes("\\") ||
      pathParts.slice(1).some((part) => !part || part === "." || part === ".."))
  ) {
    throw new Error("coding agent executable path must be an absolute VM path");
  }
  if (enabled && !path) {
    throw new Error("coding agent executable path is required when enabled");
  }
  return path;
}

function gatewayEnvironmentValue(value: unknown, key: ClaudeGatewayEnvironmentKey): string {
  const normalized = boundedString(
    value,
    `Claude gateway value ${key}`,
    MAX_ENVIRONMENT_VALUE_BYTES,
  ).trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    throw new Error(
      `${key} has literal surrounding quotes; remove the first and last quote characters`,
    );
  }
  if (normalized) {
    if (key === "OIDC_CLIENT_ID") {
      if (/\s/u.test(normalized)) {
        throw new Error("OIDC_CLIENT_ID must not contain whitespace");
      }
    } else {
      let parsed: URL;
      try {
        parsed = new URL(normalized);
      } catch {
        throw new Error(`${key} must be a valid http(s) URL`);
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error(`${key} must be an http(s) URL without embedded credentials`);
      }
    }
  }
  return normalized;
}

export function parseCodingAgentConfiguration(value: unknown): CodingAgentConfiguration {
  if (!isRecord(value) || !isCodingAgentId(value.agent) || typeof value.enabled !== "boolean") {
    throw new Error("coding agent configuration is invalid");
  }
  assertOnlyKeys(
    value,
    value.agent === "claude"
      ? ["agent", "enabled", "executablePath", "environment"]
      : ["agent", "enabled", "executablePath"],
    "coding agent configuration",
  );
  const path = executablePath(value.executablePath, value.enabled);
  if (value.agent !== "claude") {
    if ("environment" in value) {
      throw new Error(`${value.agent} does not accept Claude gateway environment settings`);
    }
    return { agent: value.agent, enabled: value.enabled, executablePath: path };
  }
  if (!isRecord(value.environment)) {
    throw new Error("Claude gateway environment settings are required");
  }
  const environmentRecord = value.environment;
  assertOnlyKeys(environmentRecord, CLAUDE_GATEWAY_ENVIRONMENT_KEYS, "Claude gateway environment");
  const environment = Object.fromEntries(
    CLAUDE_GATEWAY_ENVIRONMENT_KEYS.map((key) => [
      key,
      gatewayEnvironmentValue(environmentRecord[key], key),
    ]),
  ) as ClaudeGatewayEnvironment;
  if (value.enabled) {
    const missing = CLAUDE_GATEWAY_ENVIRONMENT_KEYS.filter((key) => !environment[key]);
    if (missing.length > 0) {
      throw new Error(`Claude gateway values are required when enabled: ${missing.join(", ")}`);
    }
  }
  return { agent: "claude", enabled: value.enabled, executablePath: path, environment };
}

export function emptyCodingAgentConfiguration(agent: "claude"): ClaudeCodingAgentConfiguration;
export function emptyCodingAgentConfiguration(
  agent: "codex" | "opencode",
): PlainCodingAgentConfiguration;
export function emptyCodingAgentConfiguration(agent: CodingAgentId): CodingAgentConfiguration;
export function emptyCodingAgentConfiguration(agent: CodingAgentId): CodingAgentConfiguration {
  if (agent === "claude") {
    return {
      agent,
      enabled: false,
      executablePath: "",
      environment: {
        ANTHROPIC_BASE_URL: "",
        ADMIN_API_URL: "",
        OIDC_ISSUER_URL: "",
        OIDC_CLIENT_ID: "",
      },
    };
  }
  return { agent, enabled: false, executablePath: "" };
}

export function emptyCodingAgentConfigurations(): CodingAgentConfiguration[] {
  return CODING_AGENT_IDS.map(emptyCodingAgentConfiguration);
}

function parseDiagnostic(value: unknown): CodingAgentDiagnostic {
  if (
    !isRecord(value) ||
    (value.stage !== "executable" && value.stage !== "helper" && value.stage !== "acp") ||
    (value.status !== "passed" && value.status !== "failed" && value.status !== "skipped")
  ) {
    throw new Error("coding agent diagnostic is invalid");
  }
  assertOnlyKeys(value, ["stage", "status", "message"], "coding agent diagnostic");
  const message = boundedString(
    value.message,
    "coding agent diagnostic message",
    MAX_DIAGNOSTIC_MESSAGE_BYTES,
  ).trim();
  if (!message) {
    throw new Error("coding agent diagnostic message is required");
  }
  return { stage: value.stage, status: value.status, message };
}

export function parseCodingAgentProbeResult(
  value: unknown,
  expectedAgent?: CodingAgentId,
): CodingAgentProbeResult {
  if (!isRecord(value) || !isCodingAgentId(value.agent) || !Array.isArray(value.diagnostics)) {
    throw new Error("development VM returned an invalid coding agent result");
  }
  assertOnlyKeys(
    value,
    ["agent", "executablePath", "reportedVersion", "environment", "diagnostics"],
    "coding agent result",
  );
  if (expectedAgent && value.agent !== expectedAgent) {
    throw new Error("development VM returned a result for a different coding agent");
  }
  const diagnostics = value.diagnostics.map(parseDiagnostic);
  if (diagnostics.length === 0 || diagnostics.length > 3) {
    throw new Error("development VM returned an invalid coding agent diagnostic set");
  }
  if (new Set(diagnostics.map((diagnostic) => diagnostic.stage)).size !== diagnostics.length) {
    throw new Error("development VM returned duplicate coding agent diagnostic stages");
  }
  const parsed: CodingAgentProbeResult = { agent: value.agent, diagnostics };
  if (value.executablePath !== undefined) {
    parsed.executablePath = executablePath(value.executablePath, true);
  }
  if (value.reportedVersion !== undefined) {
    const reportedVersion = boundedString(
      value.reportedVersion,
      "coding agent reported version",
      MAX_REPORTED_VERSION_BYTES,
    ).trim();
    if (!reportedVersion) {
      throw new Error("coding agent reported version is invalid");
    }
    parsed.reportedVersion = reportedVersion;
  }
  if (value.environment !== undefined) {
    if (value.agent !== "claude" || !isRecord(value.environment)) {
      throw new Error("only Claude detection may return gateway environment settings");
    }
    const environmentRecord = value.environment;
    assertOnlyKeys(
      environmentRecord,
      CLAUDE_GATEWAY_ENVIRONMENT_KEYS,
      "detected Claude environment",
    );
    parsed.environment = Object.fromEntries(
      CLAUDE_GATEWAY_ENVIRONMENT_KEYS.flatMap((key) =>
        environmentRecord[key] === undefined
          ? []
          : [
              [
                key,
                boundedString(
                  environmentRecord[key],
                  `detected Claude environment ${key}`,
                  MAX_ENVIRONMENT_VALUE_BYTES,
                ).trim(),
              ],
            ],
      ),
    ) as Partial<ClaudeGatewayEnvironment>;
  }
  return parsed;
}

export function parseCodingAgentVmProbeResult(
  value: unknown,
  expectedAgent?: CodingAgentId,
): CodingAgentVmProbeResult {
  if (
    !isRecord(value) ||
    typeof value.allocationId !== "string" ||
    !value.allocationId.trim() ||
    !Number.isSafeInteger(value.targetRevision) ||
    Number(value.targetRevision) < 0
  ) {
    throw new Error("development VM returned an invalid coding agent target witness");
  }
  const probe = { ...value };
  delete probe.allocationId;
  delete probe.targetRevision;
  return {
    ...parseCodingAgentProbeResult(probe, expectedAgent),
    allocationId: value.allocationId,
    targetRevision: Number(value.targetRevision),
  };
}

export function parseCodingAgentCheckSnapshot(value: unknown): CodingAgentCheckSnapshot {
  if (!isRecord(value) || !Number.isSafeInteger(value.checkedAt) || Number(value.checkedAt) < 0) {
    throw new Error("coding agent check snapshot is invalid");
  }
  assertOnlyKeys(
    value,
    ["agent", "checkedAt", "executablePath", "reportedVersion", "diagnostics"],
    "coding agent check snapshot",
  );
  const probe = { ...value };
  delete probe.checkedAt;
  const result = parseCodingAgentProbeResult(probe);
  if (result.environment) {
    throw new Error("saved coding agent checks must not contain detected environment values");
  }
  return { ...result, checkedAt: Number(value.checkedAt) };
}
