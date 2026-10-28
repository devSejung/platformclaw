import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createSkillHubHttpFixture } from "./skill-hub-http.test-helpers.js";
import { createSkillHubServiceFixture as fixture } from "./skill-hub-service.test-fixtures.js";

async function archive(version: string, instructions = "Instructions") {
  const zip = new JSZip();
  zip.file(
    "SKILL.md",
    `---\nname: demo-skill\ndescription: VM isolation proof\nversion: ${version}\n---\n${instructions}`,
  );
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("Skill Hub saved VM isolation", () => {
  it.each([
    ["platform_server", "version"],
    ["platform_server", "revision"],
    ["platform_server", "unverified"],
    ["assigned_vm", "version"],
    ["assigned_vm", "revision"],
    ["assigned_vm", "unverified"],
  ] as const)(
    "requires explicit replacement of a %s copy with changed %s",
    async (target, change) => {
      const f = await fixture();
      if (target === "assigned_vm") {
        await f.activateVm((await f.saveVm()).id);
      }
      const entry = f.entry!;
      f.adapterMocks.download.mockImplementation(async (_namespace, _slug, version) =>
        archive(version),
      );
      await f.service.install(f.actor, { id: entry.id, version: "1.0.0", destination: target });
      const inventory = await f.service.workspaceSkills(f.actor, target);
      expect(inventory.items[0]).toMatchObject({ hubSkillId: entry.id, hubVersion: "1.0.0" });
      const context = {
        accountId: "default",
        conversationType: "dm" as const,
        conversationId: "42",
        agentId: f.actor.agentId,
        sessionKey: `agent:${f.actor.agentId}:main`,
      };
      await expect(
        f.service.knoxTool(
          f.actor.user.accountId,
          "install",
          { id: entry.id, version: "1.0.0" },
          context,
        ),
      ).resolves.toMatchObject({ noOp: true });
      const key = `${f.actor.agentId}/${inventory.targetId}`;
      const local = f.installed.get(key)!;
      if (change === "unverified") {
        const [origin] = await f.store.skillHubCatalog.listInstallations(
          f.actor.agentId,
          inventory.targetId,
        );
        await f.store.skillHubCatalog.recordInstallation({
          ...origin!,
          installedRevision: undefined,
        });
      } else {
        f.installed.set(key, {
          ...local,
          ...(change === "version"
            ? { version: "2.0.0" }
            : { revision: "sha256:aaaaaaaaaaaaaaaa" }),
        });
      }
      const origin = await f.store.skillHubCatalog.listInstallations(
        f.actor.agentId,
        inventory.targetId,
      );
      const changed = await f.service.workspaceSkills(f.actor, target);
      expect(changed.items[0]).not.toHaveProperty("hubSkillId");
      expect(changed.items[0]).not.toHaveProperty("hubVersion");
      await expect(
        f.service.knoxTool(
          f.actor.user.accountId,
          "install",
          { id: entry.id, version: "1.0.0" },
          context,
        ),
      ).rejects.toMatchObject({ details: { code: "existing-skill-replacement-required" } });
      expect(f.adapterMocks.download).toHaveBeenCalledOnce();
      expect(f.installed.get(key)).toEqual(
        change === "unverified"
          ? local
          : {
              ...local,
              ...(change === "version"
                ? { version: "2.0.0" }
                : { revision: "sha256:aaaaaaaaaaaaaaaa" }),
            },
      );
      expect(
        await f.store.skillHubCatalog.listInstallations(f.actor.agentId, inventory.targetId),
      ).toEqual(origin);
    },
  );

  function exportArchive(f: Awaited<ReturnType<typeof fixture>>, bytes: () => Buffer) {
    f.adminRpcCall.mockImplementation(async (method, params) => {
      if (method === "platformclaw-execution.skillExport.begin") {
        return { exportId: "vm-source-export", token: "synthetic-export-capability" };
      }
      if (method === "platformclaw-execution.skillExport.status") {
        return { state: "ready", size: bytes().length };
      }
      if (method === "platformclaw-execution.skillExport.read") {
        return { offset: params.offset, data: bytes().toString("base64"), done: true };
      }
      return await f.gatewayCall(method, params);
    });
  }

  it("binds one operation to its actual source even when Basic, VM and ZIP bytes are identical", async () => {
    const f = await createSkillHubHttpFixture();
    const vm = await f.saveVm();
    let bytes: Buffer | undefined;
    const publish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementation(async (params) => {
      bytes = Buffer.isBuffer(params.archive)
        ? params.archive
        : await readFile(params.archive.path);
      return await publish(params);
    });
    const operationId = randomUUID();
    await f.service.publish(f.actor, {
      operationId,
      skill: "demo-skill",
      source: "platform_server",
      version: "1.0.0",
      expectedTargetId: "platform-server",
    });
    if (!bytes) {
      throw new Error("Basic publication did not preserve its original archive");
    }
    const original = bytes;
    await f.activateVm(vm.id);
    exportArchive(f, () => original);
    await expect(
      f.service.publish(f.actor, {
        operationId,
        skill: "demo-skill",
        source: "assigned_vm",
        expectedTargetId: vm.id,
        version: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "skill-hub-publication-changed" });
    expect(
      await f.request(`/publish/upload?operationId=${operationId}&slug=demo-skill&version=1.0.0`, {
        method: "POST",
        bytes: original,
        contentType: "application/zip",
      }),
    ).toMatchObject({ status: 409, body: { details: { code: "skill-hub-publication-changed" } } });
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
  });

  it("recovers the original VM operation after reactivation but rejects changed bytes", async () => {
    const f = await fixture([], undefined, { registrySkill: "absent" });
    const first = await f.saveVm();
    const second = await f.saveVm();
    const initial = await f.activateVm(first.id);
    let bytes = await archive("1.0.0");
    exportArchive(f, () => bytes);
    const publish = f.governanceMocks.publishArtifact.getMockImplementation()!;
    f.governanceMocks.publishArtifact.mockImplementationOnce(async (params) => {
      await publish(params);
      throw new Error("Synthetic lost reply after committed VM publication");
    });
    const request = {
      operationId: randomUUID(),
      skill: "demo-skill",
      source: "assigned_vm" as const,
      expectedTargetId: first.id,
      version: "1.0.0",
    };
    await expect(f.service.publish(f.actor, request)).rejects.toMatchObject({ statusCode: 502 });
    await f.activateVm(second.id);
    await expect(f.service.publish(f.actor, request)).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "skill-hub-changed" },
    });
    const current = await f.activateVm(first.id);
    expect(current.revision).not.toBe(initial.revision);
    expect(current.allocationId).not.toBe(initial.allocationId);
    expect(await f.service.publish(f.actor, request)).toEqual({
      id: request.operationId,
      slug: "demo-skill",
      version: "1.0.0",
    });
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
    bytes = await archive("1.0.0", "Changed after the original publication");
    await expect(f.service.publish(f.actor, request)).rejects.toMatchObject({
      code: "skill-hub-publication-changed",
    });
    expect(f.governanceMocks.publishArtifact).toHaveBeenCalledOnce();
  });

  it("keeps same-name local copies and Hub origins separate across VM reactivation, replacement, removal and Basic", async () => {
    const f = await fixture();
    const first = await f.saveVm();
    const second = await f.saveVm();
    const entry = f.entry!;
    f.adapterMocks.download.mockImplementation(async (_namespace, _slug, version) =>
      archive(version),
    );
    await f.service.install(f.actor, {
      id: entry.id,
      version: "1.0.0",
      destination: "platform_server",
    });
    const basic = await f.store.skillHubCatalog.listInstallations(
      f.actor.agentId,
      "platform-server",
    );
    const firstTarget = await f.activateVm(first.id);
    await f.service.install(f.actor, {
      id: entry.id,
      version: "1.0.0",
      destination: "assigned_vm",
    });
    const firstOrigin = await f.store.skillHubCatalog.listInstallations(f.actor.agentId, first.id);
    await f.activateVm(second.id);
    const local = { slug: entry.slug, version: "1.0.0", revision: "sha256:bbbbbbbbbbbbbbbb" };
    f.installed.set(`${f.actor.agentId}/${second.id}`, local);

    const current = await f.service.workspaceSkills(f.actor, "assigned_vm");
    expect(current.items).toHaveLength(1);
    expect(current.items[0]).not.toHaveProperty("hubSkillId");
    expect(current.items[0]).not.toHaveProperty("hubVersion");
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, second.id)).toEqual([]);
    await expect(
      f.service.install(f.actor, { id: entry.id, version: "2.0.0", destination: "assigned_vm" }),
    ).rejects.toMatchObject({
      details: { code: "existing-skill-replacement-required", currentRevision: local.revision },
    });
    expect(f.installed.get(`${f.actor.agentId}/${second.id}`)).toEqual(local);
    await f.service.install(f.actor, {
      id: entry.id,
      version: "2.0.0",
      destination: "assigned_vm",
      acknowledgedReplacement: true,
      currentRevision: local.revision,
    });
    const secondOrigin = await f.store.skillHubCatalog.listInstallations(
      f.actor.agentId,
      second.id,
    );
    expect(secondOrigin).toMatchObject([
      { skillId: entry.id, version: "2.0.0", targetId: second.id, state: "completed" },
    ]);
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, first.id)).toEqual(
      firstOrigin,
    );
    expect(
      await f.store.skillHubCatalog.listInstallations(f.actor.agentId, "platform-server"),
    ).toEqual(basic);

    const reactivated = await f.activateVm(first.id);
    expect(reactivated.targetId).toBe(firstTarget.targetId);
    expect(reactivated.allocationId).not.toBe(firstTarget.allocationId);
    expect((await f.service.workspaceSkills(f.actor, "assigned_vm")).items).toMatchObject([
      { hubSkillId: entry.id, version: "1.0.0", hubVersion: "1.0.0" },
    ]);
    await f.service.uninstall(f.actor, entry.slug);
    expect(f.installed.has(`${f.actor.agentId}/${first.id}`)).toBe(false);
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, first.id)).toEqual([]);
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, second.id)).toEqual(
      secondOrigin,
    );
    expect(
      await f.store.skillHubCatalog.listInstallations(f.actor.agentId, "platform-server"),
    ).toEqual(basic);
    await f.activateVm(second.id);
    expect((await f.service.workspaceSkills(f.actor, "assigned_vm")).items).toMatchObject([
      { hubSkillId: entry.id, version: "2.0.0" },
    ]);
    expect((await f.service.workspaceSkills(f.actor, "platform_server")).items).toMatchObject([
      { hubSkillId: entry.id, version: "1.0.0" },
    ]);
  });

  it("rejects a VM switch during awaited download before filesystem installation or provenance writes", async () => {
    const f = await fixture();
    const first = await f.saveVm();
    const second = await f.saveVm();
    await f.activateVm(first.id);
    f.adapterMocks.download.mockImplementationOnce(async () => {
      await f.activateVm(second.id);
      return await archive("1.0.0");
    });
    await expect(
      f.service.install(f.actor, { id: f.entry!.id, version: "1.0.0", destination: "assigned_vm" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, first.id)).toEqual([]);
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, second.id)).toEqual([]);
    expect(f.installed.size).toBe(0);
  });

  it("rechecks current VM credentials after download before installation or provenance writes", async () => {
    const f = await fixture();
    const vm = await f.saveVm();
    await f.activateVm(vm.id);
    f.adapterMocks.download.mockImplementationOnce(async () => {
      const credential = await f.store.getUserSshCredentialMetadata({
        actorUserId: f.actor.user.id,
        userId: f.actor.user.id,
      });
      if (!credential) {
        throw new Error("Current fixture credential is missing");
      }
      await f.store.markUserSshCredentialUpdateRequired({
        userId: f.actor.user.id,
        revision: credential.revision,
        failedAt: 30,
      });
      return await archive("1.0.0");
    });
    await expect(
      f.service.install(f.actor, { id: f.entry!.id, version: "1.0.0", destination: "assigned_vm" }),
    ).rejects.toMatchObject({ statusCode: 409, details: { code: "skill-hub-vm-unavailable" } });
    expect(f.adminRpcCall).not.toHaveBeenCalledWith("skills.install", expect.anything());
    expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, vm.id)).toEqual([]);
    expect(f.installed.size).toBe(0);
  });

  it.each(["publish", "install"] as const)(
    "rejects a stale VM inventory at the actual %s HTTP entrypoint before byte effects",
    async (action) => {
      const f = await createSkillHubHttpFixture();
      const first = await f.saveVm();
      const second = await f.saveVm();
      await f.activateVm(first.id);
      const listed = await f.service.workspaceSkills(f.actor, "assigned_vm");
      expect(listed.targetLabel).toBe(first.vmLabel);
      const entry = await f.seedEntry();
      await f.activateVm(second.id);
      f.adminRpcCall.mockClear();
      const response = await f.request(
        action === "publish" ? "/publish" : `/skills/by-id/${entry.id}/install`,
        {
          method: "POST",
          json:
            action === "publish"
              ? {
                  operationId: randomUUID(),
                  skill: "demo-skill",
                  source: "assigned_vm",
                  version: "1.0.0",
                  expectedTargetId: listed.targetId,
                }
              : { version: "1.0.0", destination: "assigned_vm", expectedTargetId: listed.targetId },
        },
      );
      expect(response).toMatchObject({ status: 409 });
      expect(f.adminRpcCall).not.toHaveBeenCalled();
      expect(f.governanceMocks.publishArtifact).not.toHaveBeenCalled();
      expect(f.adapterMocks.download).not.toHaveBeenCalled();
      expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, first.id)).toEqual(
        [],
      );
      expect(await f.store.skillHubCatalog.listInstallations(f.actor.agentId, second.id)).toEqual(
        [],
      );
    },
  );
});
