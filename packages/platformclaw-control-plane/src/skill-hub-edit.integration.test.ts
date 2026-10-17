import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { createSkillHubEditHttpFixture as fixture } from "./skill-hub-edit.test-fixtures.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";

describe("Skill Hub edit browser boundary", () => {
  it("keeps a Private exact-version grant out of aggregate detail while allowing only its named install", async () => {
    const f = await fixture(true);
    const access = { namespace: "source", slug: "demo", userId: f.outsider.id, now: Date.now() };
    await expect(f.store.hasSkillHubAccess(access)).resolves.toBe(false);
    await expect(f.store.hasSkillHubAccess({ ...access, version: "1.0.0" })).resolves.toBe(true);
    await expect(f.store.hasSkillHubAccess({ ...access, version: "2.0.0" })).resolves.toBe(false);
    expect((await f.request("outsider", "/skills/source/demo")).status).toBe(404);
    const install = {
      namespace: "source",
      slug: "demo",
      version: "2.0.0",
      destination: "platform_server",
    };
    expect((await f.request("outsider", "/install", install)).status).toBe(404);
    expect(f.registry.download).not.toHaveBeenCalled();
    expect(f.rpcCall).not.toHaveBeenCalled();

    // Native Private UPLOADED releases are previewable by the server identity;
    // the employee's exact grant must still authorize the requested version.
    f.registry.versions[1]!.status = "UPLOADED";
    const zip = new JSZip();
    zip.file("SKILL.md", "---\nname: demo\ndescription: Demo\nversion: 1.0.0\n---\nInstructions");
    f.registry.download.mockResolvedValue(await zip.generateAsync({ type: "nodebuffer" }));
    f.rpcCall.mockImplementation(async (method) => {
      if (method === "skills.status") {
        return { skills: [] };
      }
      if (method === "skills.upload.begin") {
        return { uploadId: "grant-upload", receivedBytes: 0 };
      }
      return { ok: true, slug: "demo" };
    });
    expect(await f.request("outsider", "/install", { ...install, version: "1.0.0" })).toMatchObject(
      { status: 200, body: { ok: true, slug: "demo", version: "1.0.0" } },
    );
    expect(f.registry.download.mock.calls).toEqual([["source", "demo", "1.0.0"]]);
    const binding = await f.store.getPersonalAgentBinding(f.outsider.id);
    expect(f.rpcCall).toHaveBeenCalledWith(
      "skills.install",
      expect.objectContaining({
        agentId: binding!.agentId,
        backendTarget: "platform_server",
        uploadId: "grant-upload",
        slug: "demo",
      }),
    );
    expect((await f.request("outsider", "/skills/source/demo")).status).toBe(404);
    expect((await f.request("outsider", "/install", install)).status).toBe(404);
    expect(f.registry.download).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "admin"])(
    "lets %s move metadata with immutable versions and explicit grants intact",
    async (actor) => {
      const f = await fixture();
      const result = await f.request(actor, "/skills/source/demo/edit", f.edit);
      expect(result).toEqual({
        status: 200,
        body: { ok: true, namespace: "target", slug: "demo" },
      });
      expect(f.registry.commits).toBe(1);
      expect((await f.request(actor, "/skills/source/demo")).status).toBe(404);
      const detail = await f.request(actor, "/skills/target/demo");
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        skill: {
          id: 10,
          namespace: "target",
          displayName: "Edited demo",
          summary: "Updated summary",
          revision: "revision-2",
        },
        versions: f.registry.versions,
        owner: { user: { id: f.owner.id } },
        access: [{ userId: f.outsider.id, grantedVersion: "1.0.0", inheritVersions: false }],
      });
      await expect(
        f.store.hasSkillHubAccess({
          namespace: "target",
          slug: "demo",
          userId: f.outsider.id,
          version: "1.0.0",
          now: Date.now(),
        }),
      ).resolves.toBe(true);
      await expect(
        f.store.hasSkillHubAccess({
          namespace: "target",
          slug: "demo",
          userId: f.outsider.id,
          version: "2.0.0",
          now: Date.now(),
        }),
      ).resolves.toBe(false);
    },
  );

  it("edits metadata in place and accepts an empty summary", async () => {
    const f = await fixture();
    expect(
      (
        await f.request("owner", "/skills/source/demo/edit", {
          ...f.edit,
          namespace: "source",
          summary: "",
          visibility: "PRIVATE",
        })
      ).status,
    ).toBe(200);
    expect((await f.request("owner", "/skills/source/demo")).body).toMatchObject({
      skill: { namespace: "source", summary: "", visibility: "PRIVATE" },
    });
  });

  it("denies a read grantee mutation and stale revisions before any remote edit", async () => {
    const f = await fixture();
    expect((await f.request("outsider", "/skills/source/demo/edit", f.edit)).status).toBe(403);
    expect(
      (
        await f.request("owner", "/skills/source/demo/edit", {
          ...f.edit,
          expectedOwnerUpdatedAt: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.request("owner", "/skills/source/demo/edit", {
          ...f.edit,
          expectedRegistryRevision: "stale",
        })
      ).status,
    ).toBe(409);
    expect(f.registry.editSkill).not.toHaveBeenCalled();
  });

  it.each([
    { operationId: "not-a-uuid" },
    { displayName: " " },
    { displayName: "x".repeat(201) },
    { summary: "x".repeat(4001) },
    { visibility: "UNKNOWN" },
    { expectedOwnerUpdatedAt: "1" },
    { expectedRegistryRevision: "" },
  ])("rejects invalid edit fields %j", async (invalid) => {
    const f = await fixture();
    expect(
      (await f.request("owner", "/skills/source/demo/edit", { ...f.edit, ...invalid })).status,
    ).toBe(400);
    expect(f.registry.editSkill).not.toHaveBeenCalled();
  });

  it("enforces destination publication and visibility ceilings server-side", async () => {
    const f = await fixture();
    expect(
      (await f.request("owner", "/skills/source/demo/edit", { ...f.edit, namespace: "denied" }))
        .status,
    ).toBe(403);
    expect(
      (await f.request("owner", "/skills/source/demo/edit", { ...f.edit, namespace: "limited" }))
        .status,
    ).toBe(403);
    expect(f.registry.editSkill).not.toHaveBeenCalled();
  });

  it("does not project bootstrap preview rights to a grantee of an unpublished shared version", async () => {
    const f = await fixture();
    f.registry.versions[1]!.status = "UPLOADED";
    expect(
      (await f.request("owner", "/skills/source/demo/edit", { ...f.edit, visibility: "PUBLIC" }))
        .status,
    ).toBe(200);
    const detail = await f.request("outsider", "/skills/target/demo");
    expect(detail).toMatchObject({
      status: 200,
      body: {
        versions: [
          expect.objectContaining({ version: "2.0.0", downloadAvailable: true }),
          expect.objectContaining({
            version: "1.0.0",
            status: "UPLOADED",
            downloadAvailable: false,
          }),
        ],
      },
    });
    const ownerDetail = await f.request("owner", "/skills/target/demo");
    expect(ownerDetail.body).toMatchObject({
      versions: [
        expect.anything(),
        expect.objectContaining({ version: "1.0.0", downloadAvailable: true }),
      ],
    });
    expect(
      (
        await f.request("outsider", "/install", {
          namespace: "target",
          slug: "demo",
          version: "1.0.0",
          destination: "platform_server",
        })
      ).status,
    ).toBe(409);
    expect(f.registry.download).not.toHaveBeenCalled();
    expect(f.rpcCall).not.toHaveBeenCalled();
  });

  it("keeps newly shared private releases gated until approval and preserves edits after recovery", async () => {
    const f = await fixture(true);
    f.registry.loseResponse();
    const edit = { ...f.edit, visibility: "PUBLIC" };
    expect((await f.request("owner", "/skills/source/demo/edit", edit)).status).toBe(503);
    f.registry.resume();
    await f.service.processGovernanceQueue();
    expect((await f.request("owner", "/skills/source/demo/edit", edit)).status).toBe(200);
    const prepared = await f.store.listDueSkillHubGovernanceJobs(Date.now() + 120_000, 10);
    expect(prepared.map((job) => job.version).toSorted()).toEqual(["1.0.0", "2.0.0"]);
    expect((await f.request("viewer", "/skills/target/demo")).status).toBe(404);
    expect(
      (
        await f.request("viewer", "/install", {
          namespace: "target",
          slug: "demo",
          version: "2.0.0",
          destination: "platform_server",
        })
      ).status,
    ).toBe(404);
    f.registry.passScans();
    for (const job of prepared) {
      await f.store.updateSkillHubGovernanceJob({
        ...job,
        nextAttemptAt: 1,
        updatedAt: Date.now(),
      });
    }
    await f.service.processGovernanceQueue();
    expect((await f.request("viewer", "/skills/target/demo")).body).toMatchObject({
      skill: { displayName: "Edited demo", summary: "Updated summary", visibility: "PUBLIC" },
      versions: [
        expect.objectContaining({ status: "PUBLISHED" }),
        expect.objectContaining({ status: "PUBLISHED" }),
      ],
    });
    expect(f.registry.commits).toBe(1);
  });

  it("reserves both coordinates after a lost commit reply and recovers with the original operation ID", async () => {
    const f = await fixture();
    f.registry.loseResponse();
    const uncertain = await f.request("owner", "/skills/source/demo/edit", f.edit);
    expect(uncertain).toMatchObject({
      status: 503,
      body: { details: { code: "skill-hub-edit-pending" } },
    });
    expect(f.registry.commits).toBe(1);
    expect((await f.request("owner", "/skills/target/demo")).status).toBe(404);
    expect(
      (
        await f.request("owner", "/install", {
          namespace: "target",
          slug: "demo",
          version: "1.0.0",
          destination: "platform_server",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.request("owner", "/publish", {
          namespace: "source",
          skill: "demo",
          version: "3.0.0",
          visibility: "PRIVATE",
        })
      ).status,
    ).toBe(409);
    expect(f.registry.download).not.toHaveBeenCalled();
    expect(f.registry.publish).not.toHaveBeenCalled();
    expect(f.rpcCall).not.toHaveBeenCalled();
    f.registry.resume();
    await f.service.processGovernanceQueue();
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(200);
    expect(f.registry.commits).toBe(1);
    expect((await f.request("owner", "/skills/target/demo")).status).toBe(200);
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "completed",
    });
  });

  it("recovers after local finalization fails and the control process restarts", async () => {
    const f = await fixture();
    const completion = vi
      .spyOn(f.store, "completeSkillHubEdit")
      .mockRejectedValueOnce(new Error("simulated SQLite interruption"));
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
    completion.mockRestore();
    f.restart();
    await f.service.processGovernanceQueue();
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(200);
    expect(f.registry.commits).toBe(1);
    await expect(f.store.getSkillHubOwnership("target", "demo")).resolves.toMatchObject({
      ownerUserId: f.owner.id,
    });
  });

  it("cancels a definitive registry conflict and permits a fresh edit", async () => {
    const f = await fixture();
    f.registry.reject();
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(409);
    await expect(f.store.getSkillHubPendingEdit("source", "demo")).resolves.toBeNull();
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "cancelled",
    });
    expect(
      (
        await f.request("owner", "/skills/source/demo/edit", {
          ...f.edit,
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(200);
  });

  it("releases a sharing request with no eligible release and gives an actionable Private publication outcome", async () => {
    const f = await fixture(true);
    f.registry.reject(422);
    const rejected = await f.request("owner", "/skills/source/demo/edit", {
      ...f.edit,
      visibility: "PUBLIC",
    });
    expect(rejected).toMatchObject({
      status: 422,
      body: { error: "Publish a new Private version before sharing this skill." },
    });
    expect(JSON.stringify(rejected.body)).not.toContain("Registry internal rejection details");
    await expect(f.store.getSkillHubPendingEdit("source", "demo")).resolves.toBeNull();
    await expect(f.store.getSkillHubPendingEdit("target", "demo")).resolves.toBeNull();
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "cancelled",
    });
    expect(f.registry.commits).toBe(0);
    expect(
      (
        await f.request("owner", "/skills/source/demo/edit", {
          ...f.edit,
          operationId: randomUUID(),
          namespace: "source",
          visibility: "PRIVATE",
        })
      ).status,
    ).toBe(200);
  });

  it("reopens prepared scan rounds while current unsafe findings still block automatic approval", async () => {
    const f = await fixture(true);
    for (const [version, state] of [
      ["1.0.0", "blocked"],
      ["2.0.0", "failed"],
    ] as const) {
      await f.store.enqueueSkillHubGovernanceJob({
        namespace: "source",
        slug: "demo",
        version,
        ownerUserId: f.owner.id,
        createdAt: 1,
      });
      await f.store.updateSkillHubGovernanceJob({
        namespace: "source",
        slug: "demo",
        version,
        state,
        attempts: 20,
        nextAttemptAt: 1,
        lastError: state === "blocked" ? "scan-unsafe" : "governance-unavailable",
        updatedAt: 1,
      });
    }
    expect(
      (await f.request("owner", "/skills/source/demo/edit", { ...f.edit, visibility: "PUBLIC" }))
        .status,
    ).toBe(200);
    const reopened = await f.store.listDueSkillHubGovernanceJobs(Date.now() + 1000, 10);
    expect(reopened).toHaveLength(2);
    expect(reopened.every((job) => job.attempts === 0 && job.state === "pending")).toBe(true);
    f.registry.passScans();
    const audits = vi.spyOn(f.registry.adapter, "listSecurityAudits").mockResolvedValue([
      {
        scannerType: "SKILL_SCANNER",
        verdict: "DANGEROUS",
        isSafe: false,
        scannedAt: "2026-10-16T00:00:00Z",
      },
    ]);
    const approve = vi.spyOn(f.registry.governance, "approvePendingReview");
    await f.service.processGovernanceQueue();
    expect(approve).not.toHaveBeenCalled();
    await expect(f.store.listDueSkillHubGovernanceJobs(Date.now() + 1000, 10)).resolves.toEqual([]);
    expect(f.registry.metadata.effectiveVisibility).toBe("PRIVATE");

    audits.mockRestore();
    const current = await f.store.getSkillHubOwnership("target", "demo");
    expect(
      (
        await f.request("owner", "/skills/target/demo/edit", {
          ...f.edit,
          operationId: randomUUID(),
          expectedOwnerUpdatedAt: current!.updatedAt,
          expectedRegistryRevision: f.registry.metadata.revision,
          visibility: "PUBLIC",
        })
      ).status,
    ).toBe(200);
    for (const job of await f.store.listDueSkillHubGovernanceJobs(Date.now() + 1000, 10)) {
      await f.store.updateSkillHubGovernanceJob({ ...job, nextAttemptAt: 1 });
    }
    await f.service.processGovernanceQueue();
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls.every(([request]) => request.requireSafeScan === true)).toBe(true);
    expect(f.registry.metadata.effectiveVisibility).toBe("PUBLIC");
  });

  it("keeps failed edit recovery on the worker cadence and does not reschedule a success hot loop", async () => {
    const f = await fixture();
    const listPending = vi.spyOn(f.store, "listPendingSkillHubEdits");
    vi.useFakeTimers();
    try {
      f.registry.loseResponse();
      await expect(
        f.service.editPublishedSkill(f.owner, "source", "demo", f.edit),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(f.registry.editSkill).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(listPending).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.registry.editSkill).toHaveBeenCalledTimes(2);
      expect(listPending).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.registry.editSkill).toHaveBeenCalledTimes(2);
      expect(listPending).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.registry.editSkill).toHaveBeenCalledTimes(3);
      expect(listPending).toHaveBeenCalledTimes(2);

      f.registry.resume();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.registry.editSkill).toHaveBeenCalledTimes(4);
      expect(listPending).toHaveBeenCalledTimes(3);
      await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
        state: "completed",
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(listPending).toHaveBeenCalledTimes(3);
    } finally {
      f.service.close();
      vi.useRealTimers();
    }
  });

  it("rotates persistent failed recovery attempts so later edits complete after restart", async () => {
    const f = await fixture();
    const binding = (await f.store.getSkillHubNamespaceBinding("source"))!;
    const failedIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const slug = `blocked-${index}`;
      const ownership = await f.store.recordSkillHubPublication({
        namespace: "source",
        slug,
        ownerUserId: f.owner.id,
        expectedOwnerUserId: null,
        expectedOwnerUpdatedAt: null,
        expectedBindingUpdatedAt: binding.updatedAt,
        visibility: "PRIVATE",
        version: "1.0.0",
        changedAt: 1,
      });
      const id = randomUUID();
      failedIds.push(id);
      await f.store.beginSkillHubEdit({
        id,
        namespace: "source",
        targetNamespace: "source",
        slug,
        skillId: 100 + index,
        registryRevision: "persistently-unavailable",
        displayName: slug,
        summary: "",
        visibility: "PRIVATE",
        actorUserId: f.owner.id,
        expectedOwnerUpdatedAt: ownership.updatedAt,
        expectedSourceBindingUpdatedAt: binding.updatedAt,
        expectedTargetBindingUpdatedAt: binding.updatedAt,
        changedAt: 1,
      });
    }
    const editSkill = f.registry.editSkill.getMockImplementation()!;
    f.registry.editSkill.mockImplementation(async (request) => {
      if (request.slug.startsWith("blocked-")) {
        throw new SkillHubGovernanceError("Persistently unavailable coordinate");
      }
      return await editSkill(request);
    });
    f.registry.loseResponse();
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
    f.registry.resume();
    await f.service.processGovernanceQueue();
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "pending",
    });
    f.restart();
    await f.service.processGovernanceQueue();
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "completed",
    });
    await expect(f.store.getSkillHubOwnership("target", "demo")).resolves.toMatchObject({
      ownerUserId: f.owner.id,
    });
    const remaining = await f.store.listPendingSkillHubEdits();
    expect(remaining.map((intent) => intent.id).toSorted()).toEqual(failedIds.toSorted());
    expect(
      remaining.every((intent) => intent.registryRevision === "persistently-unavailable"),
    ).toBe(true);
    for (const intent of remaining) {
      await expect(f.store.getSkillHubPendingEdit(intent.namespace, intent.slug)).resolves.toEqual(
        intent,
      );
    }
    expect(f.registry.commits).toBe(1);
  });

  it("reconciles policy drift to canonical and local Private state before returning success", async () => {
    const f = await fixture();
    f.registry.beforeEdit(async () => {
      await f.store.removeManagedScopeMembership({
        actorUserId: f.admin.id,
        scopeId: f.scopes.get("target")!,
        userId: f.owner.id,
        reason: "membership revoked while registry update was in flight",
        changedAt: Date.now() + 200,
      });
    });
    expect(await f.request("owner", "/skills/source/demo/edit", f.edit)).toMatchObject({
      status: 200,
      body: { ownershipReviewRequired: true },
    });
    await expect(f.store.getSkillHubOwnership("target", "demo")).resolves.toMatchObject({
      ownerUserId: null,
      visibility: "PRIVATE",
    });
    expect(f.registry.metadata).toMatchObject({
      visibility: "PRIVATE",
      effectiveVisibility: "PRIVATE",
    });
    expect(f.registry.commits).toBe(2);
    expect(f.registry.editSkill.mock.calls[1]![0]).toMatchObject({
      namespace: "target",
      targetNamespace: "target",
      visibility: "PRIVATE",
    });
    expect((await f.request("viewer", "/skills/target/demo")).status).toBe(404);

    await expect(f.store.listSkillHubNotifications(f.admin.id, 20)).resolves.toContainEqual(
      expect.objectContaining({ kind: "owner-unassigned", namespace: "target", slug: "demo" }),
    );
  });
  async function revokeDestination(f: Awaited<ReturnType<typeof fixture>>) {
    await f.store.removeManagedScopeMembership({
      actorUserId: f.admin.id,
      scopeId: f.scopes.get("target")!,
      userId: f.owner.id,
      reason: "membership revoked during committed registry edit",
      changedAt: Date.now() + 200,
    });
  }

  async function seedFinalGovernanceAttempt(f: Awaited<ReturnType<typeof fixture>>) {
    await f.store.enqueueSkillHubGovernanceJob({
      namespace: "source",
      slug: "demo",
      version: "2.0.0",
      ownerUserId: f.owner.id,
      createdAt: 1,
    });
    await f.store.updateSkillHubGovernanceJob({
      namespace: "source",
      slug: "demo",
      version: "2.0.0",
      state: "pending",
      attempts: 19,
      nextAttemptAt: 1,
      lastError: "scan-pending",
      updatedAt: 1,
    });
    return (await f.store.listDueSkillHubGovernanceJobs(Date.now(), 10))[0]!;
  }

  function readSourceGovernanceJob(f: Awaited<ReturnType<typeof fixture>>) {
    const database = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      return database
        .prepare(
          "SELECT state, attempts, next_attempt_at, last_error FROM skill_hub_governance_jobs WHERE namespace = ? AND slug = ? AND version = ?",
        )
        .get("source", "demo", "2.0.0");
    } finally {
      database.close();
    }
  }

  it("preserves the governance retry budget while committed privacy recovery reserves the source", async () => {
    const f = await fixture();
    const job = await seedFinalGovernanceAttempt(f);
    f.registry.pausePrivacy();
    f.registry.beforeEdit(() => revokeDestination(f));
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
    expect(f.registry.metadata.namespace).toBe("target");
    await expect(f.store.getSkillHubPendingEdit("source", "demo")).resolves.toMatchObject({
      privacy: { visibility: "PRIVATE" },
    });
    const getSkill = vi.spyOn(f.registry.adapter, "getSkill");

    await f.service.processGovernanceQueue();

    expect(getSkill).not.toHaveBeenCalled();
    await expect(f.store.listDueSkillHubGovernanceJobs(Date.now(), 10)).resolves.toEqual([]);
    expect(readSourceGovernanceJob(f)).toEqual({
      state: "pending",
      attempts: job.attempts,
      next_attempt_at: job.nextAttemptAt,
      last_error: job.lastError,
    });
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "pending",
      privacy: { visibility: "PRIVATE" },
    });
  });

  it("does not exhaust governance retries when an in-flight source read loses a race to privacy recovery", async () => {
    const f = await fixture();
    const job = await seedFinalGovernanceAttempt(f);
    let entered!: () => void;
    let release!: () => void;
    const readEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const readReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getSkill = f.registry.adapter.getSkill.bind(f.registry.adapter);
    vi.spyOn(f.registry.adapter, "getSkill").mockImplementationOnce(async (namespace, slug) => {
      entered();
      await readReleased;
      return getSkill(namespace, slug);
    });
    const processing = f.service.processGovernanceQueue();
    try {
      await readEntered;
      f.registry.pausePrivacy();
      f.registry.beforeEdit(() => revokeDestination(f));
      expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
      expect(f.registry.metadata.namespace).toBe("target");
      await expect(f.store.getSkillHubPendingEdit("source", "demo")).resolves.toMatchObject({
        privacy: { visibility: "PRIVATE" },
      });
    } finally {
      release();
      await processing;
    }

    await expect(f.store.listDueSkillHubGovernanceJobs(Date.now(), 10)).resolves.toEqual([]);
    expect(readSourceGovernanceJob(f)).toEqual({
      state: "pending",
      attempts: job.attempts,
      next_attempt_at: job.nextAttemptAt,
      last_error: job.lastError,
    });
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "pending",
      privacy: { visibility: "PRIVATE" },
    });
  });

  it("keeps both coordinates reserved until canonical privacy survives outage, restart, and restored policy", async () => {
    const f = await fixture();
    f.registry.pausePrivacy();
    f.registry.beforeEdit(() => revokeDestination(f));
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
    expect(f.registry.metadata.effectiveVisibility).toBe("NAMESPACE_ONLY");
    const pending = await f.store.getSkillHubEdit(f.edit.operationId);
    expect(pending).toMatchObject({ state: "pending", privacy: { visibility: "PRIVATE" } });
    expect((await f.request("viewer", "/skills/target/demo")).status).toBe(404);
    expect((await f.request("admin", "/skills/source/demo")).status).toBe(404);
    await expect(f.store.getSkillHubOwnership("target", "demo")).resolves.toBeNull();
    await f.store.setManagedScopeMembership({
      actorUserId: f.admin.id,
      scopeId: f.scopes.get("target")!,
      userId: f.owner.id,
      role: "member",
      reason: "policy restored while durable privacy remained pending",
      changedAt: Date.now() + 300,
    });
    f.restart();
    f.registry.resume();
    await f.service.processGovernanceQueue();
    expect(f.registry.metadata).toMatchObject({
      visibility: "PRIVATE",
      effectiveVisibility: "PRIVATE",
    });
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "completed",
      privacy: pending!.privacy,
    });
    await expect(f.store.getSkillHubOwnership("target", "demo")).resolves.toMatchObject({
      ownerUserId: null,
      visibility: "PRIVATE",
    });
    expect(
      f.registry.editSkill.mock.calls.filter(([edit]) => edit.operationId === f.edit.operationId),
    ).toHaveLength(1);
  });

  it("replays a lost PRIVATE compensation receipt with the same UUID and body after restart", async () => {
    const f = await fixture();
    f.registry.beforeEdit(() => revokeDestination(f));
    f.registry.losePrivacyResponse();
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
    expect(f.registry.metadata).toMatchObject({
      visibility: "PRIVATE",
      effectiveVisibility: "PRIVATE",
    });
    const pending = await f.store.getSkillHubEdit(f.edit.operationId);
    expect(pending?.privacy).toBeDefined();
    f.restart();
    f.registry.resume();
    await f.service.processGovernanceQueue();
    const privacyCalls = f.registry.editSkill.mock.calls.filter(
      ([edit]) => edit.operationId === pending!.privacy!.operationId,
    );
    expect(privacyCalls).toHaveLength(2);
    expect(privacyCalls[0]![0]).toEqual(privacyCalls[1]![0]);
    expect(f.registry.commits).toBe(2);
    await expect(f.store.getSkillHubOwnership("target", "demo")).resolves.toMatchObject({
      ownerUserId: null,
      visibility: "PRIVATE",
    });
  });

  it("refreshes a definitively rejected privacy CAS as a persisted new attempt", async () => {
    const f = await fixture();
    f.registry.beforeEdit(() => revokeDestination(f));
    f.registry.conflictPrivacy();
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
    const attempted = f.registry.editSkill.mock.calls[1]![0];
    const pending = await f.store.getSkillHubEdit(f.edit.operationId);
    expect(pending?.privacy?.operationId).not.toBe(attempted.operationId);
    expect(pending?.privacy?.expectedRevision).toBe("revision-2-native-approval");
    f.restart();
    await f.service.processGovernanceQueue();
    expect(f.registry.editSkill.mock.calls[2]![0]).toEqual(pending!.privacy);
    expect(f.registry.metadata).toMatchObject({
      visibility: "PRIVATE",
      effectiveVisibility: "PRIVATE",
    });
    await expect(f.store.getSkillHubEdit(f.edit.operationId)).resolves.toMatchObject({
      state: "completed",
    });
  });

  it("recovers an original lost reply followed by policy revocation before compensating", async () => {
    const f = await fixture();
    f.registry.loseResponse();
    expect((await f.request("owner", "/skills/source/demo/edit", f.edit)).status).toBe(503);
    await revokeDestination(f);
    f.restart();
    f.registry.resume();
    await f.service.processGovernanceQueue();
    expect(f.registry.commits).toBe(2);
    expect(f.registry.metadata).toMatchObject({
      visibility: "PRIVATE",
      effectiveVisibility: "PRIVATE",
    });
    await expect(f.store.getSkillHubOwnership("target", "demo")).resolves.toMatchObject({
      ownerUserId: null,
      visibility: "PRIVATE",
    });
  });
});
