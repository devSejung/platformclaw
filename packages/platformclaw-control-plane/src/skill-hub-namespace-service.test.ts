import { describe, expect, it, vi } from "vitest";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

describe("Skill Hub namespace service policy", () => {
  it.each([{ namespaces: [] }, { namespaces: ["engineering"] }])(
    "includes implicit Global membership with additional namespaces $namespaces",
    async ({ namespaces }) => {
      const { service, actor, adapterMocks, ensureDefaultSkillHubNamespace } = await fixture(
        [],
        undefined,
        {
          registrySkill: "absent",
          allowedNamespaces: namespaces,
        },
      );
      await expect(service.config(actor)).resolves.toMatchObject({
        admin: false,
        defaultNamespace: "global",
        namespaces: ["global", ...namespaces],
      });
      expect(ensureDefaultSkillHubNamespace).toHaveBeenCalledWith({
        actorUserId: actor.user.id,
        changedAt: 100,
      });
      await expect(
        service.publish(actor, {
          skill: "demo-skill",
          namespace: "global",
          source: "platform_server",
          version: "1.2.3",
          visibility: "NAMESPACE_ONLY",
        }),
      ).resolves.toMatchObject({ namespace: "global" });
      expect(adapterMocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({ namespace: "global", visibility: "NAMESPACE_ONLY" }),
      );
    },
  );

  it("replays completed creation without another registry call or reactivating a restricted binding", async () => {
    const createNamespace = vi.fn();
    const { service, actor, store, getSkillHubNamespaceBinding } = await fixture(undefined, {
      approvePendingReview: vi.fn(),
      createNamespace,
    });
    store.beginSkillHubNamespaceCreation = vi.fn<typeof store.beginSkillHubNamespaceCreation>(
      async () => ({
        namespace: "employee-tools",
        operationId: "completed-operation",
        actorUserId: actor.user.id,
        scopeKind: "global",
        state: "completed",
        registryNamespaceId: 12,
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    getSkillHubNamespaceBinding.mockResolvedValue({
      namespace: "employee-tools",
      scopeKind: "global",
      accessState: "restricted",
      visibilityCeiling: "NAMESPACE_ONLY",
      createdByUserId: actor.user.id,
      createdAt: 1,
      updatedAt: 3,
    });
    await expect(
      service.createNamespace(actor.user, { namespace: "employee-tools", scopeKind: "global" }),
    ).resolves.toMatchObject({ accessState: "restricted", updatedAt: 3 });
    expect(createNamespace).not.toHaveBeenCalled();
  });

  it.each(["a", "bad--name", "bad.name", "-bad", "bad_thing", "a".repeat(65)])(
    "returns the localized invalid-name code for %s",
    async (namespace) => {
      const createNamespace = vi.fn();
      const { service, actor } = await fixture(undefined, {
        approvePendingReview: vi.fn(),
        createNamespace,
      });
      await expect(
        service.createNamespace(actor.user, { namespace, scopeKind: "global" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        details: { code: "skill-hub-namespace-invalid" },
      });
      expect(createNamespace).not.toHaveBeenCalled();
    },
  );

  it("respects Global restriction and lets ordinary members publish after activation", async () => {
    const {
      service,
      actor,
      adapterMocks,
      getSkillHubNamespaceBinding,
      authorizeManagedScope,
      store,
    } = await fixture();
    adapterMocks.getSkill.mockResolvedValue({
      id: 10,
      namespace: "engineering",
      slug: "demo-skill",
      displayName: "Demo Skill",
      summary: "Demo",
      visibility: "NAMESPACE_ONLY",
      status: "PUBLISHED",
    });
    const binding = {
      namespace: "engineering",
      scopeKind: "global" as const,
      accessState: "restricted" as const,
      visibilityCeiling: "PUBLIC" as const,
      createdByUserId: "admin-1",
      createdAt: 1,
      updatedAt: 1,
    };
    getSkillHubNamespaceBinding.mockResolvedValue(binding);
    await expect(service.detail(actor.user, "engineering", "demo-skill")).rejects.toMatchObject({
      statusCode: 404,
    });

    getSkillHubNamespaceBinding.mockImplementation(async (namespace) => ({
      ...binding,
      namespace,
      accessState: "active",
    }));
    await expect(service.config(actor)).resolves.toMatchObject({
      namespaces: ["global", "engineering"],
      defaultNamespace: "global",
      namespaceOptions: [
        { namespace: "global", scopeKind: "global" },
        { namespace: "engineering", scopeKind: "global" },
      ],
    });
    await expect(service.detail(actor.user, "engineering", "demo-skill")).resolves.toMatchObject({
      skill: { slug: "demo-skill" },
    });
    await store.recordSkillHubPublication({
      namespace: "engineering",
      slug: "demo-skill",
      ownerUserId: actor.user.id,
      expectedOwnerUserId: null,
      expectedOwnerUpdatedAt: null,
      expectedBindingUpdatedAt: 1,
      visibility: "NAMESPACE_ONLY",
      version: "1.0.0",
      changedAt: 1,
    });
    await expect(
      service.publish(actor, {
        skill: "demo-skill",
        namespace: "engineering",
        version: "1.2.3",
        visibility: "NAMESPACE_ONLY",
      }),
    ).resolves.toMatchObject({ namespace: "engineering", slug: "demo-skill" });
    expect(authorizeManagedScope).not.toHaveBeenCalled();
  });

  it("starts new Global bindings active and preserves explicit restrictions on binding edits", async () => {
    const { service, actor, getSkillHubNamespaceBinding } = await fixture();
    const admin = { ...actor.user, globalRole: "admin" as const };
    getSkillHubNamespaceBinding.mockResolvedValue(null);
    const params = {
      namespace: "engineering",
      scopeKind: "global" as const,
      visibilityCeiling: "NAMESPACE_ONLY",
      expectedUpdatedAt: null,
      reason: "open company-wide publishing",
    };
    await expect(service.setNamespaceBinding(admin, params)).resolves.toMatchObject({
      accessState: "active",
    });
    getSkillHubNamespaceBinding.mockResolvedValue({
      namespace: "engineering",
      scopeKind: "global",
      accessState: "restricted",
      visibilityCeiling: "NAMESPACE_ONLY",
      createdByUserId: admin.id,
      createdAt: 1,
      updatedAt: 2,
    });
    await expect(
      service.setNamespaceBinding(admin, { ...params, expectedUpdatedAt: 2 }),
    ).resolves.toMatchObject({ accessState: "restricted" });
    await expect(service.setNamespaceBinding(actor.user, params)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("does not let members claim configured namespaces even before administrator binding", async () => {
    const createNamespace = vi.fn(async () => ({ id: 12, namespace: "engineering" }));
    const { service, actor, getSkillHubNamespaceBinding } = await fixture([], {
      approvePendingReview: vi.fn(),
      createNamespace,
    });
    getSkillHubNamespaceBinding.mockResolvedValue(null);
    await expect(
      service.createNamespace(actor.user, { namespace: "engineering", scopeKind: "global" }),
    ).rejects.toMatchObject({ statusCode: 409, details: { code: "skill-hub-namespace-conflict" } });
    expect(createNamespace).not.toHaveBeenCalled();
  });
});
