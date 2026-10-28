import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnterprisePrincipal } from "./contracts.js";
import { ensureSkillHubNotificationSchema, ensureSkillHubStateSchema } from "./sqlite-schema.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const stores: SqliteControlPlaneStore[] = [];
const directories: string[] = [];
const PUBLIC = { mode: "PUBLIC" as const, userIds: [], scopeIds: [] };
const PRIVATE = { mode: "PRIVATE" as const, userIds: [], scopeIds: [] };
let nativeId = 0;

class CatalogFixtureStore extends SqliteControlPlaneStore {
  seedLegacySkill(ownerUserId: string) {
    ensureSkillHubStateSchema(this.db);
    this.db
      .prepare(
        "INSERT INTO skill_hub_skill_ownership (namespace, slug, owner_user_id, visibility, current_version, updated_at) VALUES ('global', 'legacy-skill', ?, 'PRIVATE', '1.0.0', 6)",
      )
      .run(ownerUserId);
  }

  seedLegacyMove(ownerUserId: string, registryId: number, actorUserId = ownerUserId) {
    this.seedLegacySkill(ownerUserId);
    const operationId = randomUUID();
    const payload = {
      skillId: registryId,
      namespace: "global",
      slug: "legacy-skill",
      targetNamespace: "moved-tools",
      actorUserId,
      expectedOwnerUpdatedAt: 6,
      originalOwnership: {
        ownerUserId,
        updatedAt: 6,
        currentVersion: "1.0.0",
        visibility: "PRIVATE",
      },
    };
    this.db
      .prepare(
        "INSERT INTO skill_hub_edit_intents (id, namespace, slug, target_namespace, state, payload_json, created_at, updated_at) VALUES (?, 'global', 'legacy-skill', 'moved-tools', 'pending', ?, 7, 7)",
      )
      .run(operationId, JSON.stringify(payload));
    return operationId;
  }

  failMalwareNotification() {
    ensureSkillHubNotificationSchema(this.db);
    this.db.exec(
      "CREATE TRIGGER fail_malware_notification BEFORE INSERT ON skill_hub_notifications WHEN NEW.kind = 'malware-blocked' BEGIN SELECT RAISE(ABORT, 'notification write failed'); END",
    );
  }

  allowMalwareNotification() {
    this.db.exec("DROP TRIGGER fail_malware_notification");
  }
}

function principal(accountId: string): EnterprisePrincipal {
  return { provider: "ldap", subject: accountId, accountId, employeeId: accountId, groups: [] };
}

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "skillhub-catalog-"));
  directories.push(directory);
  const store = new CatalogFixtureStore({
    databasePath: path.join(directory, "control.sqlite"),
    initialAdminAccountIds: ["admin.user"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  stores.push(store);
  const owner = (await store.upsertPrincipal(principal("owner.user"), 1)).user;
  const reader = (await store.upsertPrincipal(principal("reader.user"), 2)).user;
  const admin = (await store.upsertPrincipal(principal("admin.user"), 3)).user;
  const catalog = store.skillHubCatalog;
  const publish = async (sharing = PUBLIC) => {
    const operationId = randomUUID();
    await catalog.reservePublication({
      operationId,
      actorUserId: owner.id,
      slug: "same-name",
      version: "1.0.0",
      fingerprint: `archive-${operationId}`,
      summary: "Original description",
      sharing,
      now: 10,
    });
    return catalog.completePublication({ operationId, registryId: ++nativeId, now: 11 });
  };
  return { store, catalog, owner, reader, admin, publish };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical Skill Hub catalog", () => {
  it.each(["active", "owner-disabled", "actor-disabled"] as const)(
    "preserves proven ownership of a committed legacy move (%s)",
    async (accountState) => {
      const { store, catalog, owner, reader, admin } = await fixture();
      const registryId = ++nativeId;
      store.seedLegacyMove(
        owner.id,
        registryId,
        accountState === "actor-disabled" ? reader.id : owner.id,
      );
      const room = await store.reserveKnoxRoomAgent({
        accountId: "proof-relay",
        roomId: "moved-skill-room",
        reservedAt: 4,
      });
      await store.recordAuditEvent({
        actorUserId: owner.id,
        eventType: "skill-hub.install",
        targetType: "skill-hub-skill",
        targetId: "global/legacy-skill@1.0.0",
        details: {
          agentId: room.binding.agentId,
          destination: "platform_server",
          sha256: "c".repeat(64),
        },
        createdAt: 5,
      });
      const audit = await store.recordAuditEvent({
        actorUserId: owner.id,
        eventType: "skill-hub.publish",
        targetType: "skill-hub-skill",
        targetId: "global/legacy-skill@1.0.0",
        details: { visibility: "PRIVATE" },
        createdAt: 6,
      });
      if (accountState !== "active") {
        await store.setManagedUserStatus({
          actorUserId: admin.id,
          targetUserId: accountState === "actor-disabled" ? reader.id : owner.id,
          status: "disabled",
          changedAt: 8,
        });
      }
      const request = {
        id: randomUUID(),
        registryId,
        namespace: "moved-tools",
        slug: "legacy-skill",
        displayName: "Moved skill",
        summary: "Actual registry content",
        currentVersion: "1.0.0",
        now: 10,
      };
      const imported = await catalog.importLegacy(request);
      expect(imported.ownerUserId).toBe(owner.id);
      expect((await catalog.getByCoordinate("global", "legacy-skill"))?.id).toBe(imported.id);
      expect(
        await catalog.listInstallations(room.binding.agentId, "platform-server"),
      ).toMatchObject([{ skillId: imported.id, state: "pending", version: "1.0.0" }]);
      expect(await catalog.listLegacyCoordinates()).toEqual([]);
      await catalog.importLegacy({ ...request, id: randomUUID(), now: 11 });
      const history = await catalog.listHistory({ skillId: imported.id, actorUserId: admin.id });
      expect(history.filter((event) => event.id === `legacy-${audit.id}`)).toMatchObject([
        { actorUserId: owner.id, version: "1.0.0", createdAt: 6 },
      ]);
      const trashed = await catalog.trash({
        skillId: imported.id,
        actorUserId: admin.id,
        reason: "Purge migrated fixture",
        expectedRevision: imported.revision,
        now: 12,
      });
      const due = 12 + 30 * 24 * 60 * 60 * 1_000;
      await catalog.beginPurge({
        skillId: imported.id,
        expectedRevision: trashed.revision,
        now: due,
      });
      await catalog.finishPurge({ skillId: imported.id, now: due });
      await catalog.pruneHistory(due + 365 * 24 * 60 * 60 * 1_000);
      expect(await catalog.listLegacyCoordinates()).toEqual([]);
      expect((await store.listAuditEvents(100)).some((event) => event.id === audit.id)).toBe(false);
    },
  );

  it("rolls back a malware block when its notification fails, then retries exactly once", async () => {
    const { store, catalog, owner, publish } = await fixture();
    const entry = await publish();
    const request = {
      skillId: entry.id,
      version: "1.0.0",
      reason: "Confirmed malware hash",
      now: 20,
    };
    store.failMalwareNotification();
    await expect(catalog.blockVersion(request)).rejects.toThrow("notification write failed");
    expect(await catalog.getBlockedVersions(entry.id)).toEqual([]);
    expect(
      (await catalog.listHistory({ skillId: entry.id, actorUserId: owner.id })).filter(
        (event) => event.action === "version-blocked",
      ),
    ).toEqual([]);
    expect(await store.listSkillHubNotifications(owner.id, 100)).toEqual([]);
    store.allowMalwareNotification();
    expect(await catalog.blockVersion(request)).toBe(true);
    expect(await catalog.blockVersion({ ...request, now: 21 })).toBe(false);
    expect(await catalog.getBlockedVersions(entry.id)).toEqual(["1.0.0"]);
    expect(
      (await catalog.listHistory({ skillId: entry.id, actorUserId: owner.id })).filter(
        (event) => event.action === "version-blocked",
      ),
    ).toHaveLength(1);
    const notifications = await store.listSkillHubNotifications(owner.id, 100);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "malware-blocked",
      namespace: entry.namespace,
      slug: entry.slug,
    });
    expect(notifications[0]?.message).not.toContain(entry.displayName);
    const trashed = await catalog.trash({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: entry.revision,
      now: 22,
    });
    const due = 22 + 30 * 24 * 60 * 60_000;
    await catalog.beginPurge({ skillId: entry.id, expectedRevision: trashed.revision, now: due });
    await catalog.finishPurge({ skillId: entry.id, now: due });
    expect(await store.listSkillHubNotifications(owner.id, 100)).toEqual([]);
  });

  it("keeps confirmed malicious versions blocked and records installation origins separately per destination", async () => {
    const { store, catalog, publish } = await fixture();
    const room = await store.reserveKnoxRoomAgent({
      accountId: "proof-relay",
      roomId: "proof-room",
      reservedAt: 4,
    });
    await store.transitionAgent({ bindingId: room.binding.id, state: "active", changedAt: 5 });
    const entry = await publish();
    const origin = {
      operationId: "installation-operation",
      agentId: room.binding.agentId,
      targetId: "platform-server",
      slug: entry.slug,
      skillId: entry.id,
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      installedAt: 14,
    };
    await catalog.recordInstallation({
      ...origin,
      destination: "platform_server",
      installedRevision: "sha256:0123456789abcdef",
    });
    expect(await catalog.roomExcludedSlugs(origin.agentId)).toEqual([entry.slug]);
    await catalog.completeInstallation({
      ...origin,
      destination: "platform_server",
      installedRevision: "sha256:0123456789abcdef",
      now: 15,
    });
    await catalog.recordInstallation({
      ...origin,
      destination: "assigned_vm",
      targetId: "saved-vm-one",
    });
    expect([
      ...(await catalog.listInstallations(origin.agentId, "saved-vm-one")),
      ...(await catalog.listInstallations(origin.agentId, "platform-server")),
    ]).toEqual([
      {
        ...origin,
        destination: "assigned_vm",
        targetId: "saved-vm-one",
        installedRevision: null,
        state: "pending",
      },
      {
        ...origin,
        destination: "platform_server",
        installedRevision: "sha256:0123456789abcdef",
        installedAt: 15,
        state: "completed",
      },
    ]);
    expect(await catalog.roomExcludedSlugs(origin.agentId)).toEqual([]);
    expect(
      await catalog.blockVersion({
        skillId: entry.id,
        version: "1.0.0",
        reason: "confirmed-malware",
        now: 12,
      }),
    ).toBe(true);
    expect(
      await catalog.blockVersion({
        skillId: entry.id,
        version: "1.0.0",
        reason: "repeated-result",
        now: 13,
      }),
    ).toBe(false);
    expect(await catalog.getBlockedVersions(entry.id)).toEqual(["1.0.0"]);
    expect(await catalog.roomExcludedSlugs(origin.agentId)).toEqual([entry.slug]);
    await catalog.removeInstallation({
      agentId: origin.agentId,
      destination: "platform_server",
      targetId: "platform-server",
      slug: entry.slug,
    });
    expect(
      (await catalog.listInstallations(origin.agentId, "saved-vm-one")).map(
        (item) => item.destination,
      ),
    ).toEqual(["assigned_vm"]);
    await catalog.recordInstallation({
      ...origin,
      operationId: "new-installation",
      destination: "assigned_vm",
      targetId: "saved-vm-one",
      version: "2.0.0",
      installedAt: 16,
    });
    await expect(
      catalog.completeInstallation({
        ...origin,
        destination: "assigned_vm",
        targetId: "saved-vm-one",
        now: 17,
      }),
    ).rejects.toThrow("replaced");
    await catalog.removeInstallation({
      agentId: origin.agentId,
      destination: "assigned_vm",
      targetId: "saved-vm-one",
      slug: entry.slug,
      operationId: origin.operationId,
    });
    expect((await catalog.listInstallations(origin.agentId, "saved-vm-one"))[0]?.operationId).toBe(
      "new-installation",
    );
  });

  it("defaults a no-organization employee to Public and preserves independent same-name identities", async () => {
    const { catalog, owner, reader } = await fixture();
    const ids = [randomUUID(), randomUUID()];
    for (const operationId of ids) {
      const pending = await catalog.reservePublication({
        operationId,
        actorUserId: owner.id,
        slug: "same-name",
        version: "1.0.0",
        fingerprint: operationId,
        now: 10,
      });
      expect(pending.entry).toMatchObject({
        id: operationId,
        namespace: `pc-${operationId}`,
        sharing: PUBLIC,
        currentVersion: null,
      });
      expect(await catalog.canAccess({ skillId: operationId, userId: reader.id })).toBe(false);
      await catalog.completePublication({ operationId, registryId: ++nativeId, now: 11 });
      expect(await catalog.canAccess({ skillId: operationId, userId: reader.id })).toBe(true);
    }
    expect((await catalog.list()).map((entry) => entry.slug)).toEqual(["same-name", "same-name"]);
    expect((await catalog.list()).map((entry) => entry.namespace)).toHaveLength(2);
  });

  it("keeps selected audience separate from ownership and uses current organization membership", async () => {
    const { store, catalog, owner, reader, admin, publish } = await fixture();
    const team = await store.createManagedScope({
      actorUserId: admin.id,
      kind: "team",
      name: "Other team",
      createdAt: 4,
    });
    const group = await store.createManagedScope({
      actorUserId: admin.id,
      kind: "group",
      name: "Other group",
      parentScopeId: team.id,
      createdAt: 5,
    });
    const part = await store.createManagedScope({
      actorUserId: admin.id,
      kind: "part",
      name: "Other part",
      parentScopeId: group.id,
      createdAt: 6,
    });
    await store.setManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: part.id,
      userId: reader.id,
      role: "member",
      reason: "reader fixture",
      changedAt: 7,
    });
    const entry = await publish();
    const selected = await catalog.updateMetadata({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: entry.revision,
      sharing: { mode: "SELECTED", userIds: [], scopeIds: [team.id] },
      now: 20,
    });
    expect(await catalog.canAccess({ skillId: entry.id, userId: reader.id })).toBe(true);
    expect(await catalog.canAccess({ skillId: entry.id, userId: owner.id })).toBe(true);
    expect(await catalog.canAccess({ skillId: entry.id, userId: admin.id, audience: "room" })).toBe(
      false,
    );
    await expect(
      catalog.updateMetadata({
        skillId: entry.id,
        actorUserId: reader.id,
        expectedRevision: selected.revision,
        summary: "forbidden",
        now: 21,
      }),
    ).rejects.toThrow("owner or administrator");
    await store.removeManagedScopeMembership({
      actorUserId: admin.id,
      scopeId: part.id,
      userId: reader.id,
      reason: "moved away",
      changedAt: 22,
    });
    expect(await catalog.canAccess({ skillId: entry.id, userId: reader.id })).toBe(false);
    const explicit = await catalog.updateMetadata({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: selected.revision,
      sharing: { mode: "SELECTED", userIds: [reader.id], scopeIds: [part.id] },
      now: 23,
    });
    expect(await catalog.canAccess({ skillId: entry.id, userId: reader.id })).toBe(true);
    await expect(
      catalog.updateMetadata({
        skillId: entry.id,
        actorUserId: owner.id,
        expectedRevision: explicit.revision,
        sharing: { mode: "SELECTED", userIds: [], scopeIds: [] },
        now: 24,
      }),
    ).rejects.toThrow("Choose recipients");
    expect((await catalog.get(entry.id))?.sharing.mode).toBe("SELECTED");
  });

  it("changes metadata without broadening sharing or replacing immutable versions", async () => {
    const { catalog, owner, reader, publish } = await fixture();
    const entry = await publish();
    const privateEntry = await catalog.updateMetadata({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: entry.revision,
      sharing: PRIVATE,
      now: 20,
    });
    const icon = {
      contentType: "image/png" as const,
      bytes: Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLb0AAAAASUVORK5CYII=",
          "base64",
        ),
      ),
    };
    const edited = await catalog.updateMetadata({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: privateEntry.revision,
      summary: "Catalog-only description",
      tags: ["docs", "research"],
      icon,
      now: 21,
    });
    expect(edited).toMatchObject({
      currentVersion: "1.0.0",
      summary: "Catalog-only description",
      tags: ["docs", "research"],
      hasIcon: true,
      sharing: PRIVATE,
    });
    expect(await catalog.getIcon(entry.id)).toEqual(icon);
    expect(await catalog.canAccess({ skillId: entry.id, userId: reader.id })).toBe(false);
    const operationId = randomUUID();
    await catalog.reservePublication({
      operationId,
      skillId: entry.id,
      actorUserId: owner.id,
      slug: entry.slug,
      version: "2.0.0",
      fingerprint: "new-files",
      expectedRevision: edited.revision,
      now: 22,
    });
    const updated = await catalog.completePublication({
      operationId,
      registryId: entry.registryId!,
      now: 23,
    });
    expect(updated).toMatchObject({
      sharing: PRIVATE,
      summary: edited.summary,
      tags: edited.tags,
      currentVersion: "2.0.0",
      hasIcon: true,
    });
    await expect(
      catalog.updateMetadata({
        skillId: entry.id,
        actorUserId: owner.id,
        expectedRevision: edited.revision,
        summary: "stale",
        now: 24,
      }),
    ).rejects.toThrow("changed");
  });

  it("replays one immutable receipt and rejects changed requests or disabled publishers", async () => {
    const { catalog, owner, admin, store } = await fixture();
    const request = {
      operationId: randomUUID(),
      actorUserId: owner.id,
      slug: "receipt-test",
      version: "1.0.0",
      fingerprint: "immutable-file-fingerprint",
      now: 10,
    };
    const first = await catalog.reservePublication(request);
    expect(first.reused).toBe(false);
    expect(await catalog.reservePublication({ ...request, now: 11 })).toEqual({
      ...first,
      reused: true,
    });
    await expect(
      catalog.reservePublication({ ...request, fingerprint: "different-files" }),
    ).rejects.toThrow("another request");
    expect(await catalog.listPendingPublications()).toHaveLength(1);
    await expect(
      catalog.trash({
        skillId: first.entry.id,
        actorUserId: owner.id,
        expectedRevision: first.entry.revision,
        now: 12,
      }),
    ).rejects.toThrow("reconciled");
    await store.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: owner.id,
      status: "disabled",
      changedAt: 13,
    });
    await expect(catalog.validatePublication(request.operationId)).rejects.toThrow("Active");
    await expect(
      catalog.cancelPublication({
        operationId: request.operationId,
        actorUserId: admin.id,
        now: 15,
      }),
    ).rejects.toThrow("require a reason");
    await catalog.cancelPublication({
      operationId: request.operationId,
      actorUserId: admin.id,
      reason: "Publisher disabled; cancel incomplete publication",
      now: 15,
    });
    expect((await catalog.getPublication(request.operationId))?.state).toBe("cancelled");
    expect((await catalog.get(first.entry.id))?.currentVersion).toBeNull();
    expect((await catalog.get(first.entry.id))?.deletedAt).toBe(15);
    await expect(
      catalog.restore({
        skillId: first.entry.id,
        actorUserId: admin.id,
        expectedRevision: first.entry.revision + 1,
        reason: "Try cancelled reservation",
        now: 16,
      }),
    ).rejects.toThrow("never completed; start a new publication");
    expect(
      await catalog.listHistory({ skillId: first.entry.id, actorUserId: admin.id }),
    ).toMatchObject([
      {
        action: "publication-cancelled",
        details: { reason: "Publisher disabled; cancel incomplete publication" },
      },
    ]);
  });

  it("records an already committed immutable publication after its original publisher is disabled", async () => {
    const { catalog, owner, admin, store } = await fixture();
    const operationId = randomUUID();
    await catalog.reservePublication({
      operationId,
      actorUserId: owner.id,
      slug: "committed-result",
      version: "1.0.0",
      fingerprint: "verified-immutable-fingerprint",
      now: 10,
    });
    await store.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: owner.id,
      status: "disabled",
      changedAt: 11,
    });
    await expect(catalog.validatePublication(operationId)).rejects.toThrow("Active");
    const completed = await catalog.completePublication({
      operationId,
      registryId: ++nativeId,
      now: 12,
    });
    expect(completed.currentVersion).toBe("1.0.0");
    expect(
      (await catalog.listHistory({ skillId: completed.id, actorUserId: admin.id })).filter(
        (event) => event.action === "version-published",
      ),
    ).toMatchObject([{ actorUserId: owner.id }]);
    await expect(
      catalog.reservePublication({
        operationId: randomUUID(),
        skillId: completed.id,
        actorUserId: owner.id,
        slug: completed.slug,
        version: "1.0.1",
        fingerprint: "new-files",
        expectedRevision: completed.revision,
        now: 13,
      }),
    ).rejects.toThrow("Active");
  });

  it("requires transfer acceptance and removes the previous owner's management rights", async () => {
    const { catalog, owner, reader, publish } = await fixture();
    const entry = await publish();
    const privateEntry = await catalog.updateMetadata({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: entry.revision,
      sharing: PRIVATE,
      now: 20,
    });
    const invitation = await catalog.requestTransfer({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: privateEntry.revision,
      recipientUserId: reader.id,
      now: 21,
    });
    expect(invitation.ownerUserId).toBe(owner.id);
    expect(await catalog.canAccess({ skillId: entry.id, userId: reader.id })).toBe(false);
    expect((await catalog.listTransfers(reader.id)).map((item) => item.id)).toEqual([entry.id]);
    await expect(
      catalog.acceptTransfer({
        skillId: entry.id,
        actorUserId: owner.id,
        expectedRevision: invitation.revision,
        now: 22,
      }),
    ).rejects.toThrow("not addressed");
    const accepted = await catalog.acceptTransfer({
      skillId: entry.id,
      actorUserId: reader.id,
      expectedRevision: invitation.revision,
      now: 23,
    });
    expect(accepted.ownerUserId).toBe(reader.id);
    expect(await catalog.canAccess({ skillId: entry.id, userId: owner.id })).toBe(false);
    await expect(
      catalog.updateMetadata({
        skillId: entry.id,
        actorUserId: owner.id,
        expectedRevision: accepted.revision,
        summary: "forbidden",
        now: 24,
      }),
    ).rejects.toThrow("owner or administrator");
  });

  it("restores for 30 days and retains only management metadata for a year after actual purge", async () => {
    const { catalog, owner, reader, publish } = await fixture();
    const entry = await publish();
    const privateEntry = await catalog.updateMetadata({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: entry.revision,
      sharing: PRIVATE,
      tags: ["sensitive"],
      summary: "Must be removed on purge",
      now: 20,
    });
    const deleted = await catalog.trash({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: privateEntry.revision,
      now: 30,
    });
    expect(await catalog.canAccess({ skillId: entry.id, userId: owner.id })).toBe(false);
    await expect(
      catalog.listHistory({ skillId: entry.id, actorUserId: reader.id }),
    ).rejects.toThrow("unavailable");
    const restored = await catalog.restore({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: deleted.revision,
      now: 31,
    });
    expect(restored).toMatchObject({
      id: entry.id,
      registryId: entry.registryId,
      sharing: PRIVATE,
      deletedAt: null,
    });
    const trashed = await catalog.trash({
      skillId: entry.id,
      actorUserId: owner.id,
      expectedRevision: restored.revision,
      now: 40,
    });
    const due = 40 + 30 * 24 * 60 * 60 * 1_000;
    await catalog.recordInstallation({
      agentId: "room-agent",
      destination: "platform_server",
      targetId: "platform-server",
      slug: entry.slug,
      skillId: entry.id,
      version: "1.0.0",
      archiveSha256: "a".repeat(64),
      installedAt: 25,
    });
    expect(await catalog.listPurgeDue(due - 1)).toEqual([]);
    expect((await catalog.listPurgeDue(due)).map((item) => item.id)).toEqual([entry.id]);
    await expect(
      catalog.restore({
        skillId: entry.id,
        actorUserId: owner.id,
        expectedRevision: trashed.revision,
        now: due,
      }),
    ).rejects.toThrow("no longer");
    const purging = await catalog.beginPurge({
      skillId: entry.id,
      expectedRevision: trashed.revision,
      now: due,
    });
    await expect(
      catalog.restore({
        skillId: entry.id,
        actorUserId: owner.id,
        expectedRevision: purging.revision,
        now: due,
      }),
    ).rejects.toThrow("no longer");
    const purgedAt = due + 10_000;
    await catalog.finishPurge({ skillId: entry.id, now: purgedAt });
    expect(await catalog.get(entry.id)).toMatchObject({
      displayName: "",
      summary: "",
      tags: [],
      sharing: PRIVATE,
      currentVersion: null,
      purgedAt,
    });
    const history = await catalog.listHistory({ skillId: entry.id, actorUserId: owner.id });
    expect(history.length).toBeGreaterThan(0);
    expect(
      history.every((event) => event.management && Object.keys(event.details).length === 0),
    ).toBe(true);
    const year = 365 * 24 * 60 * 60 * 1_000;
    expect(await catalog.pruneHistory(purgedAt + year - 1)).toBe(0);
    expect(await catalog.pruneHistory(purgedAt + year)).toBe(1);
    expect(await catalog.get(entry.id)).toBeNull();
    // The room must still recognize this old Hub installation after catalog pruning.
    expect((await catalog.listInstallations("room-agent", "platform-server"))[0]?.skillId).toBe(
      entry.id,
    );
  });

  it("imports prior ownership as Public once without resetting later explicit privacy", async () => {
    const { store, catalog, owner, admin, reader } = await fixture();
    store.seedLegacySkill(owner.id);
    const room = await store.reserveKnoxRoomAgent({
      accountId: "proof-relay",
      roomId: "proof-room",
      reservedAt: 5,
    });
    for (const [version, createdAt] of [
      ["0.0.1", 7],
      ["1.0.0", 8],
    ] as const) {
      await store.recordAuditEvent({
        actorUserId: owner.id,
        eventType: "skill-hub.install",
        targetType: "skill-hub-skill",
        targetId: `global/legacy-skill@${version}`,
        details: {
          agentId: room.binding.agentId,
          destination: "platform_server",
          sha256: "b".repeat(64),
        },
        createdAt,
      });
    }
    const imported = await catalog.importLegacy({
      id: randomUUID(),
      registryId: ++nativeId,
      namespace: "global",
      slug: "legacy-skill",
      displayName: "Legacy",
      summary: "Legacy private content",
      currentVersion: "1.0.0",
      now: 10,
    });
    expect(imported).toMatchObject({ ownerUserId: owner.id, sharing: PUBLIC });
    expect(await catalog.listInstallations(room.binding.agentId, "platform-server")).toMatchObject([
      {
        skillId: imported.id,
        version: "1.0.0",
        state: "pending",
        installedRevision: null,
        installedAt: 8,
      },
    ]);
    expect(await catalog.canAccess({ skillId: imported.id, userId: reader.id })).toBe(true);
    const privateEntry = await catalog.updateMetadata({
      skillId: imported.id,
      actorUserId: owner.id,
      expectedRevision: imported.revision,
      sharing: PRIVATE,
      now: 11,
    });
    const replay = await catalog.importLegacy({
      id: randomUUID(),
      registryId: imported.registryId!,
      namespace: "global",
      slug: "legacy-skill",
      displayName: "Must not replace",
      summary: "Must not replace",
      currentVersion: "0.0.1",
      now: 12,
    });
    expect(replay).toEqual(privateEntry);
    await catalog.finishMigration(13);
    expect(await catalog.migrationComplete()).toBe(true);
    await store.setManagedUserStatus({
      actorUserId: admin.id,
      targetUserId: owner.id,
      status: "disabled",
      changedAt: 14,
    });
    const publicEntry = await catalog.updateMetadata({
      skillId: imported.id,
      actorUserId: admin.id,
      reason: "Publish available skill after owner departure",
      expectedRevision: privateEntry.revision,
      sharing: PUBLIC,
      now: 15,
    });
    expect(await catalog.canAccess({ skillId: publicEntry.id, userId: reader.id })).toBe(true);
    await expect(catalog.canAccess({ skillId: publicEntry.id, userId: owner.id })).rejects.toThrow(
      "Active",
    );
  });
});
