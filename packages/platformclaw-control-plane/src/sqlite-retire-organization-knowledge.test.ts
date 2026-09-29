import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { retireOrganizationKnowledge } from "./sqlite-retire-organization-knowledge.js";
import { ORGANIZATION_MEMORY_SCHEMA } from "./sqlite-schema-feature-state.js";
import { ORGANIZATION_KNOWLEDGE_SCHEMA } from "./sqlite-schema-organization-knowledge.js";
import { PLATFORMCLAW_CONTROL_SCHEMA_VERSION } from "./sqlite-schema.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wiki-retirement-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "control.sqlite");
  const options = {
    databasePath,
    initialAdminAccountIds: ["owner"],
    buildAgentMainSessionKey: ({ agentId }: { agentId: string }) => `agent:${agentId}:main`,
  };
  const store = new SqliteControlPlaneStore(options);
  const { user } = await store.upsertPrincipal(
    { provider: "ldap", subject: "owner", accountId: "owner", employeeId: "owner" },
    1,
  );
  const binding = await store.reservePersonalAgent(user.id, 2);
  const team = await store.createManagedScope({
    actorUserId: user.id,
    kind: "team",
    name: "Preserved directory",
    createdAt: 3,
  });
  await store.setManagedScopeMembership({
    actorUserId: user.id,
    scopeId: team.id,
    userId: user.id,
    role: "leader",
    reason: "Fixture",
    changedAt: 4,
  });
  const vault = store.vaults.createVault({ userId: user.id, name: "Preserved Shared" });
  const doc = store.vaults.saveDocument({
    userId: user.id,
    vaultId: vault.id,
    title: "Keep",
    content: "Shared source survives",
  });
  store.close();
  const db = new DatabaseSync(databasePath);
  cleanup.push(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ORGANIZATION_MEMORY_SCHEMA + ORGANIZATION_KNOWLEDGE_SCHEMA);
  db.prepare(
    "INSERT INTO organization_memory_promotion_requests VALUES ('request','personal',NULL,'personal/source',1,'team',?,'secret proposal','[]','reason',?,1)",
  ).run(team.id, user.id);
  db.prepare(
    "INSERT INTO organization_memory_claims VALUES ('claim','team',?,'Secret title','secret claim','[]','personal',NULL,'personal/source',1,'request',1,'active',?,?,1,1,NULL,NULL,NULL)",
  ).run(team.id, user.id, user.id);
  db.prepare(
    "INSERT INTO organization_memory_promotion_decisions VALUES ('decision','request','approved',?,'reason','claim',1)",
  ).run(user.id);
  db.prepare(
    "INSERT INTO organization_memory_pages VALUES ('page','team',?,'Secret page','secret body','{}',1,'active',1,1)",
  ).run(team.id);
  db.prepare(
    "INSERT INTO organization_memory_claim_revisions VALUES ('claim',1,'{}',?,1,'reason',NULL)",
  ).run(user.id);
  db.exec(
    "INSERT INTO organization_memory_claim_supersedes VALUES ('claim',1,'claim',1); INSERT INTO organization_memory_promotion_comparisons VALUES ('request','fingerprint','{}','{}',1); INSERT INTO organization_memory_promotion_reference_inputs VALUES ('request','{}'); INSERT INTO organization_memory_claim_references VALUES ('claim',1,'claim',1)",
  );
  db.prepare(
    "INSERT INTO organization_knowledge_jobs VALUES ('job',?,?,'req','fingerprint','{}','{}','running',NULL,NULL,1,NULL,NULL,NULL)",
  ).run(team.id, user.id);
  db.prepare("INSERT INTO organization_knowledge_requests VALUES (?,?,'req')").run(
    team.id,
    user.id,
  );
  db.prepare(
    "INSERT INTO organization_knowledge_reports VALUES ('report','job',?,'fingerprint','{}','{}',1)",
  ).run(team.id);
  db.prepare(
    "INSERT INTO organization_knowledge_proposals VALUES ('proposal',?,'report','pair','{}','{}')",
  ).run(team.id);
  db.prepare(
    "INSERT INTO organization_knowledge_reviews VALUES ('review','proposal',1,'approve',?,'reason',1)",
  ).run(user.id);
  db.prepare(
    "INSERT INTO control_audit_events VALUES ('secret-audit',?,'organization-memory.claim.created','claim','claim','{\"secret\":true}',1)",
  ).run(user.id);
  db.prepare("INSERT INTO knowledge_vault_connections VALUES (?, 'managed:team:old')").run(user.id);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name))
    .filter((name) => /^organization_(memory|knowledge)_/u.test(name));
  return { db, options, user, team, binding, vault, doc, tables };
}

describe("retired organization knowledge startup", () => {
  it("cleans every old corpus table and pointer on upgrade, preserves directory and Shared, and sweeps resurrection", async () => {
    const { db, options, user, team, binding, vault, doc, tables } = await fixture();
    const upgraded = new SqliteControlPlaneStore(options);
    cleanup.push(() => upgraded.close());
    for (const table of tables) {
      expect(db.prepare(`SELECT count(*) AS count FROM "${table}"`).get()!.count).toBe(0);
    }
    expect(db.prepare("SELECT id FROM platform_users WHERE id=?").get(user.id)).toBeTruthy();
    expect(db.prepare("SELECT id FROM managed_scopes WHERE id=?").get(team.id)).toBeTruthy();
    expect(
      db.prepare("SELECT user_id FROM managed_scope_memberships WHERE user_id=?").get(user.id),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT id FROM agent_bindings WHERE id=?").get(binding.binding.id),
    ).toBeTruthy();
    expect(
      upgraded.vaults.readDocument({ userId: user.id, vaultId: vault.id, documentId: doc.id })
        .content,
    ).toBe("Shared source survives");
    expect(
      db.prepare("SELECT id FROM control_audit_events WHERE id='secret-audit'").get(),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT vault_id FROM knowledge_vault_connections WHERE vault_id LIKE 'managed:%'")
        .get(),
    ).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(
      PLATFORMCLAW_CONTROL_SCHEMA_VERSION,
    );
    retireOrganizationKnowledge(db);
    db.prepare(
      "INSERT INTO organization_memory_pages VALUES ('resurrected','team',?,'Old image','old secret','{}',1,'active',1,1)",
    ).run(team.id);
    retireOrganizationKnowledge(db);
    expect(db.prepare("SELECT id FROM organization_memory_pages").all()).toEqual([]);
  });
  it("rolls back cleanup and immutable triggers when completion fails, then retries", async () => {
    const { db, tables } = await fixture();
    db.exec(
      "CREATE TRIGGER reject_retirement BEFORE UPDATE ON platformclaw_data_retirements BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    expect(() => retireOrganizationKnowledge(db)).toThrow("fixture failure");
    for (const table of tables) {
      expect(
        Number(db.prepare(`SELECT count(*) AS count FROM "${table}"`).get()!.count),
      ).toBeGreaterThan(0);
    }
    expect(() => db.exec("DELETE FROM organization_memory_promotion_decisions")).toThrow(
      "immutable",
    );
    db.exec("DROP TRIGGER reject_retirement");
    retireOrganizationKnowledge(db);
    for (const table of tables) {
      expect(db.prepare(`SELECT count(*) AS count FROM "${table}"`).get()!.count).toBe(0);
    }
  });
});
