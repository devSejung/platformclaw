import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSkillHubHttpFixture } from "./skill-hub-http.test-helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLXkAAAAASUVORK5CYII=",
  "base64",
);

describe("Skill Hub ordinary-user HTTP scenarios", () => {
  it("publishes PUBLIC without an organization, permits another member to read, and reserves editing to the owner", async () => {
    const fixture = await createSkillHubHttpFixture();
    const reader = await fixture.createActor("reader.user");
    const operationId = randomUUID();
    const config = await fixture.request("/config");
    expect(config.status).toBe(200);
    expect(config.body).toMatchObject({ defaultSharing: "PUBLIC", scopes: [] });
    expect(config.body).not.toHaveProperty("namespaces");
    const published = await fixture.request("/publish", {
      method: "POST",
      json: {
        operationId,
        skill: "demo-skill",
        version: "1.0.0",
      },
    });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ id: operationId, slug: "demo-skill", version: "1.0.0" });
    const entry = await fixture.store.skillHubCatalog.get(operationId);
    if (!entry) {
      throw new Error("Published entry is missing");
    }
    expect(entry.sharing).toEqual({ mode: "PUBLIC", userIds: [], scopeIds: [] });
    expect(fixture.governanceMocks.publishArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: entry.namespace }),
    );
    const detail = await fixture.request(`/skills/by-id/${entry.id}`, { token: reader.token });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      skill: { id: entry.id, sharing: { mode: "PUBLIC" } },
      canManage: false,
    });
    expect(detail.body).not.toHaveProperty("sharing");
    expect(
      (await fixture.request(`/skills/${entry.namespace}/${entry.slug}`, { token: reader.token }))
        .status,
    ).toBe(200);
    expect(
      (
        await fixture.request(`/skills/by-id/${entry.id}`, {
          method: "PATCH",
          token: reader.token,
          json: {
            expectedRevision: entry.revision,
            summary: "Forged edit",
            actorUserId: fixture.actor.user.id,
          },
        })
      ).status,
    ).toBe(403);
    const stale = await fixture.request(`/skills/by-id/${entry.id}`, {
      method: "PATCH",
      json: { expectedRevision: entry.revision - 1, summary: "Stale edit" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ details: { code: "skill-hub-changed" } });
    expect((await fixture.store.skillHubCatalog.get(entry.id))?.summary).toBe(entry.summary);
  });

  it("lets an author outside a Part select it and applies current Part membership or explicit user grants", async () => {
    const fixture = await createSkillHubHttpFixture();
    const admin = await fixture.createActor("admin.user");
    const member = await fixture.createActor("part.member");
    const direct = await fixture.createActor("direct.reader");
    const outsider = await fixture.createActor("outsider.user");
    const team = await fixture.store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "team",
      name: "Foreign team",
      createdAt: 4,
    });
    const group = await fixture.store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "group",
      name: "Foreign group",
      parentScopeId: team.id,
      createdAt: 5,
    });
    const part = await fixture.store.createManagedScope({
      actorUserId: admin.user.id,
      kind: "part",
      name: "Foreign Part",
      parentScopeId: group.id,
      createdAt: 6,
    });
    await fixture.store.setManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      role: "member",
      reason: "Scenario membership",
      changedAt: 7,
    });
    const entry = await fixture.seedEntry();
    const route = `/skills/by-id/${entry.id}`;
    expect(
      (
        await fixture.request(route, {
          method: "PATCH",
          json: {
            expectedRevision: entry.revision,
            sharing: { mode: "SELECTED", userIds: [direct.user.id], scopeIds: [part.id] },
          },
        })
      ).status,
    ).toBe(200);
    for (const token of [fixture.actor.token, member.token, direct.token]) {
      expect((await fixture.request(route, { token })).status).toBe(200);
    }
    expect((await fixture.request(route, { token: outsider.token })).status).toBe(404);
    expect((await fixture.request(`${route}/history`, { token: outsider.token })).status).toBe(403);
    expect(
      (
        await fixture.request(route, {
          method: "PATCH",
          token: member.token,
          json: { expectedRevision: entry.revision + 1, summary: "Member edit" },
        })
      ).status,
    ).toBe(403);
    await fixture.store.removeManagedScopeMembership({
      actorUserId: admin.user.id,
      scopeId: part.id,
      userId: member.user.id,
      reason: "Member leaves Part",
      changedAt: 8,
    });
    expect((await fixture.request(route, { token: member.token })).status).toBe(404);
    expect((await fixture.request(route, { token: direct.token })).status).toBe(200);
  });

  it("keeps icon and metadata private, preserves them across versions, and filters management history", async () => {
    const fixture = await createSkillHubHttpFixture();
    const reader = await fixture.createActor("reader.user");
    const entry = await fixture.seedEntry();
    const route = `/skills/by-id/${entry.id}`;
    expect(
      (
        await fixture.request(`${route}/icon?expectedRevision=${entry.revision}`, {
          method: "PUT",
          bytes: PNG,
          contentType: "image/png",
        })
      ).status,
    ).toBe(200);
    const icon = await fixture.request(`${route}/icon`, { token: reader.token });
    expect(icon.status).toBe(200);
    expect(icon.bytes).toEqual(PNG);
    expect(icon.headers.get("cache-control")).toBe("private, no-store");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      (
        await fixture.request(route, {
          method: "PATCH",
          json: {
            expectedRevision: entry.revision + 1,
            sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
          },
        })
      ).status,
    ).toBe(200);
    expect((await fixture.request(`${route}/icon`, { token: reader.token })).status).toBe(404);
    expect((await fixture.request(`${route}/icon`, { token: null })).status).toBe(401);
    expect(
      (
        await fixture.request(route, {
          method: "PATCH",
          json: {
            expectedRevision: entry.revision + 2,
            displayName: "Readable title",
            summary: "Separate catalog description",
            tags: ["helpful", "문서"],
          },
        })
      ).status,
    ).toBe(200);
    const updated = await fixture.store.skillHubCatalog.get(entry.id);
    if (!updated) {
      throw new Error("Updated entry is missing");
    }
    expect(
      (
        await fixture.request("/publish", {
          method: "POST",
          json: {
            operationId: randomUUID(),
            skill: "demo-skill",
            version: "3.0.0",
            id: entry.id,
            expectedRevision: updated.revision,
          },
        })
      ).status,
    ).toBe(200);
    const versioned = await fixture.store.skillHubCatalog.get(entry.id);
    expect(versioned).toMatchObject({
      currentVersion: "3.0.0",
      displayName: "Readable title",
      summary: "Separate catalog description",
      tags: ["helpful", "문서"],
      sharing: { mode: "PRIVATE" },
      hasIcon: true,
    });
    if (!versioned) {
      throw new Error("Versioned entry is missing");
    }
    const ownerHistory = await fixture.request(`${route}/history`);
    expect(ownerHistory.status).toBe(200);
    expect(JSON.stringify(ownerHistory.body)).toContain("sharing-updated");
    expect(JSON.stringify(ownerHistory.body)).not.toMatch(/employeeId|email|session-token/u);
    expect(ownerHistory.body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ actor: expect.objectContaining({ id: fixture.actor.user.id }) }),
      ]),
    });
    expect(
      (
        await fixture.request(route, {
          method: "PATCH",
          json: {
            expectedRevision: versioned.revision,
            sharing: { mode: "PUBLIC", userIds: [], scopeIds: [] },
          },
        })
      ).status,
    ).toBe(200);
    const publicHistory = await fixture.request(`${route}/history`, { token: reader.token });
    expect(publicHistory.status).toBe(200);
    expect(JSON.stringify(publicHistory.body)).toContain("metadata-updated");
    expect(JSON.stringify(publicHistory.body)).not.toContain("sharing-updated");
  });

  it("restores trash with its original sharing, transfers only on acceptance, and rejects stale or expired actions", async () => {
    const fixture = await createSkillHubHttpFixture();
    const recipient = await fixture.createActor("new.owner");
    const entry = await fixture.seedEntry({
      sharing: { mode: "PRIVATE", userIds: [], scopeIds: [] },
    });
    const route = `/skills/by-id/${entry.id}`;
    expect(
      (
        await fixture.request(`${route}/delete`, {
          method: "POST",
          json: { expectedRevision: entry.revision },
        })
      ).status,
    ).toBe(200);
    expect((await fixture.request(route)).status).toBe(404);
    expect((await fixture.request("/trash")).body).toMatchObject({
      items: [expect.objectContaining({ id: entry.id, sharing: { mode: "PRIVATE" } })],
    });
    expect(
      (
        await fixture.request(`${route}/restore`, {
          method: "POST",
          json: { expectedRevision: entry.revision },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fixture.request(`${route}/restore`, {
          method: "POST",
          json: { expectedRevision: entry.revision + 1 },
        })
      ).status,
    ).toBe(200);
    expect((await fixture.request(route, { token: recipient.token })).status).toBe(404);
    expect(
      (
        await fixture.request(`${route}/transfer`, {
          method: "POST",
          json: { expectedRevision: entry.revision + 2, userId: recipient.user.id },
        })
      ).status,
    ).toBe(200);
    expect((await fixture.request(route, { token: recipient.token })).status).toBe(404);
    expect((await fixture.request("/transfers", { token: recipient.token })).body).toMatchObject({
      items: [{ id: entry.id, revision: entry.revision + 3 }],
    });
    expect(
      (
        await fixture.request(`${route}/transfer/accept`, {
          method: "POST",
          token: recipient.token,
          json: { expectedRevision: entry.revision + 3 },
        })
      ).status,
    ).toBe(200);
    expect((await fixture.request(route, { token: recipient.token })).status).toBe(200);
    expect((await fixture.request(route)).status).toBe(404);
    expect(
      (
        await fixture.request(route, {
          method: "PATCH",
          json: { expectedRevision: entry.revision + 4, summary: "Former owner edit" },
        })
      ).status,
    ).toBe(403);
    const expired = await fixture.seedEntry({ slug: "expired-skill" });
    const trashed = await fixture.store.skillHubCatalog.trash({
      skillId: expired.id,
      actorUserId: fixture.actor.user.id,
      expectedRevision: expired.revision,
      now: 100 - 31 * 24 * 60 * 60_000,
    });
    expect(
      (
        await fixture.request(`/skills/by-id/${expired.id}/restore`, {
          method: "POST",
          json: { expectedRevision: trashed.revision },
        })
      ).status,
    ).toBe(400);
  });
});
