import type { DatabaseSync } from "node:sqlite";
import {
  CLAUDE_GATEWAY_ENVIRONMENT_KEYS,
  emptyCodingAgentConfiguration,
  parseCodingAgentConfiguration,
  type ClaudeGatewayEnvironment,
} from "./coding-agent-contracts.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS control_plane_feature_migrations (
  name TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS vm_allocation_coding_agent_settings (
  allocation_id TEXT NOT NULL REFERENCES vm_allocations(id) ON DELETE CASCADE,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex', 'opencode')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  executable_path TEXT NOT NULL CHECK (length(executable_path) <= 4096),
  environment_json TEXT,
  last_check_json TEXT,
  updated_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (allocation_id, agent),
  CHECK (
    (agent = 'claude' AND environment_json IS NOT NULL) OR
    (agent IN ('codex', 'opencode') AND environment_json IS NULL)
  )
) STRICT;
`;

type LegacyRow = {
  allocation_id: string;
  executable_path: string;
  reported_version: string;
  validated_at: number;
  updated_by_user_id: string;
  updated_at: number;
  execution_environment_json: string | null;
};

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function legacyVariables(row: LegacyRow): Record<string, unknown> {
  try {
    const parsed = row.execution_environment_json
      ? (JSON.parse(row.execution_environment_json) as { variables?: unknown })
      : {};
    return parsed.variables &&
      typeof parsed.variables === "object" &&
      !Array.isArray(parsed.variables)
      ? (parsed.variables as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function migratedEnvironment(row: LegacyRow): ClaudeGatewayEnvironment {
  const environment = structuredClone(
    (emptyCodingAgentConfiguration("claude") as { environment: ClaudeGatewayEnvironment })
      .environment,
  );
  const variables = legacyVariables(row);
  for (const key of CLAUDE_GATEWAY_ENVIRONMENT_KEYS) {
    if (typeof variables[key] !== "string") {
      continue;
    }
    try {
      const candidate = parseCodingAgentConfiguration({
        agent: "claude",
        enabled: false,
        executablePath: "",
        environment: { ...environment, [key]: variables[key] },
      });
      if (candidate.agent === "claude") {
        environment[key] = candidate.environment[key];
      }
    } catch {
      // Invalid legacy values remain empty while every independently valid value survives.
    }
  }
  return environment;
}

function migratedConfiguration(
  row: LegacyRow,
): import("./coding-agent-contracts.js").ClaudeCodingAgentConfiguration {
  const environment = migratedEnvironment(row);
  try {
    const configuration = parseCodingAgentConfiguration({
      agent: "claude",
      enabled: true,
      executablePath: row.executable_path,
      environment,
    });
    if (configuration.agent !== "claude") {
      throw new Error("Expected migrated Claude configuration");
    }
    return configuration;
  } catch {
    try {
      const configuration = parseCodingAgentConfiguration({
        agent: "claude",
        enabled: false,
        executablePath: row.executable_path,
        environment,
      });
      if (configuration.agent !== "claude") {
        throw new Error("Expected migrated Claude configuration");
      }
      return configuration;
    } catch {
      return { ...emptyCodingAgentConfiguration("claude"), environment };
    }
  }
}

function migrateLegacyRows(db: DatabaseSync, rows: LegacyRow[]): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO vm_allocation_coding_agent_settings (
      allocation_id, agent, enabled, executable_path, environment_json,
      last_check_json, updated_by_user_id, updated_at
    ) VALUES (?, 'claude', ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const configuration = migratedConfiguration(row);
    insert.run(
      row.allocation_id,
      configuration.enabled ? 1 : 0,
      configuration.executablePath,
      JSON.stringify(configuration.environment),
      JSON.stringify({
        agent: "claude",
        checkedAt: row.validated_at,
        reportedVersion: row.reported_version,
        diagnostics: [
          {
            stage: "executable",
            status: "passed",
            message: "Claude Code executable validated before coding-agent settings migration",
          },
        ],
      }),
      row.updated_by_user_id,
      row.updated_at,
    );
  }
}

/** One-way startup migration; steady-state readers never consult the retired table. */
export function migrateVmAllocationCodingAgentSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  const migrationName = "vm-allocation-coding-agents-v1";
  if (
    db.prepare("SELECT 1 FROM control_plane_feature_migrations WHERE name = ?").get(migrationName)
  ) {
    return;
  }
  if (hasTable(db, "vm_allocation_claude_code_settings")) {
    const hasVmEnvironment = hasTable(db, "vm_host_execution_environments");
    const rows = db
      .prepare(`
        SELECT legacy.allocation_id, legacy.executable_path, legacy.reported_version,
          legacy.validated_at, legacy.updated_by_user_id, legacy.updated_at,
          ${hasVmEnvironment ? "vm_environment.config_json" : "NULL"} AS execution_environment_json
        FROM vm_allocation_claude_code_settings AS legacy
        INNER JOIN vm_allocations AS allocation ON allocation.id = legacy.allocation_id
        ${
          hasVmEnvironment
            ? "LEFT JOIN vm_host_execution_environments AS vm_environment ON vm_environment.vm_host_id = allocation.vm_host_id"
            : ""
        }
      `)
      .all() as LegacyRow[];
    migrateLegacyRows(db, rows);
  }
  db.prepare(
    "INSERT OR IGNORE INTO control_plane_feature_migrations (name, completed_at) VALUES (?, ?)",
  ).run(migrationName, Date.now());
}
