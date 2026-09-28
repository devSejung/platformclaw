import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wiki-hub-access-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "control.sqlite");
  const store = new SqliteControlPlaneStore({
    databasePath: path,
    initialAdminAccountIds: ["owner"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  cleanup.push(() => store.close());
  const users: Record<string, string> = {};
  for (const accountId of ["owner", "editor", "reader", "outsider"]) {
    const { user } = await store.upsertPrincipal(
      { provider: "ldap", subject: accountId, accountId, employeeId: accountId },
      1,
    );
    users[accountId] = user.id;
  }
  const owner = users.owner!;
  const vault = store.vaults.createVault({ userId: owner, name: "Project Wiki" });
  const team = await store.createManagedScope({
    actorUserId: owner,
    kind: "team",
    name: "Team",
    createdAt: 2,
  });
  const group = await store.createManagedScope({
    actorUserId: owner,
    kind: "group",
    name: "Group",
    parentScopeId: team.id,
    createdAt: 3,
  });
  const membership = (scopeId: string, userId: string) =>
    store.setManagedScopeMembership({
      actorUserId: owner,
      scopeId,
      userId,
      role: "member",
      reason: "Fixture assignment",
      changedAt: 5,
    });
  return {
    store,
    vault,
    owner,
    editor: users.editor!,
    reader: users.reader!,
    outsider: users.outsider!,
    team,
    group,
    membership,
    path,
  };
}

describe("Wiki Hub authorization and enabled lifecycle", () => {
  it("resolves scoped path, title and id links without guessing duplicate titles or changing sources", async () => {
    const { store, vault, owner } = await fixture();
    const target = store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "PHY Training",
      logicalPath: "spec/Timing.md",
      content: "Target",
    });
    const body = `---\ntitle: Source\nsecretMetadata: not preview\n---\n# Source\nUseful body text.\n[[PHY Training|training]] [[SPEC/TIMING#phase]] [[${target.id}]]`;
    const source = store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      logicalPath: "source.md",
      content: body,
    });
    expect(source.links).toHaveLength(3);
    expect(source.links.every((link) => link.documentId === target.id)).toBe(true);
    expect(source.snippet).toContain("Useful body text.");
    expect(source.snippet).not.toContain("secretMetadata");
    const duplicate = store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "PHY Training",
      logicalPath: "another.md",
      content: "Second",
    });
    const read = () =>
      store.vaults.readDocument({ userId: owner, vaultId: vault.id, documentId: source.id });
    expect(read().links.find((link) => link.logicalPath === "PHY Training")?.documentId).toBeNull();
    expect(read().links.filter((link) => link.documentId === target.id)).toHaveLength(2);
    store.vaults.deleteDocument({
      userId: owner,
      vaultId: vault.id,
      documentId: duplicate.id,
      expectedRevision: duplicate.revision,
    });
    expect(read().links.every((link) => link.documentId === target.id)).toBe(true);
    expect(read().sourceContent).toBe(body);
    const other = store.vaults.createVault({ userId: owner, name: "Another Wiki" });
    const external = store.vaults.saveDocument({
      userId: owner,
      vaultId: other.id,
      title: "Only Elsewhere",
      content: "Private",
    });
    const isolated = store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      content: `[[Only Elsewhere]] [[${external.id}]]`,
    });
    expect(isolated.links.every((link) => link.documentId === null)).toBe(true);
  });
  it("records capacity-blocked auto-enable without rejecting access or breaking the frozen scope", async () => {
    const { store, owner, reader, team, membership, path } = await fixture();
    const db = new DatabaseSync(path);
    cleanup.push(() => db.close());
    const vault = db.prepare("INSERT INTO knowledge_vaults VALUES (?,?,'',1,1)");
    const member = db.prepare("INSERT INTO knowledge_vault_members VALUES (?,?,'owner',1)");
    const state = db.prepare("INSERT INTO knowledge_vault_access_states VALUES (?,?,1)");
    const enabled = db.prepare("INSERT INTO knowledge_vault_connections VALUES (?,?)");
    db.exec("BEGIN");
    for (let i = 0; i < 256; i++) {
      const id = `capacity-${i}`;
      vault.run(id, id);
      member.run(id, reader);
      state.run(reader, id);
      enabled.run(reader, id);
    }
    db.exec("COMMIT");
    const added = store.vaults.createVault({ userId: owner, name: "New team Wiki" });
    store.vaults.setOrganizationGrant({
      userId: owner,
      vaultId: added.id,
      scopeId: team.id,
      role: "reader",
    });
    await membership(team.id, reader);
    expect(store.vaults.connectionScope(reader).vaultIds).toHaveLength(256);
    expect(store.vaults.listVaults(reader).find((item) => item.id === added.id)).toMatchObject({
      canRead: true,
      connected: false,
      connectionIssue: "capacity",
    });
    expect(() =>
      store.vaults.setConnection({ userId: reader, vaultId: added.id, connected: true }),
    ).toThrow("Disable another");
    store.vaults.setConnection({ userId: reader, vaultId: "capacity-0", connected: false });
    store.vaults.setOrganizationGrant({
      userId: owner,
      vaultId: added.id,
      scopeId: team.id,
      role: "editor",
    });
    expect(store.vaults.connectionScope(reader).vaultIds).not.toContain(added.id);
    store.vaults.setConnection({ userId: reader, vaultId: added.id, connected: true });
    expect(store.vaults.connectionScope(reader).vaultIds).toHaveLength(256);
    expect(store.vaults.listVaults(reader).find((item) => item.id === added.id)).not.toHaveProperty(
      "connectionIssue",
    );
  });
  it("discovers Shared metadata without leaking unreadable documents, counts or graph", async () => {
    const { store, vault, owner, outsider } = await fixture();
    store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      title: "Secret document",
      content: "secret",
    });
    const snapshot = store.vaults.snapshot({ userId: outsider });
    expect(snapshot.vaults).toEqual([
      expect.objectContaining({ id: vault.id, role: null, canRead: false, connected: false }),
    ]);
    expect(snapshot.vaults[0]).not.toHaveProperty("documentCount");
    expect(snapshot.vaults[0]).not.toHaveProperty("attachmentCount");
    expect(JSON.stringify(snapshot)).not.toContain("Secret document");
    expect(() => store.vaults.snapshot({ userId: outsider, vaultId: vault.id })).toThrow(
      "unavailable",
    );
    expect(store.vaults.search({ userId: outsider, query: "secret" })).toEqual([]);
  });
  it("unions direct and exact organization roles; preferences change only on real access loss/regain", async () => {
    const { store, vault, owner, editor, reader, team, group, membership } = await fixture();
    await membership(team.id, editor);
    await membership(group.id, reader);
    store.vaults.setOrganizationGrant({
      userId: owner,
      vaultId: vault.id,
      scopeId: team.id,
      role: "editor",
    });
    expect(store.vaults.snapshot({ userId: editor, vaultId: vault.id }).selected!.vault.role).toBe(
      "editor",
    );
    expect(store.vaults.listVaults(reader)[0]!.canRead).toBe(false);
    const document = store.vaults.saveDocument({
      userId: editor,
      vaultId: vault.id,
      title: "Training",
      content: "training fact",
    });
    expect(store.vaults.search({ userId: editor, query: "training" })[0]!.documentId).toBe(
      document.id,
    );
    store.vaults.setConnection({ userId: editor, vaultId: vault.id, connected: false });
    store.vaults.setOrganizationGrant({
      userId: owner,
      vaultId: vault.id,
      scopeId: team.id,
      role: "reader",
    });
    store.vaults.setMember({
      userId: owner,
      vaultId: vault.id,
      memberUserId: editor,
      role: "editor",
    });
    await store.upsertPrincipal(
      { provider: "ldap", subject: "editor", accountId: "editor", employeeId: "editor" },
      10,
    );
    expect(store.vaults.connectionScope(editor).vaultIds).toEqual([]);
    await store.removeManagedScopeMembership({
      actorUserId: owner,
      scopeId: team.id,
      userId: editor,
      reason: "Leave",
      changedAt: 11,
    });
    expect(store.vaults.snapshot({ userId: editor, vaultId: vault.id }).selected!.vault.role).toBe(
      "editor",
    );
    expect(store.vaults.connectionScope(editor).vaultIds).toEqual([]);
    store.vaults.removeMember({ userId: owner, vaultId: vault.id, memberUserId: editor });
    expect(() =>
      store.vaults.readDocument({ userId: editor, vaultId: vault.id, documentId: document.id }),
    ).toThrow("unavailable");
    await membership(team.id, editor);
    expect(store.vaults.connectionScope(editor).vaultIds).toEqual([vault.id]);
  });
  it("atomically approves access and rejects repeat decisions without granting Owner", async () => {
    const { store, vault, owner, reader, outsider } = await fixture();
    store.vaults.requestAccess({
      userId: reader,
      vaultId: vault.id,
      role: "editor",
      reason: "Project work",
    });
    const request = store.vaults.snapshot({ userId: owner }).pendingRequests[0]!;
    expect(() =>
      store.vaults.decideAccess({ userId: outsider, requestId: request.id, decision: "approve" }),
    ).toThrow("unavailable");
    store.vaults.decideAccess({ userId: owner, requestId: request.id, decision: "approve" });
    expect(store.vaults.connectionScope(reader).vaultIds).toEqual([vault.id]);
    expect(store.vaults.snapshot({ userId: reader }).ownRequests[0]!.status).toBe("approved");
    expect(store.vaults.snapshot({ userId: reader, vaultId: vault.id }).selected!.vault.role).toBe(
      "editor",
    );
    expect(() =>
      store.vaults.decideAccess({ userId: owner, requestId: request.id, decision: "approve" }),
    ).toThrow("already decided");
    expect(
      (await store.listAuditEvents()).filter((event) => event.eventType === "wiki.access.approved"),
    ).toHaveLength(1);
    store.vaults.requestAccess({ userId: outsider, vaultId: vault.id, role: "reader" });
    const pending = store.vaults.snapshot({ userId: outsider }).ownRequests[0]!;
    store.vaults.decideAccess({ userId: outsider, requestId: pending.id, decision: "cancel" });
    expect(store.vaults.listVaults(outsider)[0]!.canRead).toBe(false);
  });
  it("honors employee departure and requires explicit admin recovery without content access", async () => {
    const { store, vault, owner, editor, reader, team, membership } = await fixture();
    await membership(team.id, editor);
    store.vaults.setOrganizationGrant({
      userId: owner,
      vaultId: vault.id,
      scopeId: team.id,
      role: "owner",
    });
    store.vaults.removeMember({ userId: owner, vaultId: vault.id, memberUserId: owner });
    await store.setManagedUserStatus({
      actorUserId: owner,
      targetUserId: editor,
      status: "disabled",
      changedAt: 21,
    });
    const orphan = store.vaults.listVaults(owner)[0]!;
    expect(orphan).toMatchObject({ canRecoverOwner: true, canRead: false, role: null });
    expect(orphan).not.toHaveProperty("documentCount");
    expect(() => store.vaults.snapshot({ userId: owner, vaultId: vault.id })).toThrow(
      "unavailable",
    );
    expect(() =>
      store.vaults.recoverOwner({ userId: reader, vaultId: vault.id, accountId: "reader" }),
    ).toThrow("administrator");
    store.vaults.recoverOwner({ userId: owner, vaultId: vault.id, accountId: "reader" });
    expect(store.vaults.snapshot({ userId: reader, vaultId: vault.id }).selected!.vault.role).toBe(
      "owner",
    );
    expect(store.vaults.listVaults(owner)[0]!.canRead).toBe(false);
    expect(
      (await store.listAuditEvents()).some((event) => event.eventType === "wiki.owner.recovered"),
    ).toBe(true);
    expect(() =>
      store.vaults.removeMember({ userId: reader, vaultId: vault.id, memberUserId: reader }),
    ).toThrow("last effective Owner");
    await store.removeManagedScopeMembership({
      actorUserId: owner,
      scopeId: team.id,
      userId: editor,
      reason: "Leave",
      changedAt: 22,
    });
    await store.archiveManagedScope({
      actorUserId: owner,
      scopeId: team.id,
      expectedRevision: team.updatedAt,
      reason: "Close",
      archivedAt: 23,
    });
  });
  it("ignores retired export overrides and preserves source metadata during body edits and deletion", async () => {
    const { store, vault, owner, reader, path } = await fixture();
    store.vaults.setMember({
      userId: owner,
      vaultId: vault.id,
      memberUserId: reader,
      role: "reader",
    });
    const db = new DatabaseSync(path);
    cleanup.push(() => db.close());
    db.prepare("UPDATE knowledge_vault_members SET can_export = 1 WHERE user_id = ?").run(reader);
    await expect(store.vaults.exportVault({ userId: reader, vaultId: vault.id })).rejects.toThrow(
      "unavailable",
    );
    const prefix = "\uFEFF---\r\ntitle: Original\r\ncustom: keep\r\n---\r\n";
    const document = store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      content: prefix + "Old body\r\n",
    });
    expect(document.editableContent).toBe("Old body\r\n");
    const edited = store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      documentId: document.id,
      expectedRevision: document.revision,
      content: "New body\r\n",
    });
    expect(edited.sourceContent).toBe(prefix + "New body\r\n");
    const linked = store.vaults.saveDocument({
      userId: owner,
      vaultId: vault.id,
      content: `[Target](${edited.logicalPath})`,
    });
    expect(() =>
      store.vaults.deleteDocument({
        userId: owner,
        vaultId: vault.id,
        documentId: edited.id,
        expectedRevision: 1,
      }),
    ).toThrow("changed");
    store.vaults.deleteDocument({
      userId: owner,
      vaultId: vault.id,
      documentId: edited.id,
      expectedRevision: edited.revision,
    });
    expect(
      store.vaults.readDocument({ userId: owner, vaultId: vault.id, documentId: linked.id })
        .links[0]!.documentId,
    ).toBeNull();
    expect(store.vaults.search({ userId: owner, query: "New body" })).toEqual([]);
  });
});
