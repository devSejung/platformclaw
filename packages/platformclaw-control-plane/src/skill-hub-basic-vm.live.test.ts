import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createSkillHubBuiltBrowserProof } from "../../../ui/src/e2e/skill-hub-basic-vm.live.test-helpers.js";
import { createSkillHubBasicVmLiveFixture } from "./skill-hub-basic-vm.test-helpers.js";

const enabled = Boolean(process.env.PLATFORMCLAW_SKILL_HUB_LIVE_SSH_FIXTURE_FILE);

function markdown(slug: string, marker: string, version = "1.0.0") {
  return `---\nname: ${slug}\ndescription: Disposable real transport proof\nversion: ${version}\n---\n${marker}\n`;
}

// A public, fixed identifier deliberately matches the native secret heuristic;
// it is not a credential and must warn without blocking a valid package.
const heuristicText = "token=synthetic_identifier_0123456789\n";

async function jsonResponse<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status });
  return body as T;
}

async function reuploadDownloadedArchive(
  fixture: Awaited<ReturnType<typeof createSkillHubBasicVmLiveFixture>>,
  original: { id: string; slug: string; version: string },
  bytes: Buffer,
) {
  const { store, author, reader, request } = fixture;
  const before = await store.getPersonalExecutionProfile(reader.binding.agentId);
  const copyId = randomUUID();
  const query = new URLSearchParams({
    operationId: copyId,
    slug: original.slug,
    version: original.version,
  });
  const response = await fetch(
    `${fixture.browserOrigin}/platformclaw/api/skill-hub/publish/upload?${query}`,
    {
      method: "POST",
      headers: {
        cookie: `platformclaw_session=${reader.cookie}`,
        origin: "http://proof.test",
        "content-type": "application/zip",
      },
      body: new Uint8Array(bytes),
    },
  );
  const copy = await jsonResponse<{ id: string; slug: string; version: string }>(response);
  expect(copy).toEqual({ id: copyId, slug: original.slug, version: original.version });
  expect(copy.id).not.toBe(original.id);
  expect(await store.skillHubCatalog.get(copy.id)).toMatchObject({
    ownerUserId: reader.user.id,
    sharing: { mode: "PUBLIC" },
  });
  const downloaded = await request(
    "author",
    `/skills/by-id/${copy.id}/download?version=${copy.version}`,
  );
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  expect(await store.getPersonalExecutionProfile(reader.binding.agentId)).toEqual(before);
  expect(author.user.globalRole).toBe("member");
}

describe.skipIf(!enabled)("Skill Hub Basic and assigned VM real transport", () => {
  it("publishes, downloads and installs on explicit targets and rejects stale or unavailable destinations", async () => {
    const fixture = await createSkillHubBasicVmLiveFixture();
    const { store, rpc, author, reader, request } = fixture;
    let browser: Awaited<ReturnType<typeof createSkillHubBuiltBrowserProof>> | null = null;
    const basicSlug = `proof-basic-${randomUUID().slice(0, 8)}`;
    const vmSlug = `proof-vm-${randomUUID().slice(0, 8)}`;
    const authorAgentId = author.binding.agentId;
    const readerAgentId = reader.binding.agentId;
    const readerVmTargetId = (
      await store.resolvePersonalExecutionTarget(readerAgentId, "assigned_vm")
    ).targetId;
    const installationOrigins = async () => [
      ...(await store.skillHubCatalog.listInstallations(readerAgentId, "platform-server")),
      ...(await store.skillHubCatalog.listInstallations(readerAgentId, readerVmTargetId)),
    ];
    type Published = { id: string; slug: string; version: string };
    type Workspace = { items: Array<{ skillKey: string; revision: string; version: string }> };
    try {
      browser = process.env.PLATFORMCLAW_SKILL_HUB_LIVE_BROWSER_PROOF_DIR
        ? await createSkillHubBuiltBrowserProof(
            fixture,
            process.env.PLATFORMCLAW_SKILL_HUB_LIVE_BROWSER_PROOF_DIR,
          )
        : null;
      expect(author.user.globalRole).toBe("member");
      expect(reader.user.globalRole).toBe("member");
      expect(await store.listUserManagedScopeMemberships(author.user.id)).toEqual([]);
      expect(await store.listUserManagedScopeMemberships(reader.user.id)).toEqual([]);
      expect(await (await request("author", "/config")).json()).toMatchObject({
        admin: false,
        defaultSharing: "PUBLIC",
      });
      const basicDir = path.join(author.workspaceDir, "skills", basicSlug);
      await mkdir(basicDir);
      await writeFile(path.join(basicDir, "SKILL.md"), markdown(basicSlug, "BASIC_SOURCE_BYTES"));
      await writeFile(path.join(basicDir, "notes.txt"), heuristicText);
      const authorInitial = (await store.getPersonalExecutionProfile(authorAgentId))!;
      await rpc.call("platformclaw-execution.changeTarget", {
        agentId: authorAgentId,
        target: "assigned_vm",
        expectedRevision: authorInitial.targetRevision,
      });
      const authorVmProfile = await store.getPersonalExecutionProfile(authorAgentId);
      const basic = browser
        ? await browser.publish("platform_server", basicSlug)
        : await jsonResponse<Published>(
            await request("author", "/publish", {
              operationId: randomUUID(),
              source: "platform_server",
              skill: basicSlug,
              version: "1.0.0",
            }),
          );
      expect(await store.getPersonalExecutionProfile(authorAgentId)).toEqual(authorVmProfile);
      expect((await store.skillHubCatalog.get(basic.id))?.sharing.mode).toBe("PUBLIC");
      const basicDownload = await request(
        "reader",
        `/skills/by-id/${basic.id}/download?version=1.0.0`,
      );
      expect(basicDownload.status).toBe(200);
      const basicBytes = Buffer.from(await basicDownload.arrayBuffer());
      expect(basicBytes.readUInt16LE(6) & 8).toBe(8);
      const basicZip = await JSZip.loadAsync(basicBytes);
      expect(await basicZip.file("SKILL.md")!.async("string")).toContain("BASIC_SOURCE_BYTES");
      expect(await basicZip.file("notes.txt")!.async("string")).toBe(heuristicText);
      // The actual native service preserves Basic's streamed ZIP descriptors.
      // An ordinary member must be able to upload that exact downloaded package.
      await reuploadDownloadedArchive(fixture, basic, basicBytes);
      const readerBasicProfile = (await store.getPersonalExecutionProfile(readerAgentId))!;
      await jsonResponse(
        await request("reader", `/skills/by-id/${basic.id}/install`, {
          destination: "platform_server",
          version: "1.0.0",
          expectedTargetRevision: readerBasicProfile.targetRevision,
        }),
      );
      const readerBasicFile = path.join(reader.workspaceDir, "skills", basicSlug, "SKILL.md");
      expect(await readFile(readerBasicFile, "utf8")).toContain("BASIC_SOURCE_BYTES");
      expect(await store.getPersonalExecutionProfile(readerAgentId)).toEqual(readerBasicProfile);

      // Seed through the actual Gateway upload/install owner, then publish the
      // VM's filesystem bytes through its actual SSH exporter.
      const seed = await new JSZip()
        .file("SKILL.md", markdown(vmSlug, "VM_SOURCE_BYTES"))
        .file("notes.txt", heuristicText)
        .generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      const sha256 = createHash("sha256").update(seed).digest("hex");
      const upload = await rpc.call<{ uploadId: string }>("skills.upload.begin", {
        kind: "skill-archive",
        slug: vmSlug,
        sizeBytes: seed.length,
        sha256,
        force: false,
        idempotencyKey: randomUUID(),
      });
      await rpc.call("skills.upload.chunk", {
        uploadId: upload.uploadId,
        offset: 0,
        dataBase64: seed.toString("base64"),
      });
      await rpc.call("skills.upload.commit", { uploadId: upload.uploadId, sha256 });
      expect(
        await rpc.call("skills.install", {
          agentId: authorAgentId,
          source: "upload",
          uploadId: upload.uploadId,
          slug: vmSlug,
          force: false,
          sha256,
          destination: "sandbox-backend",
          backendTarget: "assigned_vm",
          expectedTargetRevision: authorVmProfile!.targetRevision,
        }),
      ).toMatchObject({ ok: true, slug: vmSlug });
      const vm = browser
        ? await browser.publish("assigned_vm", vmSlug)
        : await jsonResponse<Published>(
            await request("author", "/publish", {
              operationId: randomUUID(),
              source: "assigned_vm",
              skill: vmSlug,
              version: "1.0.0",
            }),
          );
      expect(await store.getPersonalExecutionProfile(authorAgentId)).toEqual(authorVmProfile);
      const vmDownload = await request("reader", `/skills/by-id/${vm.id}/download?version=1.0.0`);
      expect(vmDownload.status).toBe(200);
      const vmBytes = Buffer.from(await vmDownload.arrayBuffer());
      const vmZip = await JSZip.loadAsync(vmBytes);
      expect(await vmZip.file("SKILL.md")!.async("string")).toContain("VM_SOURCE_BYTES");
      expect(await vmZip.file("notes.txt")!.async("string")).toBe(heuristicText);
      // Retry real producer bytes across ZIP's two-second timestamp granularity.
      // Repackaging an unchanged workspace must recover the original operation.
      await delay(2_100);
      for (const [source, published] of [
        ["platform_server", basic],
        ["assigned_vm", vm],
      ] as const) {
        const target = await store.resolvePersonalExecutionTarget(authorAgentId, source);
        const retried = await jsonResponse<Published>(
          await request("author", "/publish", {
            operationId: published.id,
            source,
            expectedTargetId: target.targetId,
            skill: published.slug,
            version: published.version,
            ...(browser ? { sharing: { mode: "PUBLIC", userIds: [], scopeIds: [] } } : {}),
          }),
        );
        expect(retried).toEqual(published);
        const detail = await jsonResponse<{ versions: Array<{ version: string }> }>(
          await request("author", `/skills/by-id/${published.id}`),
        );
        expect(detail.versions).toHaveLength(1);
      }
      await reuploadDownloadedArchive(fixture, vm, vmBytes);
      if (browser) {
        await browser.installVm(vm);
      } else {
        await jsonResponse(
          await request("reader", `/skills/by-id/${vm.id}/install`, {
            destination: "assigned_vm",
            version: "1.0.0",
            expectedTargetRevision: readerBasicProfile.targetRevision,
          }),
        );
      }
      const readerVm = await jsonResponse<Workspace>(
        await request("reader", "/workspace-skills?source=assigned_vm"),
      );
      expect(readerVm.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ skillKey: vmSlug, version: "1.0.0" })]),
      );
      expect(await store.getPersonalExecutionProfile(readerAgentId)).toEqual(readerBasicProfile);
      await expect(
        readFile(path.join(reader.workspaceDir, "skills", vmSlug, "SKILL.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      // A different Hub identity with the same physical package/version needs
      // confirmation, and confirmation cannot authorize a changed revision.
      const other = await jsonResponse<Published>(
        await request("author", "/publish", {
          operationId: randomUUID(),
          source: "platform_server",
          skill: basicSlug,
          version: "1.0.0",
        }),
      );
      expect(other.id).not.toBe(basic.id);
      const collision = await jsonResponse<{ details: { code: string; currentRevision: string } }>(
        await request("reader", `/skills/by-id/${other.id}/install`, {
          destination: "platform_server",
          version: "1.0.0",
        }),
        409,
      );
      expect(collision.details.code).toBe("existing-skill-replacement-required");
      await writeFile(readerBasicFile, markdown(basicSlug, "READER_EDIT_AFTER_CONFIRMATION"));
      const stale = await jsonResponse<{ details: { currentRevision: string } }>(
        await request("reader", `/skills/by-id/${other.id}/install`, {
          destination: "platform_server",
          version: "1.0.0",
          acknowledgedReplacement: true,
          currentRevision: collision.details.currentRevision,
        }),
        409,
      );
      expect(stale.details.currentRevision).not.toBe(collision.details.currentRevision);
      expect(await readFile(readerBasicFile, "utf8")).toContain("READER_EDIT_AFTER_CONFIRMATION");
      await jsonResponse(
        await request("reader", `/skills/by-id/${other.id}/install`, {
          destination: "platform_server",
          version: "1.0.0",
          acknowledgedReplacement: true,
          currentRevision: stale.details.currentRevision,
        }),
      );
      expect(
        (await store.skillHubCatalog.listInstallations(readerAgentId, "platform-server")).find(
          (item) => item.destination === "platform_server" && item.slug === basicSlug,
        )?.skillId,
      ).toBe(other.id);

      await rpc.call("platformclaw-execution.changeTarget", {
        agentId: readerAgentId,
        target: "assigned_vm",
        expectedRevision: readerBasicProfile.targetRevision,
      });
      const selectedVm = (await store.getPersonalExecutionProfile(readerAgentId))!;
      await rpc.call("platformclaw-execution.changeTarget", {
        agentId: readerAgentId,
        target: "platform_server",
        expectedRevision: selectedVm.targetRevision,
      });
      const selectedBasic = (await store.getPersonalExecutionProfile(readerAgentId))!;
      const beforeStale = fixture.rpcCalls.length;
      await jsonResponse(
        await request("reader", `/skills/by-id/${basic.id}/install`, {
          destination: "assigned_vm",
          version: "1.0.0",
          expectedTargetRevision: readerBasicProfile.targetRevision,
        }),
        409,
      );
      expect(fixture.rpcCalls.length).toBe(beforeStale);
      expect(await store.getPersonalExecutionProfile(readerAgentId)).toEqual(selectedBasic);

      const allocation = (await store.getVmAllocationForAgent(readerAgentId))!;
      const localBytes = await readFile(readerBasicFile);
      const origins = await installationOrigins();
      await store.recordVmConnectionResult({
        actorUserId: reader.user.id,
        agentId: readerAgentId,
        expectedAllocationId: allocation.id,
        expectedTargetRevision: selectedBasic.targetRevision,
        checkedAt: Date.now(),
        result: { status: "connection_required", failureCode: "proof-unready" },
      });
      const beforeUnready = fixture.rpcCalls.length;
      await jsonResponse(
        await request("reader", `/skills/by-id/${basic.id}/install`, {
          destination: "assigned_vm",
          version: "1.0.0",
        }),
        409,
      );
      expect(fixture.rpcCalls.length).toBe(beforeUnready);
      expect(await readFile(readerBasicFile)).toEqual(localBytes);
      expect(await installationOrigins()).toEqual(origins);
      await store.releasePersonalVmAllocation({
        actorUserId: reader.user.id,
        agentId: readerAgentId,
        releasedAt: Date.now(),
      });
      const beforeMissing = fixture.rpcCalls.length;
      await jsonResponse(
        await request("reader", `/skills/by-id/${basic.id}/install`, {
          destination: "assigned_vm",
          version: "1.0.0",
        }),
        409,
      );
      expect(fixture.rpcCalls.length).toBe(beforeMissing);
      expect(await readFile(readerBasicFile)).toEqual(localBytes);
      expect(await installationOrigins()).toEqual(origins);
      expect(fixture.rpcCalls).toEqual(
        expect.arrayContaining([
          "platformclaw-execution.testCandidateConnection",
          "platformclaw-execution.skillExport.begin",
          "platformclaw-execution.skillExport.status",
          "platformclaw-execution.skillExport.read",
          "platformclaw-execution.skillExport.close",
          "skills.install",
        ]),
      );
    } catch (error) {
      console.error(fixture.sanitizedGatewayLogs());
      throw error;
    } finally {
      try {
        await browser?.close();
      } finally {
        await fixture.close();
      }
    }
  }, 180_000);

  it("lets an ordinary owner update a migrated native PUBLIC skill without changing its identity or old version", async () => {
    const fixture = await createSkillHubBasicVmLiveFixture();
    const { store, author, reader, request, adapter, governance, publishLegacy } = fixture;
    const operationId = randomUUID();
    const namespace = `pc-${operationId}`;
    const slug = `proof-legacy-${randomUUID().slice(0, 8)}`;
    try {
      expect(author.user.globalRole).toBe("member");
      expect(reader.user.globalRole).toBe("member");
      expect(await store.listUserManagedScopeMemberships(author.user.id)).toEqual([]);
      await governance.createNamespace({ namespace, operationId });
      const original = await new JSZip()
        .file("SKILL.md", markdown(slug, "LEGACY_ORIGINAL_BYTES"))
        .generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      await publishLegacy(namespace, original, `${slug}-1.0.0.zip`);
      const native = await adapter.getSkill(namespace, slug);
      expect(native.visibility).toBe("PUBLIC");
      const oldVersion = await adapter.getVersionState(namespace, slug, "1.0.0");

      // Authentication performs the actual one-time native catalog import.
      await jsonResponse(await request("author", "/config"));
      const imported = (await store.skillHubCatalog.getByCoordinate(namespace, slug))!;
      expect(imported).toMatchObject({ registryId: native.id, sharing: { mode: "PUBLIC" } });
      const offered = await jsonResponse<{ revision: number }>(
        await request("admin", `/skills/by-id/${imported.id}/transfer`, {
          expectedRevision: imported.revision,
          userId: author.user.id,
          reason: "Assign the migrated disposable skill to its accountable employee",
        }),
      );
      await jsonResponse(
        await request("author", `/skills/by-id/${imported.id}/transfer/accept`, {
          expectedRevision: offered.revision,
        }),
      );
      const owned = (await store.skillHubCatalog.get(imported.id))!;
      expect(owned.ownerUserId).toBe(author.user.id);
      const directory = path.join(author.workspaceDir, "skills", slug);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "SKILL.md"),
        markdown(slug, "LEGACY_UPDATED_BYTES", "1.0.1"),
      );
      const publication = {
        operationId: randomUUID(),
        id: owned.id,
        expectedRevision: owned.revision,
        skill: slug,
        source: "platform_server",
        version: "1.0.1",
      };
      await jsonResponse(await request("reader", "/publish", publication), 403);
      expect((await store.skillHubCatalog.get(owned.id))?.revision).toBe(owned.revision);
      expect(await adapter.listVersions(namespace, slug)).toHaveLength(1);
      const published = await jsonResponse<{ id: string; slug: string; version: string }>(
        await request("author", "/publish", publication),
      );
      expect(published).toEqual({ id: owned.id, slug, version: "1.0.1" });
      expect(await (await request("author", "/publish", publication)).json()).toEqual(published);
      expect(await adapter.getSkill(namespace, slug)).toMatchObject({
        id: native.id,
        visibility: "PUBLIC",
      });
      expect(await adapter.getVersionState(namespace, slug, "1.0.0")).toMatchObject({
        id: oldVersion.id,
      });
      const updated = (await store.skillHubCatalog.get(owned.id))!;
      expect(updated).toMatchObject({
        registryId: native.id,
        ownerUserId: author.user.id,
        currentVersion: "1.0.1",
        sharing: { mode: "PUBLIC" },
      });
      const currentDetail = await fixture.service.detailById(reader.user, owned.id);
      expect(currentDetail.versions.map((version) => version.version)).toEqual(["1.0.1", "1.0.0"]);
      expect(currentDetail.scanner).toEqual(currentDetail.versions[0]!.scanner);
      expect(await fixture.service.resolveCommandSkill(reader.user, owned.id)).toEqual({
        id: owned.id,
        slug,
        version: "1.0.1",
      });
      for (const [version, marker] of [
        ["1.0.0", "LEGACY_ORIGINAL_BYTES"],
        ["1.0.1", "LEGACY_UPDATED_BYTES"],
      ] as const) {
        const response = await request(
          "reader",
          `/skills/by-id/${owned.id}/download?version=${version}`,
        );
        expect(response.status).toBe(200);
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        expect(await zip.file("SKILL.md")!.async("string")).toBe(markdown(slug, marker, version));
      }
      await jsonResponse(
        await request("author", "/publish", {
          ...publication,
          operationId: randomUUID(),
          expectedRevision: updated.revision,
        }),
        409,
      );
      expect(await adapter.listVersions(namespace, slug)).toHaveLength(2);
      expect((await store.skillHubCatalog.get(owned.id))?.revision).toBe(updated.revision);
    } finally {
      await fixture.close();
    }
  }, 180_000);
});
