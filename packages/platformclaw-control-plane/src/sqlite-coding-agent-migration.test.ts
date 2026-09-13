import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureVmHostExecutionEnvironmentSchema,
  initializeControlPlaneSchema,
} from "./sqlite-schema.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createLegacyDatabase(databasePath: string, variables: Record<string, string>) {
  const db = new DatabaseSync(databasePath);
  initializeControlPlaneSchema(db, databasePath);
  ensureVmHostExecutionEnvironmentSchema(db);
  db.exec(`
    CREATE TABLE vm_allocation_claude_code_settings (
      allocation_id TEXT PRIMARY KEY REFERENCES vm_allocations(id) ON DELETE CASCADE,
      executable_path TEXT NOT NULL,
      reported_version TEXT NOT NULL,
      validated_at INTEGER NOT NULL,
      updated_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
      updated_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO platform_users (
      id, account_id, employee_id, status, global_role, created_at, updated_at
    ) VALUES ('user-one', 'person.one', '1001', 'active', 'admin', 1, 1);
    INSERT INTO agent_bindings (
      id, kind, user_id, agent_id, state, created_at, updated_at
    ) VALUES ('binding-one', 'personal', 'user-one', 'person_one', 'active', 2, 2);
    INSERT INTO safeconnect_endpoints (
      id, label, host, port, ad_domain, status, host_key_algorithm,
      host_key_public_key, host_key_fingerprint, host_key_approved_by_user_id,
      host_key_approved_at, created_by_user_id, created_at, updated_at
    ) VALUES (
      'endpoint-one', 'SafeConnect', 'safeconnect.example.test', 44422, 'example.test', 'active',
      'ssh-ed25519', 'key', 'SHA256:test', 'user-one', 4, 'user-one', 4, 4
    );
    INSERT INTO vm_hosts (
      id, endpoint_id, label, target_address, status, created_by_user_id, created_at, updated_at
    ) VALUES (
      'vm-one', 'endpoint-one', 'Development VM', '192.0.2.10', 'active', 'user-one', 5, 5
    );
    INSERT INTO vm_allocations (
      id, agent_binding_id, vm_host_id, linux_account, status, remote_home_dir,
      remote_workspace_dir, last_connection_succeeded_at,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      'allocation-one', 'binding-one', 'vm-one', 'person.one', 'ready', '/home/person.one',
      '/home/person.one/workspace', 6, 'user-one', 6, 6
    );
    INSERT INTO personal_execution_profiles (
      agent_binding_id, active_target, active_allocation_id, target_revision, updated_at
    ) VALUES ('binding-one', 'assigned_vm', 'allocation-one', 1, 7);
  `);
  db.prepare(
    `INSERT INTO vm_host_execution_environments (
      vm_host_id, config_json, updated_by_user_id, updated_at
    ) VALUES (?, ?, ?, ?)`,
  ).run("vm-one", JSON.stringify({ pathPrepend: [], variables }), "user-one", 7);
  db.prepare(
    `INSERT INTO vm_allocation_claude_code_settings (
      allocation_id, executable_path, reported_version, validated_at,
      updated_by_user_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "allocation-one",
    "/home/person.one/.local/bin/claude",
    "Claude Code 2.1.0",
    8,
    "user-one",
    8,
  );
  db.close();
}

describe("coding agent storage migration", () => {
  it("promotes a usable legacy Claude path and VM environment exactly once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-coding-agent-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    createLegacyDatabase(databasePath, {
      ANTHROPIC_BASE_URL: "https://gateway.example.test",
      ADMIN_API_URL: "https://admin.example.test",
      OIDC_ISSUER_URL: "https://identity.example.test",
      OIDC_CLIENT_ID: "claude-code",
    });

    const openStore = () =>
      new SqliteControlPlaneStore({
        databasePath,
        buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      });
    const store = openStore();
    const migrated = await store.getPersonalExecutionSettings("person_one");
    expect(
      migrated?.codingAgents.find((entry) => entry.configuration.agent === "claude"),
    ).toMatchObject({
      hasSavedConfiguration: true,
      configuration: {
        agent: "claude",
        enabled: true,
        executablePath: "/home/person.one/.local/bin/claude",
        environment: { OIDC_CLIENT_ID: "claude-code" },
      },
      lastCheck: {
        diagnostics: [{ stage: "executable", status: "passed" }],
      },
    });
    store.close();

    const db = new DatabaseSync(databasePath);
    db.prepare(
      "UPDATE vm_allocation_claude_code_settings SET executable_path = '/tmp/resurrected'",
    ).run();
    db.close();
    const reopened = openStore();
    const remigrated = await reopened.getPersonalExecutionSettings("person_one");
    expect(
      remigrated?.codingAgents.find((entry) => entry.configuration.agent === "claude"),
    ).toMatchObject({
      configuration: { agent: "claude", executablePath: "/home/person.one/.local/bin/claude" },
    });
    reopened.close();
  });

  it("preserves valid partial legacy values but leaves incomplete Claude setup off", async () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-coding-agent-incomplete-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    createLegacyDatabase(databasePath, {
      ANTHROPIC_BASE_URL: "https://gateway.example.test",
      OIDC_CLIENT_ID: '"literal-quotes"',
    });
    const store = new SqliteControlPlaneStore({
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    const settings = await store.getPersonalExecutionSettings("person_one");
    expect(
      settings?.codingAgents.find((entry) => entry.configuration.agent === "claude"),
    ).toMatchObject({
      hasSavedConfiguration: true,
      configuration: {
        agent: "claude",
        enabled: false,
        executablePath: "/home/person.one/.local/bin/claude",
        environment: {
          ANTHROPIC_BASE_URL: "https://gateway.example.test",
          ADMIN_API_URL: "",
          OIDC_ISSUER_URL: "",
          OIDC_CLIENT_ID: "",
        },
      },
    });
    store.close();
  });
});
