import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirectoryOrganizationSchema } from "./sqlite-schema-directory-organizations.js";
import { initializeControlPlaneSchema } from "./sqlite-schema.js";

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
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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

    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(db.prepare("SELECT * FROM managed_scopes WHERE id = 'team'").get()).toEqual({
      ...scope,
      external_key: null,
      managed_by: null,
      directory_updated_at: null,
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
    expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  });

  it("declares fresh schema canonically and participates in an existing transaction", () => {
    const db = openDatabase();
    initializeControlPlaneSchema(db);
    expect(db.prepare("SELECT * FROM directory_organization_sync").all()).toEqual([]);
    db.exec("BEGIN IMMEDIATE");
    ensureDirectoryOrganizationSchema(db);
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  });
});
