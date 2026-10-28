import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createSkillHubHttpFixture } from "./skill-hub-http.test-helpers.js";

describe("Skill Hub HTTP boundary", () => {
  it("preserves the invalid-version reason and exposes a stable localization code", async () => {
    const fixture = await createSkillHubHttpFixture();
    expect(
      await fixture.request("/publish", {
        method: "POST",
        json: { operationId: randomUUID(), skill: "demo-skill", version: "next" },
      }),
    ).toMatchObject({
      status: 400,
      body: {
        error: "version must be valid SemVer",
        details: { code: "skill-hub-invalid-version" },
      },
    });
    expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["Instructions only", "SKILL.md must contain YAML frontmatter"],
    ["---\nname: [\n---\nInstructions", "SKILL.md contains invalid YAML frontmatter"],
    [
      "---\nname: other-skill\ndescription: Demo\n---\nInstructions",
      "SKILL.md name must match the workspace skill directory",
    ],
    ["---\nname: demo-skill\n---\nInstructions", "SKILL.md description is required"],
    [
      "---\nname: demo-skill\ndescription: Demo\nversion: 2\n---\nInstructions",
      "SKILL.md version must be a string",
    ],
  ])("returns an actionable manifest diagnostic with its code (%s)", async (markdown, reason) => {
    const fixture = await createSkillHubHttpFixture();
    await writeFile(path.join(fixture.skillDir, "SKILL.md"), markdown);
    expect(
      await fixture.request("/publish", {
        method: "POST",
        json: {
          operationId: randomUUID(),
          skill: "demo-skill",
          source: "platform_server",
          version: "1.0.0",
        },
      }),
    ).toMatchObject({
      status: 400,
      body: { error: reason, details: { code: "skill-hub-invalid-manifest" } },
    });
    expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });

  it.each(["unassigned", "not-ready", "unavailable"] as const)(
    "distinguishes an unavailable VM (%s) without falling back to Basic",
    async (state) => {
      const fixture = await createSkillHubHttpFixture();
      if (state === "unassigned") {
        fixture.getPersonalExecutionProfile.mockResolvedValue(null);
      } else {
        fixture.getPersonalExecutionProfile.mockResolvedValue({
          agentBindingId: "binding-1",
          activeTarget: "assigned_vm",
          activeAllocationId: state === "unavailable" ? undefined : "allocation-1",
          targetRevision: 7,
          updatedAt: 1,
        });
      }
      expect(
        await fixture.request("/publish", {
          method: "POST",
          json: {
            operationId: randomUUID(),
            skill: "demo-skill",
            version: "1.0.0",
            ...(state === "unavailable" ? {} : { source: "assigned_vm" }),
          },
        }),
      ).toMatchObject({
        status: 409,
        body: { details: { code: `skill-hub-vm-${state}` } },
      });
      expect(fixture.adminRpcCall).not.toHaveBeenCalled();
      expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
      expect(await fixture.store.skillHubCatalog.list()).toEqual([]);
    },
  );

  it.each(["blocked", "unavailable"] as const)(
    "distinguishes a version that is %s at the install boundary",
    async (state) => {
      const fixture = await createSkillHubHttpFixture();
      const entry = await fixture.seedEntry();
      if (state === "blocked") {
        await fixture.store.skillHubCatalog.blockVersion({
          skillId: entry.id,
          version: "1.0.0",
          reason: "Confirmed malware hash",
          now: 20,
        });
      } else {
        fixture.governanceMocks.getArtifactSecurity.mockResolvedValue({
          audits: [],
          blocked: false,
          artifactAvailable: false,
        });
      }
      expect(
        await fixture.request(`/skills/by-id/${entry.id}/install`, {
          method: "POST",
          json: { version: "1.0.0", destination: "platform_server" },
        }),
      ).toMatchObject({
        status: 409,
        body: {
          error:
            state === "blocked"
              ? "This version is blocked as confirmed malware"
              : "This version is not ready to download",
          details: { code: `skill-hub-version-${state}` },
        },
      });
      expect(fixture.adapterMocks.download).not.toHaveBeenCalled();
      expect(fixture.adminRpcCall).not.toHaveBeenCalled();
    },
  );

  it("distinguishes immutable version reuse from a stale metadata revision", async () => {
    const fixture = await createSkillHubHttpFixture();
    const entry = await fixture.seedEntry();
    expect(
      await fixture.request("/publish", {
        method: "POST",
        json: {
          operationId: randomUUID(),
          id: entry.id,
          expectedRevision: entry.revision,
          skill: entry.slug,
          source: "platform_server",
          version: "1.0.0",
        },
      }),
    ).toMatchObject({
      status: 409,
      body: {
        error: "This version already exists. Increase the version before publishing changed files.",
        details: { code: "skill-hub-version-exists" },
      },
    });
    expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });

  it("reports invalid ZIP and manifest version mismatch through the actual upload route", async () => {
    const fixture = await createSkillHubHttpFixture();
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      "---\nname: demo-skill\ndescription: Demo\nversion: 2.0.0\n---\nInstructions",
    );
    for (const [bytes, code] of [
      [Buffer.from("not a ZIP archive"), "skill-hub-invalid-archive"],
      [await zip.generateAsync({ type: "nodebuffer" }), "skill-hub-version-mismatch"],
    ] as const) {
      expect(
        await fixture.request(
          `/publish/upload?operationId=${randomUUID()}&slug=demo-skill&version=1.0.0`,
          { method: "POST", bytes, contentType: "application/zip" },
        ),
      ).toMatchObject({ status: 400, body: { details: { code } } });
    }
    expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });

  it("reuploads the byte-identical ZIP downloaded from a Basic workspace publication", async () => {
    const fixture = await createSkillHubHttpFixture();
    const published = new Map<string, Buffer>();
    const publish = fixture.governanceMocks.publishArtifact.getMockImplementation()!;
    fixture.governanceMocks.publishArtifact.mockImplementation(async (params) => {
      const bytes = Buffer.isBuffer(params.archive)
        ? params.archive
        : await readFile(params.archive.path);
      const result = await publish(params);
      published.set(`${result.namespace}/${result.slug}`, bytes);
      return result;
    });
    fixture.adapterMocks.download.mockImplementation(async (namespace, slug) => {
      const bytes = published.get(`${namespace}/${slug}`);
      if (!bytes) {
        throw new Error("Original native bundle is missing");
      }
      return bytes;
    });
    const originalId = randomUUID();
    expect(
      await fixture.request("/publish", {
        method: "POST",
        json: {
          operationId: originalId,
          skill: "demo-skill",
          source: "platform_server",
          version: "1.2.3",
        },
      }),
    ).toMatchObject({ status: 200, body: { id: originalId } });
    const downloaded = await fixture.request(`/skills/by-id/${originalId}/download?version=1.2.3`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.bytes.readUInt16LE(6) & 8).toBe(8);
    const copyId = randomUUID();
    const uploaded = await fixture.request(
      `/publish/upload?operationId=${copyId}&slug=demo-skill&version=1.2.3`,
      { method: "POST", contentType: "application/zip", bytes: downloaded.bytes },
    );
    expect(uploaded).toMatchObject({
      status: 200,
      body: { id: copyId, slug: "demo-skill", version: "1.2.3" },
    });
    const copy = (await fixture.store.skillHubCatalog.get(copyId))!;
    expect(copy).toMatchObject({ ownerUserId: fixture.actor.user.id, sharing: { mode: "PUBLIC" } });
    expect(published.get(`${copy.namespace}/${copy.slug}`)).toEqual(downloaded.bytes);
    const repeated = await fixture.request(`/skills/by-id/${copyId}/download?version=1.2.3`);
    expect(repeated.status).toBe(200);
    expect(repeated.bytes).toEqual(downloaded.bytes);
    expect(fixture.governanceMocks.publishArtifact).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(fixture.skillDir, "SKILL.md"), "utf8")).toContain(
      "version: 0.0.1",
    );
  });

  it("requires an active real browser session and the mutation origin", async () => {
    const fixture = await createSkillHubHttpFixture();
    expect((await fixture.request("/config", { token: null })).status).toBe(401);
    expect((await fixture.request("/config", { token: "unknown-session" })).status).toBe(401);
    const rejected = await fixture.request("/publish", {
      method: "POST",
      origin: "https://other.test",
      bytes: Buffer.from("invalid JSON"),
    });
    expect(rejected.status).toBe(403);
    expect(rejected.body).toEqual({ error: "request origin is not allowed" });
    expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
    const admin = await fixture.createActor("admin.user");
    await fixture.store.setManagedUserStatus({
      actorUserId: admin.user.id,
      targetUserId: fixture.actor.user.id,
      status: "disabled",
      changedAt: 10,
    });
    expect((await fixture.request("/config")).status).toBe(401);
  });

  it("rejects malformed, oversized, and incorrectly typed requests before native effects", async () => {
    const fixture = await createSkillHubHttpFixture();
    for (const bytes of [
      Buffer.from("{"),
      Buffer.from("[]"),
      Buffer.from(`{"text":"${"x".repeat(17 * 1024)}"}`),
    ]) {
      expect(
        (
          await fixture.request("/publish", {
            method: "POST",
            bytes,
            contentType: "application/json",
          })
        ).status,
      ).toBe(400);
    }
    for (const json of [
      { operationId: randomUUID(), skill: "demo-skill", version: "1.0.0", source: "shared" },
      {
        operationId: randomUUID(),
        skill: "demo-skill",
        version: "1.0.0",
        sharing: { mode: "EVERYONE" },
      },
      {
        operationId: randomUUID(),
        skill: "demo-skill",
        version: "1.0.0",
        sharing: { mode: "SELECTED", userIds: [42] },
      },
    ]) {
      expect((await fixture.request("/publish", { method: "POST", json })).status).toBe(400);
    }
    expect((await fixture.request("/workspace-skills?source=shared")).status).toBe(400);
    expect((await fixture.request("/skills/by-id/%ZZ")).status).toBe(400);
    expect((await fixture.request("/search?limit=NaN")).status).toBe(400);
    expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });

  it("bounds icon uploads, verifies image type, and retires namespace mutations", async () => {
    const fixture = await createSkillHubHttpFixture();
    const entry = await fixture.seedEntry();
    const route = `/skills/by-id/${entry.id}/icon?expectedRevision=${entry.revision}`;
    expect(
      (
        await fixture.request(route, {
          method: "PUT",
          bytes: Buffer.from("<svg/>"),
          contentType: "image/png",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fixture.request(route, {
          method: "PUT",
          bytes: Buffer.alloc(2 * 1024 * 1024 + 1),
          contentType: "image/png",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fixture.request("/publish/upload?slug=demo-skill&version=1.0.0", {
          method: "POST",
          bytes: Buffer.from("not ZIP"),
          contentType: "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fixture.request("/admin/namespaces", {
          method: "POST",
          json: { namespace: "global" },
        })
      ).status,
    ).toBe(404);
    expect((await fixture.store.skillHubCatalog.get(entry.id))?.revision).toBe(entry.revision);
    expect(fixture.governanceMocks.publishArtifact).not.toHaveBeenCalled();
  });
  it("installs the browser client request without a metadata revision", async () => {
    const fixture = await createSkillHubHttpFixture();
    const entry = await fixture.seedEntry();
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      "---\nname: demo-skill\ndescription: Browser install proof\nversion: 1.0.0\n---\nInstructions",
    );
    fixture.adapterMocks.download.mockResolvedValue(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    const result = await fixture.request(`/skills/by-id/${entry.id}/install`, {
      method: "POST",
      json: { version: "1.0.0", destination: "platform_server" },
    });
    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, slug: "demo-skill", version: "1.0.0", target: "platform_server" },
    });
    expect(
      await fixture.store.skillHubCatalog.listInstallations(
        fixture.actor.agentId,
        "platform-server",
      ),
    ).toEqual([expect.objectContaining({ skillId: entry.id, state: "completed" })]);
  });
});
