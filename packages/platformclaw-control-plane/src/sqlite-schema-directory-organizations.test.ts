import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDirectoryOrganizationSchema } from "./sqlite-schema-directory-organizations.js";
import {
  initializeControlPlaneSchema,
  PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
} from "./sqlite-schema.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openDatabase(path = ":memory:") {
  const db = new DatabaseSync(path);
  databases.push(db);
  return db;
}

function legacyDatabase(path?: string) {
  const db = openDatabase(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA user_version = 3;
    CREATE TABLE platform_users (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE managed_scopes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      normalized_name TEXT NOT NULL, parent_scope_id TEXT REFERENCES managed_scopes(id),
      system_kind TEXT, system_provenance TEXT, status TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK ((kind = 'team' AND parent_scope_id IS NULL) OR
        (kind IN ('group', 'part') AND parent_scope_id IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX managed_scopes_team_name
      ON managed_scopes(normalized_name) WHERE kind = 'team';
    CREATE UNIQUE INDEX managed_scopes_child_name
      ON managed_scopes(parent_scope_id,kind,normalized_name) WHERE kind IN ('group','part');
    CREATE TABLE managed_scope_memberships (
      scope_id TEXT NOT NULL REFERENCES managed_scopes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('member','leader')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(scope_id,user_id)
    ) STRICT;
    INSERT INTO platform_users VALUES ('user');
    INSERT INTO managed_scopes VALUES
      ('team','team','Team','team',NULL,NULL,NULL,'active','user',1,2);
    INSERT INTO managed_scope_memberships VALUES ('team','user','leader',3,4);
  `);
  return db;
}

function insertScope(
  db: DatabaseSync,
  id: string,
  name: string,
  externalKey: string | null,
  kind = "team",
  parentId: string | null = null,
) {
  db.prepare(`INSERT INTO managed_scopes
    (id,kind,name,normalized_name,parent_scope_id,status,created_by_user_id,created_at,updated_at,
      external_key,managed_by)
    VALUES (?,?,?,?,?,'active','user',1,1,?,?)`).run(
    id,
    kind,
    name,
    name.toLowerCase(),
    parentId,
    externalKey,
    externalKey === null ? null : "ldap-login",
  );
}

describe("directory organization schema", () => {
  it("upgrades v3 without changing manual data or the old ID/name/role reader contract", () => {
    const db = legacyDatabase();
    const scope = db.prepare("SELECT * FROM managed_scopes WHERE id = 'team'").get();
    const membership = db.prepare("SELECT * FROM managed_scope_memberships").get();
    initializeControlPlaneSchema(db);
    ensureDirectoryOrganizationSchema(db);

    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
    expect(db.prepare("SELECT * FROM managed_scopes WHERE id = 'team'").get()).toEqual({
      ...scope,
      external_key: null,
      managed_by: null,
      directory_updated_at: null,
      directory_parent_key: null,
    });
    expect(db.prepare("SELECT * FROM managed_scope_memberships").get()).toEqual({
      ...membership,
      managed_by: null,
      manual_role: null,
    });
    expect(
      db
        .prepare(`SELECT scope.id,scope.name,member.role FROM managed_scopes AS scope
        JOIN managed_scope_memberships AS member ON member.scope_id = scope.id
        WHERE member.user_id = 'user'`)
        .all(),
    ).toEqual([{ id: "team", name: "Team", role: "leader" }]);
    insertScope(db, "manual", "Manual", null);
    db.prepare(`INSERT INTO managed_scope_memberships
      (scope_id,user_id,role,created_at,updated_at) VALUES ('manual','user','member',5,5)`).run();
    expect(
      db
        .prepare(
          "SELECT managed_by,manual_role FROM managed_scope_memberships WHERE scope_id = 'manual'",
        )
        .get(),
    ).toEqual({ managed_by: null, manual_role: null });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("allows equal external names while retaining external identity and manual name uniqueness", () => {
    const db = legacyDatabase();
    ensureDirectoryOrganizationSchema(db);
    insertScope(db, "external-team", "Team", "team:Team");
    expect(() => insertScope(db, "manual-duplicate", "Team", null)).toThrow(/UNIQUE/u);
    expect(() => insertScope(db, "external-key-duplicate", "Other", "team:Team")).toThrow(
      /UNIQUE/u,
    );
    insertScope(db, "group", "Group", null, "group", "team");
    insertScope(db, "external-group-a", "Group", "group:a", "group", "team");
    insertScope(db, "external-group-b", "Group", "group:b", "group", "team");
    expect(() => insertScope(db, "manual-group-duplicate", "Group", null, "group", "team")).toThrow(
      /UNIQUE/u,
    );
    expect(
      db.prepare("SELECT id FROM managed_scopes WHERE normalized_name = 'group' ORDER BY id").all(),
    ).toEqual([{ id: "external-group-a" }, { id: "external-group-b" }, { id: "group" }]);
  });

  it("preserves provenance and source state across repeated ensure and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-directory-schema-"));
    directories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const db = legacyDatabase(databasePath);
    ensureDirectoryOrganizationSchema(db);
    db.exec(`UPDATE managed_scope_memberships
      SET managed_by = 'ldap-login',manual_role = 'leader' WHERE scope_id = 'team';
      INSERT INTO directory_organization_sync VALUES ('user','team',100);`);
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    ensureDirectoryOrganizationSchema(db);
    expect(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(
      schema,
    );

    const reopened = openDatabase(databasePath);
    initializeControlPlaneSchema(reopened, databasePath);
    ensureDirectoryOrganizationSchema(reopened);
    expect(reopened.prepare("SELECT * FROM directory_organization_sync").all()).toEqual([
      { user_id: "user", scope_id: "team", source_updated_at: 100 },
    ]);
    expect(
      reopened.prepare("SELECT role,managed_by,manual_role FROM managed_scope_memberships").get(),
    ).toEqual({
      role: "leader",
      managed_by: "ldap-login",
      manual_role: "leader",
    });
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
  });

  it("declares fresh schema canonically and participates in an existing transaction", () => {
    const db = openDatabase();
    initializeControlPlaneSchema(db);
    expect(db.prepare("SELECT * FROM directory_organization_sync").all()).toEqual([]);
    db.exec("BEGIN IMMEDIATE");
    ensureDirectoryOrganizationSchema(db);
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    });
  });

  it("backs up v3 and permits only externally managed Parts to await their parents", () => {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-directory-v4-"));
    directories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const db = legacyDatabase(databasePath);
    ensureDirectoryOrganizationSchema(db);
    insertScope(db, "directory-team", "Directory Team", "team:Directory Team");
    insertScope(
      db,
      "directory-group",
      "Directory Group",
      "group:platform",
      "group",
      "directory-team",
    );
    insertScope(
      db,
      "directory-part",
      "Directory Part",
      "aicm-part:existing",
      "part",
      "directory-group",
    );
    expect(() => insertScope(db, "part", "Part", "aicm-part:part", "part")).toThrow();

    initializeControlPlaneSchema(db, databasePath);

    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(
      db
        .prepare("SELECT directory_parent_key FROM managed_scopes WHERE id = 'directory-part'")
        .get(),
    ).toEqual({ directory_parent_key: "group:platform" });
    insertScope(db, "part", "Part", "aicm-part:part", "part");
    expect(() => insertScope(db, "manual-part", "Manual Part", null, "part")).toThrow();
    expect(() =>
      insertScope(db, "missing-part-id", "Invalid Part", "aicm-part:", "part"),
    ).toThrow();
    expect(() => insertScope(db, "group", "Group", "group:group", "group")).toThrow();
    expect(() =>
      db.exec("UPDATE managed_scopes SET managed_by = NULL WHERE id = 'part'"),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE managed_scopes SET external_key = NULL WHERE id = 'part'"),
    ).toThrow();
    expect(() =>
      db.exec("UPDATE managed_scopes SET parent_scope_id = 'team' WHERE id = 'part'"),
    ).toThrow();
    expect(db.prepare("SELECT role FROM managed_scope_memberships").all()).toEqual([
      { role: "leader" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const backups = readdirSync(directory).filter((name) => name.includes(".pre-v4-"));
    expect(backups).toHaveLength(1);
    const backup = openDatabase(join(directory, backups[0]!));
    expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(backup.prepare("SELECT id FROM managed_scopes ORDER BY id").all()).toEqual([
      { id: "directory-group" },
      { id: "directory-part" },
      { id: "directory-team" },
      { id: "team" },
    ]);
  });

  it("rolls back a failed v4 table replacement and retries without losing provenance or references", () => {
    const db = legacyDatabase();
    ensureDirectoryOrganizationSchema(db);
    db.exec(`UPDATE managed_scope_memberships SET managed_by = 'ldap-login', manual_role = 'leader';
      INSERT INTO directory_organization_sync VALUES ('user', 'team', 100)`);
    const scopes = db.prepare("SELECT * FROM managed_scopes").all();
    const memberships = db.prepare("SELECT * FROM managed_scope_memberships").all();
    const run = db.exec.bind(db);
    const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("ALTER TABLE managed_scopes_v4 RENAME TO managed_scopes")) {
        throw new Error("injected v4 replacement failure");
      }
      run(sql);
    });
    try {
      expect(() => initializeControlPlaneSchema(db)).toThrow("injected v4 replacement failure");
    } finally {
      fault.mockRestore();
    }
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("SELECT * FROM managed_scopes").all()).toEqual(scopes);
    expect(db.prepare("SELECT * FROM managed_scope_memberships").all()).toEqual(memberships);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'managed_scopes_v4'").get(),
    ).toBeUndefined();

    initializeControlPlaneSchema(db);

    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(db.prepare("SELECT * FROM managed_scopes").all()).toEqual([
      { ...scopes[0], directory_parent_key: null },
    ]);
    expect(db.prepare("SELECT * FROM managed_scope_memberships").all()).toEqual(memberships);
    expect(db.prepare("SELECT * FROM directory_organization_sync").all()).toEqual([
      { user_id: "user", scope_id: "team", source_updated_at: 100 },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
