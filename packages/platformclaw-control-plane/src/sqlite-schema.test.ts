import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  initializeControlPlaneSchema,
  PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
} from "./sqlite-schema.js";

describe("PlatformClaw control schema migrations", () => {
  it("migrates existing personal bindings from v1 and excludes Knox rooms", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE platform_users (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE agent_bindings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO agent_bindings VALUES ('personal-1', 'personal', 1234);
      INSERT INTO agent_bindings VALUES ('room-1', 'knox-room', 1235);
      PRAGMA user_version = 1;
    `);

    initializeControlPlaneSchema(db);

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
