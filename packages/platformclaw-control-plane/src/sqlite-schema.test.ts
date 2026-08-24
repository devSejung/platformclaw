import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ensureVmHostExecutionEnvironmentSchema,
  ensureSkillHubStateSchema,
  initializeControlPlaneSchema,
  PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
} from "./sqlite-schema.js";

describe("PlatformClaw control schema migrations", () => {
  it("atomically migrates populated v2 organization data and restricts legacy Global bindings", () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-schema-v3-"));
    const databasePath = join(directory, "control.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE platform_users (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, employee_id TEXT NOT NULL UNIQUE,
        display_name TEXT, email TEXT, department TEXT, timezone TEXT,
        status TEXT NOT NULL, global_role TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scopes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
        parent_group_id TEXT REFERENCES managed_scopes(id), status TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE managed_scope_memberships (
        scope_id TEXT NOT NULL REFERENCES managed_scopes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_id, user_id)
      ) STRICT;
      CREATE TABLE skill_hub_namespace_bindings (
        namespace TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT,
        visibility_ceiling TEXT NOT NULL, created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE organization_memory_promotion_requests (
        id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_scope_id TEXT,
        source_claim_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
        target_kind TEXT NOT NULL, target_scope_id TEXT, proposed_text TEXT NOT NULL,
        evidence_json TEXT NOT NULL, reason TEXT NOT NULL,
        requested_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE organization_memory_claims (
        id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT, title TEXT NOT NULL,
        claim_text TEXT NOT NULL, evidence_json TEXT NOT NULL, source_kind TEXT NOT NULL,
        source_scope_id TEXT, source_claim_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
        promotion_request_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, status TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL, approved_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, retired_by_user_id TEXT,
        retired_at INTEGER, retirement_reason TEXT
      ) STRICT;
      CREATE TABLE organization_memory_promotion_decisions (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, decision TEXT NOT NULL,
        decided_by_user_id TEXT NOT NULL, reason TEXT NOT NULL, target_claim_id TEXT,
        decided_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE organization_memory_pages (
        id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_id TEXT, title TEXT NOT NULL,
        content TEXT NOT NULL, provenance_json TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO platform_users VALUES
        ('admin-new', 'new', 'new', NULL, NULL, NULL, NULL, 'active', 'admin', 20, 20, NULL),
        ('admin-old', 'old', 'old', NULL, NULL, NULL, NULL, 'active', 'admin', 10, 10, NULL),
        ('member', 'member', 'member', NULL, NULL, NULL, NULL, 'active', 'member', 30, 30, NULL);
      INSERT INTO managed_scopes VALUES
        ('group-a', 'group', 'Group A', 'group a', NULL, 'active', 'admin-new', 40, 41),
        ('part-a', 'part', 'Part A', 'part a', 'group-a', 'active', 'admin-new', 42, 43);
      INSERT INTO managed_scope_memberships VALUES ('part-a', 'member', 'leader', 44, 45);
      INSERT INTO skill_hub_namespace_bindings VALUES
        ('company', 'team', NULL, 'PUBLIC', 'admin-new', 46, 47);
      INSERT INTO organization_memory_promotion_requests VALUES
        ('request-a', 'personal', NULL, 'personal-source', 2, 'part', 'part-a',
         'proposed', '["evidence"]', 'share', 'member', 48);
      INSERT INTO organization_memory_claims VALUES
        ('claim-a', 'part', 'part-a', 'Claim', 'claim text', '["evidence"]',
         'personal', NULL, 'personal-source', 2, 'request-a', 3, 'active',
         'member', 'admin-new', 49, 50, NULL, NULL, NULL);
      INSERT INTO organization_memory_promotion_decisions VALUES
        ('decision-a', 'request-a', 'approved', 'admin-new', 'approved', 'claim-a', 51);
      INSERT INTO organization_memory_pages VALUES
        ('page-a', 'part', 'part-a', 'Page', 'content', '["claim-a"]', 4, 'active', 52, 53);
      PRAGMA user_version = 2;
    `);

    initializeControlPlaneSchema(db, databasePath);
    const secondOpener = new DatabaseSync(databasePath);
    initializeControlPlaneSchema(secondOpener, databasePath);
    secondOpener.close();

    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(
      db
        .prepare(
          `SELECT id, kind, parent_scope_id, system_kind, system_provenance, created_by_user_id
         FROM managed_scopes ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "group-a",
        kind: "group",
        parent_scope_id: "system-team-unassigned-v3",
        system_kind: null,
        system_provenance: null,
        created_by_user_id: "admin-new",
      },
      {
        id: "part-a",
        kind: "part",
        parent_scope_id: "group-a",
        system_kind: null,
        system_provenance: null,
        created_by_user_id: "admin-new",
      },
      {
        id: "system-team-unassigned-v3",
        kind: "team",
        parent_scope_id: null,
        system_kind: "unassigned-team",
        system_provenance: "migration-v2-v3",
        created_by_user_id: "admin-old",
      },
    ]);
    expect(db.prepare("SELECT * FROM managed_scope_memberships").get()).toMatchObject({
      scope_id: "part-a",
      user_id: "member",
      role: "leader",
      created_at: 44,
      updated_at: 45,
    });
    expect(
      db
        .prepare("SELECT scope_kind, scope_id, access_state FROM skill_hub_namespace_bindings")
        .get(),
    ).toEqual({
      scope_kind: "global",
      scope_id: null,
      access_state: "restricted",
    });
    expect(db.prepare("SELECT * FROM organization_memory_promotion_requests").get()).toMatchObject({
      id: "request-a",
      source_claim_id: "personal-source",
      source_revision: 2,
      target_scope_id: "part-a",
      requested_by_user_id: "member",
      created_at: 48,
    });
    expect(db.prepare("SELECT * FROM organization_memory_claims").get()).toMatchObject({
      id: "claim-a",
      promotion_request_id: "request-a",
      revision: 3,
      status: "active",
      created_at: 49,
      updated_at: 50,
    });
    expect(db.prepare("SELECT * FROM organization_memory_promotion_decisions").get()).toMatchObject(
      {
        id: "decision-a",
        request_id: "request-a",
        target_claim_id: "claim-a",
        decided_at: 51,
      },
    );
    expect(db.prepare("SELECT * FROM organization_memory_pages").get()).toMatchObject({
      id: "page-a",
      scope_id: "part-a",
      revision: 4,
      created_at: 52,
      updated_at: 53,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    const backups = readdirSync(directory).filter((name) => name.includes(".pre-v3-"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(directory, backups[0]!));
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    backup.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rolls back v2 migration when legacy hierarchy has the wrong parent kind", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE platform_users (
        id TEXT PRIMARY KEY, status TEXT, global_role TEXT, created_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scopes (
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, normalized_name TEXT, parent_group_id TEXT,
        status TEXT, created_by_user_id TEXT, created_at INTEGER, updated_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scope_memberships (
        scope_id TEXT, user_id TEXT, role TEXT, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY (scope_id, user_id)
      ) STRICT;
      INSERT INTO platform_users VALUES ('admin', 'active', 'admin', 1);
      INSERT INTO managed_scopes VALUES
        ('part-parent', 'part', 'Parent', 'parent', 'missing', 'active', 'admin', 1, 1),
        ('part-child', 'part', 'Child', 'child', 'part-parent', 'active', 'admin', 1, 1);
      PRAGMA user_version = 2;
    `);
    expect(() => initializeControlPlaneSchema(db)).toThrow(
      "invalid legacy managed-scope hierarchy",
    );
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM managed_scopes").get()).toEqual({ count: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  it("rolls back tables and version when a failure occurs after v3 DDL starts", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE platform_users (
        id TEXT PRIMARY KEY, status TEXT, global_role TEXT, created_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scopes (
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, normalized_name TEXT, parent_group_id TEXT,
        status TEXT, created_by_user_id TEXT, created_at INTEGER, updated_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scope_memberships (
        scope_id TEXT, user_id TEXT, role TEXT, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY (scope_id, user_id)
      ) STRICT;
      INSERT INTO platform_users VALUES ('admin', 'active', 'admin', 1);
      INSERT INTO managed_scopes VALUES
        ('system-team-unassigned-v3', 'group', 'Legacy collision', 'legacy collision', NULL,
         'active', 'admin', 2, 2);
      PRAGMA user_version = 2;
    `);

    expect(() => initializeControlPlaneSchema(db)).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT id, kind FROM managed_scopes").all()).toEqual([
      { id: "system-team-unassigned-v3", kind: "group" },
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'managed_scopes_v3'").get(),
    ).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close();
  });

  it("aborts populated group migration when no active administrator can own Unassigned Team", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE platform_users (
        id TEXT PRIMARY KEY, status TEXT, global_role TEXT, created_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scopes (
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, normalized_name TEXT, parent_group_id TEXT,
        status TEXT, created_by_user_id TEXT, created_at INTEGER, updated_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scope_memberships (
        scope_id TEXT, user_id TEXT, role TEXT, created_at INTEGER, updated_at INTEGER,
        PRIMARY KEY (scope_id, user_id)
      ) STRICT;
      INSERT INTO platform_users VALUES ('disabled-admin', 'disabled', 'admin', 1);
      INSERT INTO managed_scopes VALUES
        ('group-a', 'group', 'Group A', 'group a', NULL, 'active', 'disabled-admin', 2, 2);
      PRAGMA user_version = 2;
    `);

    expect(() => initializeControlPlaneSchema(db)).toThrow("requires an active administrator");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT id FROM managed_scopes").all()).toEqual([{ id: "group-a" }]);
    db.close();
  });

  it("lazily creates additive Skill Hub ownership, ACL, inbox, jobs, and bindings", () => {
    const db = new DatabaseSync(":memory:");
    initializeControlPlaneSchema(db);
    ensureSkillHubStateSchema(db);
    ensureSkillHubStateSchema(db);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'skill_hub_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "skill_hub_governance_jobs" },
      { name: "skill_hub_namespace_bindings" },
      { name: "skill_hub_notifications" },
      { name: "skill_hub_skill_access" },
      { name: "skill_hub_skill_ownership" },
    ]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
    db.close();
  });

  it("lazily restores the additive VM execution-environment table on schema v2", () => {
    const db = new DatabaseSync(":memory:");
    initializeControlPlaneSchema(db);
    db.exec("DROP TABLE vm_host_execution_environments");

    ensureVmHostExecutionEnvironmentSchema(db);
    ensureVmHostExecutionEnvironmentSchema(db);

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vm_host_execution_environments'",
        )
        .get(),
    ).toEqual({ name: "vm_host_execution_environments" });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
    db.close();
  });

  it("migrates existing personal bindings from v1 and excludes Knox rooms", () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-schema-v1-v3-"));
    const databasePath = join(directory, "control.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE platform_users (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE,
        employee_id TEXT NOT NULL UNIQUE,
        display_name TEXT,
        email TEXT,
        department TEXT,
        timezone TEXT,
        status TEXT NOT NULL,
        global_role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      ) STRICT;
      CREATE TABLE managed_scopes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('group', 'part')),
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        parent_group_id TEXT REFERENCES managed_scopes(id),
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE managed_scope_memberships (
        scope_id TEXT NOT NULL REFERENCES managed_scopes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_id, user_id)
      ) STRICT;
      CREATE TABLE agent_bindings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO agent_bindings VALUES ('personal-1', 'personal', 1234);
      INSERT INTO agent_bindings VALUES ('room-1', 'knox-room', 1235);
      PRAGMA user_version = 1;
    `);

    initializeControlPlaneSchema(db, databasePath);

    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
    expect(
      db
        .prepare(
          "SELECT agent_binding_id, active_target, active_allocation_id, target_revision, updated_at FROM personal_execution_profiles",
        )
        .all(),
    ).toEqual([
      {
        agent_binding_id: "personal-1",
        active_target: "platform_server",
        active_allocation_id: null,
        target_revision: 0,
        updated_at: 1234,
      },
    ]);
    db.close();
    const backups = readdirSync(directory).filter((name) => name.includes(".pre-v3-"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(directory, backups[0]!));
    expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(
      backup.prepare("SELECT agent_binding_id FROM personal_execution_profiles").all(),
    ).toEqual([{ agent_binding_id: "personal-1" }]);
    backup.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects unknown future schema versions without changing them", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA user_version = 99");

    expect(() => initializeControlPlaneSchema(db)).toThrow(
      "unsupported PlatformClaw control schema version: 99",
    );
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    db.close();
  });

  it("enforces personal ownership and encrypted-envelope shape in SQLite", () => {
    const db = new DatabaseSync(":memory:");
    initializeControlPlaneSchema(db);
    db.exec(`
      INSERT INTO platform_users (
        id, account_id, employee_id, display_name, email, department, timezone,
        status, global_role, created_at, updated_at, last_login_at
      ) VALUES
        ('admin', 'admin', 'employee-admin', NULL, NULL, NULL, NULL,
          'active', 'admin', 1, 1, NULL),
        ('user-b', 'user-b', 'employee-b', NULL, NULL, NULL, NULL,
          'active', 'member', 1, 1, NULL);
      INSERT INTO agent_bindings VALUES
        ('binding-a', 'personal', 'admin', NULL, NULL, 'agent-a', 'active', NULL, 1, 1),
        ('binding-b', 'personal', 'user-b', NULL, NULL, 'agent-b', 'active', NULL, 1, 1),
        ('binding-room', 'knox-room', NULL, 'knox', 'room', 'group-room',
          'active', NULL, 1, 1);
      INSERT INTO personal_execution_profiles VALUES
        ('binding-a', 'platform_server', NULL, 0, 1),
        ('binding-b', 'platform_server', NULL, 0, 1);
      INSERT INTO safeconnect_endpoints VALUES (
        'endpoint', 'endpoint', 'safeconnect.example.test', 44422, 'example.test',
        'active', 'ssh-ed25519', 'public-key', 'SHA256:fingerprint', 'admin', 2,
        'admin', 1, 2
      );
      INSERT INTO vm_hosts VALUES (
        'vm', 'endpoint', 'VM', '192.0.2.10', 'active', 'admin', 1, 1
      );
      INSERT INTO vm_allocations VALUES (
        'allocation-a', 'binding-a', 'vm', 'linux-a', 'assigned', NULL, NULL,
        NULL, NULL, NULL, 'admin', 1, 1, NULL
      );
    `);

    expect(() =>
      db.exec(`
        INSERT INTO vm_allocations VALUES (
          'allocation-room', 'binding-room', 'vm', 'linux-room', 'assigned',
          NULL, NULL, NULL, NULL, NULL, 'admin', 1, 1, NULL
        );
      `),
    ).toThrow("VM allocation requires a personal agent binding");
    expect(() =>
      db.exec(`
        UPDATE vm_allocations
        SET agent_binding_id = 'binding-room'
        WHERE id = 'allocation-a';
      `),
    ).toThrow("VM allocation agent owner is immutable");
    expect(() =>
      db.exec(`
        UPDATE personal_execution_profiles
        SET agent_binding_id = 'binding-room'
        WHERE agent_binding_id = 'binding-b';
      `),
    ).toThrow("execution profile agent owner is immutable");
    expect(() =>
      db.exec(`
        UPDATE agent_bindings
        SET kind = 'knox-room', user_id = NULL, knox_account_id = 'changed', room_id = 'changed'
        WHERE id = 'binding-b';
      `),
    ).toThrow("agent binding kind is immutable");
    expect(() =>
      db.exec(`
        UPDATE personal_execution_profiles
        SET active_target = 'assigned_vm', active_allocation_id = 'allocation-a'
        WHERE agent_binding_id = 'binding-b';
      `),
    ).toThrow();
    db.exec(`
      UPDATE vm_allocations
      SET status = 'revoked', revoked_at = 2
      WHERE id = 'allocation-a';
    `);
    expect(() =>
      db.exec(`
        UPDATE personal_execution_profiles
        SET active_target = 'assigned_vm', active_allocation_id = 'allocation-a'
        WHERE agent_binding_id = 'binding-a';
      `),
    ).toThrow("execution profile requires a non-revoked owned allocation");
    expect(() =>
      db
        .prepare(
          `INSERT INTO encrypted_user_ssh_credentials VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
        )
        .run(
          "credential",
          "admin",
          new Uint8Array([1]),
          new Uint8Array(11),
          new Uint8Array(16),
          "key-1",
          1,
          1,
          "current",
          null,
          1,
          1,
        ),
    ).toThrow();
    db.close();
  });
});
