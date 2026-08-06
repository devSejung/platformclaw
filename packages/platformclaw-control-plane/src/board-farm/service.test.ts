import { describe, expect, it } from "vitest";
import type {
  BoardFarmLeaseAccess,
  BoardFarmPolicy,
  BoardFarmStateSnapshot,
  BoardFarmSubmission,
  BoardFarmSubmitRequest,
} from "./contracts.js";
import { BoardFarmError } from "./contracts.js";
import { InMemoryBoardFarmStateStore, type BoardFarmResourceConfig } from "./memory-store.js";
import {
  createDeterministicBoardFarmIdFactory,
  DeterministicMockBoardFarmAdapter,
} from "./mock-adapter.js";
import { parseBoardFarmStateSnapshot } from "./schema.js";
import { BoardFarmService } from "./service.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function request(
  actorUserId: string,
  idempotencyKey: string,
  overrides: Partial<BoardFarmSubmitRequest> = {},
): BoardFarmSubmitRequest {
  return {
    actorUserId,
    userAlias: actorUserId,
    jobId: `${idempotencyKey}-job`,
    correlationId: `${idempotencyKey}-correlation`,
    idempotencyKey,
    resourceRequirement: { profile: "arm-debug", capabilities: [] },
    build: {
      status: "succeeded",
      artifact: { id: "firmware-image", digest: DIGEST_A, locator: "artifact://firmware/image" },
      completedAt: 1,
    },
    ...overrides,
  };
}

function activeAccess(submission: BoardFarmSubmission): BoardFarmLeaseAccess {
  if (!submission.lease || !submission.accessToken) {
    throw new Error("expected an active lease submission");
  }
  return {
    actorUserId: submission.run.userId,
    leaseId: submission.lease.id,
    accessToken: submission.accessToken,
  };
}

function harness(
  options: {
    resources?: BoardFarmResourceConfig[];
    policy?: BoardFarmPolicy;
    adapter?: DeterministicMockBoardFarmAdapter;
    now?: number;
  } = {},
) {
  let now = options.now ?? 10;
  const store = new InMemoryBoardFarmStateStore(
    options.resources ?? [{ id: "board-alpha", profile: "arm-debug" }],
  );
  const adapter = options.adapter ?? new DeterministicMockBoardFarmAdapter();
  const service = new BoardFarmService({
    store,
    adapter,
    idFactory: createDeterministicBoardFarmIdFactory(),
    policy: options.policy,
    now: () => now,
  });
  return { adapter, service, setNow: (value: number) => (now = value), store };
}

function expectCode(error: unknown, code: BoardFarmError["code"]): boolean {
  expect(error).toBeInstanceOf(BoardFarmError);
  expect((error as BoardFarmError).code).toBe(code);
  return true;
}

function rawRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

async function completedSnapshot(): Promise<BoardFarmStateSnapshot> {
  const { service, store } = harness();
  const submission = service.submit(request("user-a", "snapshot-run"));
  await service.execute(activeAccess(submission));
  await service.release(activeAccess(submission));
  return store.snapshot();
}

describe("BoardFarmService lease ownership and fairness", () => {
  it("serializes concurrent users and promotes the FIFO queue", async () => {
    const { service, adapter } = harness();
    const [first, second, third] = await Promise.all([
      Promise.resolve().then(() => service.submit(request("user-a", "job-a"))),
      Promise.resolve().then(() => service.submit(request("user-b", "job-b"))),
      Promise.resolve().then(() => service.submit(request("user-c", "job-c"))),
    ]);

    expect(first.lease?.state).toBe("active");
    expect(second.lease?.state).toBe("queued");
    expect(third.lease?.state).toBe("queued");

    await service.release(activeAccess(first));
    const secondLease = service.getLease("user-b", second.lease!.id);
    expect(secondLease.state).toBe("active");
    const secondToken = service.claimLeaseAccess("user-b", secondLease.id);
    await service.release({
      actorUserId: "user-b",
      leaseId: secondLease.id,
      accessToken: secondToken,
    });

    expect(service.getLease("user-c", third.lease!.id).state).toBe("active");
    expect(adapter.completedEffects.filter((call) => call.phase === "cleanup")).toHaveLength(2);
  });

  it("denies cross-user reads and lease mutations without leaking token hashes", async () => {
    const { service, store } = harness();
    const submission = service.submit(request("user-a", "secure-job"));
    const access = activeAccess(submission);

    expect(() => service.getRun("user-b", submission.run.id)).toThrowError(
      expect.objectContaining({ code: "not_authorized" }),
    );
    expect(() => service.getLease("user-b", access.leaseId)).toThrowError(
      expect.objectContaining({ code: "not_authorized" }),
    );
    await expect(service.heartbeat({ ...access, actorUserId: "user-b" })).rejects.toSatisfy(
      (error: unknown) => expectCode(error, "not_authorized"),
    );
    await expect(
      service.cancel({
        actorUserId: "user-b",
        leaseId: access.leaseId,
        accessToken: access.accessToken,
      }),
    ).rejects.toSatisfy((error: unknown) => expectCode(error, "not_authorized"));

    expect(service.getLease("user-a", access.leaseId)).not.toHaveProperty("accessTokenHash");
    expect(JSON.stringify(service.listAuditEvents("user-a", submission.run.id))).not.toContain(
      access.accessToken,
    );
    expect(store.snapshot().leases[0]?.accessTokenHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("deduplicates equal submissions and rejects idempotency-key payload drift", () => {
    const { service, store } = harness();
    const first = service.submit(request("user-a", "stable-key"));
    const duplicate = service.submit(request("user-a", "stable-key"));

    expect(duplicate.created).toBe(false);
    expect(duplicate.run.id).toBe(first.run.id);
    expect(duplicate.lease?.id).toBe(first.lease?.id);
    expect(store.snapshot().runs).toHaveLength(1);
    expect(() =>
      service.submit(
        request("user-a", "stable-key", {
          build: {
            status: "succeeded",
            artifact: { id: "firmware-image", digest: DIGEST_B, locator: "artifact://other" },
            completedAt: 1,
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });

  it("selects by capability and enforces the per-user live lease quota", () => {
    const { service } = harness({
      resources: [
        { id: "board-basic", profile: "arm-debug", capabilities: ["debug"] },
        { id: "board-camera", profile: "arm-debug", capabilities: ["camera", "debug"] },
      ],
    });
    const camera = service.submit(
      request("user-a", "camera-job", {
        resourceRequirement: { profile: "arm-debug", capabilities: ["camera"] },
      }),
    );
    const basic = service.submit(request("user-b", "basic-job"));

    expect(camera.lease).toMatchObject({ state: "active", boardId: "board-camera" });
    expect(basic.lease).toMatchObject({ state: "active", boardId: "board-basic" });
    expect(() => service.submit(request("user-a", "second-live-job"))).toThrowError(
      expect.objectContaining({ code: "user_lease_quota_exceeded" }),
    );
  });
});

describe("BoardFarmService lease lifecycle", () => {
  it("tracks heartbeat and bounded renewal, then expires and reclaims a stale board", async () => {
    const policy = {
      leaseDurationMs: 100,
      heartbeatTimeoutMs: 40,
      maximumLeaseLifetimeMs: 250,
      maximumLeasesPerUser: 1,
    };
    const { service, setNow } = harness({ policy });
    const first = service.submit(request("user-a", "lease-a"));
    const second = service.submit(request("user-b", "lease-b"));
    const access = activeAccess(first);

    setNow(30);
    expect((await service.heartbeat(access)).lastHeartbeatAt).toBe(30);
    setNow(50);
    expect((await service.renew(access)).expiresAt).toBe(150);
    setNow(69);
    expect(await service.expireStale()).toEqual([]);
    setNow(70);
    expect((await service.expireStale())[0]?.state).toBe("expired");
    expect(service.getRun("user-a", first.run.id)).toMatchObject({
      status: "failed",
      failureCode: "lease_expired",
    });
    await expect(service.execute(access)).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "lease_access_unavailable"),
    );
    expect(() => service.claimLeaseAccess("user-a", access.leaseId)).toThrowError(
      expect.objectContaining({ code: "lease_access_unavailable" }),
    );
    expect(service.getLease("user-b", second.lease!.id).state).toBe("active");
  });

  it("cancels queued and active work and makes release idempotent", async () => {
    const { service, adapter } = harness();
    const active = service.submit(request("user-a", "active"));
    const queued = service.submit(request("user-b", "queued"));

    expect((await service.cancel({ actorUserId: "user-b", leaseId: queued.lease!.id })).state).toBe(
      "cancelled",
    );
    const access = activeAccess(active);
    expect((await service.release(access)).state).toBe("released");
    expect((await service.release(access)).state).toBe("released");
    expect(adapter.completedEffects.filter((call) => call.phase === "cleanup")).toHaveLength(1);

    const next = service.submit(request("user-c", "cancel-active"));
    expect((await service.cancel(activeAccess(next))).state).toBe("cancelled");
    expect(service.getRun("user-c", next.run.id).status).toBe("cancelled");
  });

  it("gates failed builds before queueing or touching hardware", () => {
    const { service, adapter, store } = harness();
    const submission = service.submit(
      request("user-a", "failed-build", {
        build: { status: "failed", failureCode: "compiler_failed", completedAt: 4 },
      }),
    );

    expect(submission).toMatchObject({ created: true, run: { status: "build_failed" } });
    expect(submission.lease).toBeUndefined();
    expect(adapter.calls).toEqual([]);
    expect(store.snapshot().resources[0]).toMatchObject({ state: "available" });
  });
});

describe("BoardFarmService workflow evidence and recovery", () => {
  it("preserves deployment, boot, failed validation, and cleanup evidence", async () => {
    const adapter = new DeterministicMockBoardFarmAdapter({ failures: { validate: "always" } });
    const { service } = harness({ adapter });
    const submission = service.submit(request("user-a", "validation-failure"));

    const run = await service.execute(activeAccess(submission));
    expect(run).toMatchObject({ status: "failed", failureCode: "mock_validate_failed" });
    expect(service.getLease("user-a", submission.lease!.id).state).toBe("released");
    expect(service.listEvidence("user-a", run.id)).toMatchObject([
      { phase: "deploy", status: "passed" },
      { phase: "boot", status: "passed" },
      { phase: "validate", status: "failed" },
      { phase: "cleanup", status: "passed" },
    ]);
    expect(service.listAuditEvents("user-a", run.id).map((event) => event.eventType)).toContain(
      "board_farm.workflow.validate.failed",
    );
  });

  it("quarantines cleanup failures and safely recovers them after restart", async () => {
    const adapter = new DeterministicMockBoardFarmAdapter({ failures: { cleanup: 1 } });
    const firstHarness = harness({ adapter });
    const first = firstHarness.service.submit(request("user-a", "cleanup-owner"));
    const queued = firstHarness.service.submit(request("user-b", "cleanup-waiter"));

    expect((await firstHarness.service.release(activeAccess(first))).state).toBe("cleanup_failed");
    expect(firstHarness.store.snapshot().resources[0]).toMatchObject({ state: "quarantined" });
    expect(firstHarness.service.getLease("user-b", queued.lease!.id).state).toBe("queued");

    const restartedStore = new InMemoryBoardFarmStateStore(firstHarness.store.snapshot());
    const restarted = new BoardFarmService({
      store: restartedStore,
      adapter,
      idFactory: createDeterministicBoardFarmIdFactory("restart", 1_000),
      now: () => 20,
    });
    const recovery = await restarted.recover();

    expect(recovery.cleanupLeaseIds).toContain(first.lease!.id);
    expect(restarted.getLease("user-a", first.lease!.id).state).toBe("released");
    expect(restarted.getLease("user-b", queued.lease!.id).state).toBe("active");
    expect(
      restarted.listEvidence("user-a", first.run.id).filter((item) => item.phase === "cleanup"),
    ).toMatchObject([{ status: "failed" }, { status: "passed" }]);
  });

  it("resumes an interrupted phase from durable state without duplicating successful effects", async () => {
    const firstHarness = harness();
    const submission = firstHarness.service.submit(request("user-a", "restart-run"));
    firstHarness.store.transaction((state) => {
      state.runs[0]!.status = "deploying";
    });
    const adapter = new DeterministicMockBoardFarmAdapter();
    const restarted = new BoardFarmService({
      store: new InMemoryBoardFarmStateStore(firstHarness.store.snapshot()),
      adapter,
      idFactory: createDeterministicBoardFarmIdFactory("restart", 1_000),
      now: () => 20,
    });

    expect((await restarted.recover()).resumedRunIds).toEqual([submission.run.id]);
    expect(restarted.getRun("user-a", submission.run.id).status).toBe("succeeded");
    expect(adapter.completedEffects.map((call) => call.phase)).toEqual([
      "deploy",
      "boot",
      "validate",
    ]);
  });

  it("single-flights execution and waits for an in-flight phase before cancellation cleanup", async () => {
    let unblock!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const adapter = new DeterministicMockBoardFarmAdapter({
      beforeOperation: async (call) => {
        if (call.phase === "deploy") {
          started();
          await gate;
        }
      },
    });
    const { service } = harness({ adapter });
    const submission = service.submit(request("user-a", "concurrent-execute"));
    const access = activeAccess(submission);
    const firstExecution = service.execute(access);
    const duplicateExecution = service.execute(access);
    await startedPromise;
    const cancellation = service.cancel(access);
    unblock();

    await Promise.all([firstExecution, duplicateExecution, cancellation]);
    expect(service.getRun("user-a", submission.run.id).status).toBe("cancelled");
    expect(adapter.calls.filter((call) => call.phase === "deploy")).toHaveLength(1);
    expect(adapter.calls.filter((call) => call.phase === "cleanup")).toHaveLength(1);
    expect(service.listEvidence("user-a", submission.run.id).map((item) => item.phase)).toEqual([
      "deploy",
      "cleanup",
    ]);
  });

  it("rejects malformed restart snapshots at the typed schema boundary", () => {
    const { store } = harness();
    const snapshot = store.snapshot() as unknown as { schemaVersion: number };
    snapshot.schemaVersion = 2;
    expect(() => parseBoardFarmStateSnapshot(snapshot)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });

  it("accepts and clones a complete canonical snapshot", async () => {
    const snapshot = await completedSnapshot();
    const parsed = parseBoardFarmStateSnapshot(snapshot);

    expect(parsed).toEqual(snapshot);
    expect(parsed).not.toBe(snapshot);
  });

  it.each<[string, (snapshot: BoardFarmStateSnapshot) => void]>([
    ["negative run timestamp", (snapshot) => (snapshot.runs[0]!.createdAt = -1)],
    ["missing run timestamp", (snapshot) => delete rawRecord(snapshot.runs[0]!).updatedAt],
    ["negative lease timestamp", (snapshot) => (snapshot.leases[0]!.requestedAt = -1)],
    ["missing lease timestamp", (snapshot) => delete rawRecord(snapshot.leases[0]!).expiresAt],
    [
      "malformed build digest",
      (snapshot) => {
        const build = rawRecord(snapshot.runs[0]!.build);
        rawRecord(build.artifact as object).digest = "not-a-digest";
      },
    ],
    [
      "malformed build status",
      (snapshot) => {
        rawRecord(snapshot.runs[0]!.build).status = "unknown";
      },
    ],
    ["blank run idempotency key", (snapshot) => (snapshot.runs[0]!.idempotencyKey = "")],
    [
      "malformed idempotency fingerprint",
      (snapshot) => (snapshot.idempotencyRecords[0]!.requestFingerprint = "invalid"),
    ],
    ["negative evidence timestamp", (snapshot) => (snapshot.evidence[0]!.recordedAt = -1)],
    [
      "missing evidence timestamp",
      (snapshot) => delete rawRecord(snapshot.evidence[0]!).recordedAt,
    ],
    ["blank evidence locator", (snapshot) => (snapshot.evidence[0]!.locator = "")],
    [
      "invalid evidence status",
      (snapshot) => {
        rawRecord(snapshot.evidence[0]!).status = "unknown";
      },
    ],
    ["invalid evidence kind", (snapshot) => (snapshot.evidence[0]!.kind = "invalid kind")],
    ["negative audit timestamp", (snapshot) => (snapshot.auditEvents[0]!.createdAt = -1)],
    ["missing audit timestamp", (snapshot) => delete rawRecord(snapshot.auditEvents[0]!).createdAt],
    [
      "inconsistent cleanup result",
      (snapshot) => {
        snapshot.leases[0]!.cleanupResult = {
          status: "failed",
          failureCode: "cleanup_failed",
          completedAt: snapshot.leases[0]!.terminalAt!,
        };
      },
    ],
  ])("rejects a snapshot with %s", async (_name, mutate) => {
    const snapshot = await completedSnapshot();
    mutate(snapshot);

    expect(() => parseBoardFarmStateSnapshot(snapshot)).toThrowError(
      expect.objectContaining({ code: "invalid_state" }),
    );
  });
});
