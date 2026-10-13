import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);
const options = { receivedAt: 7, laneKey: "room", admission: {} };
function queueAt(stateDir: string, accountId = "a", sequencedAdmission = false) {
  return createChannelIngressQueue<string>({
    channelId: "synthetic",
    accountId,
    stateDir,
    sequencedAdmission,
  });
}

describe("opt-in durable arrival ordering", () => {
  it("orders same-ms reverse IDs by commit and snapshots N=0,1,2", async () => {
    const stateDir = tempDirs.make("ingress-arrival-");
    const queue = queueAt(stateDir);
    const results = await Promise.all(["z", "m", "a"].map((id) => queue.enqueue(id, id, options)));
    expect(
      results.map((result) =>
        "admissionAheadCount" in result.record ? result.record.admissionAheadCount : undefined,
      ),
    ).toEqual([0, 1, 2]);
    expect((await queue.listPending({ orderBy: "received" })).map((row) => row.id)).toEqual([
      "a",
      "m",
      "z",
    ]);
    closeOpenClawStateDatabaseForTest();
    const restarted = queueAt(stateDir);
    for (const id of ["z", "m", "a"]) {
      const claim = await restarted.claimNext({ orderBy: "admission", scanLimit: 1 });
      expect(claim?.id).toBe(id);
      if (!claim) {
        throw new Error("Expected a claim");
      }
      await restarted.complete(claim);
    }
  });

  it("unions adopted owners, pending and claimed without duplicates or other lanes/accounts", async () => {
    const queue = queueAt(tempDirs.make("ingress-count-"));
    await queue.enqueue("active", "active", options);
    const active = await queue.claim("active");
    if (!active) {
      throw new Error("Expected an active claim");
    }
    await queue.complete(active);
    await queue.enqueue("claimed", "claimed", options);
    await queue.claim("claimed");
    await queue.enqueue("pending", "pending", options);
    await queue.enqueue("other", "other", { ...options, laneKey: "other" });
    await queue.enqueue("stop", "stop", { ...options, laneKey: "room:control" });
    const result = await queue.enqueue("new", "new", {
      ...options,
      admission: { activeEventIds: ["active", "claimed", "pending", "new"] },
    });
    expect(result.record).toMatchObject({ admissionAheadCount: 3 });
    expect(await queue.enqueue("new", "changed", options)).toMatchObject({
      duplicate: true,
      record: { payload: "new", admissionAheadCount: 3 },
    });
  });

  it("keeps a legacy backlog ahead and puts resubmitted work at the new tail", async () => {
    const stateDir = tempDirs.make("ingress-resubmit-");
    const queue = queueAt(stateDir);
    await queue.enqueue("legacy", "legacy", { receivedAt: 100, laneKey: "room" });
    await queue.enqueue("failed", "failed", options);
    const failed = await queue.claim("failed");
    if (!failed) {
      throw new Error("Expected a claim");
    }
    await queue.fail(failed, { reason: "synthetic" });
    await queue.enqueue("tail", "tail", options);
    expect(await queue.resubmit?.("failed", { resubmittedAt: 0 })).toMatchObject({
      kind: "resubmitted",
    });
    expect(
      (await queue.listPending({ orderBy: "admission", limit: "all" })).map((row) => row.id),
    ).toEqual(["legacy", "tail", "failed"]);
    expect(await queueAt(stateDir, "b").enqueue("new", "new", options)).toMatchObject({
      record: { admissionAheadCount: 0 },
    });
  });

  it.each([false, true])(
    "resubmits legacy failures using explicit queue policy %s",
    async (sequencedAdmission) => {
      const stateDir = tempDirs.make("ingress-legacy-failure-");
      const legacy = queueAt(stateDir);
      await legacy.enqueue("F", "retained request", {
        receivedAt: 1,
        laneKey: "room",
        metadata: "legacy value",
      });
      const failed = await legacy.claim("F");
      if (!failed) {
        throw new Error("Expected a legacy claim");
      }
      await legacy.fail(failed, { reason: "synthetic" });
      const queue = queueAt(stateDir, "a", sequencedAdmission);
      await queue.enqueue("B", "new request", options);
      expect(await queue.resubmit?.("F", { resubmittedAt: 0 })).toMatchObject({
        kind: "resubmitted",
      });
      closeOpenClawStateDatabaseForTest();
      const restarted = queueAt(stateDir, "a", sequencedAdmission);
      const rows = await restarted.listPending({ orderBy: "admission" });
      expect(rows.map((row) => row.id)).toEqual(sequencedAdmission ? ["B", "F"] : ["F", "B"]);
      const replay = rows.find((row) => row.id === "F");
      expect(replay?.payload).toBe("retained request");
      expect(replay?.metadata).toBe("legacy value");
      expect(replay?.admissionAheadCount).toBe(sequencedAdmission ? 1 : undefined);
    },
  );

  it.each([
    ["1.0", 2],
    [String(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER],
  ])("preserves integral JSON sequence %s through the safe-integer boundary", async (raw, next) => {
    const stateDir = tempDirs.make("ingress-sequence-boundary-");
    const queue = queueAt(stateDir);
    await queue.enqueue("prior", "prior", options);
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const kysely = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("channel_ingress_events")
        .set({ metadata_json: `{"__openclawIngress":{"sequence":${raw}}}` })
        .where("event_id", "=", "prior"),
    );
    const admitted = await queue.enqueue("next", "next", options);
    expect(admitted.record).toMatchObject({ metadata: { __openclawIngress: { sequence: next } } });
    expect((await queue.listPending({ orderBy: "admission" })).map((row) => row.id)).toEqual([
      "prior",
      "next",
    ]);
    if (next === Number.MAX_SAFE_INTEGER) {
      await expect(queue.enqueue("overflow", "overflow", options)).rejects.toThrow(
        "Ingress admission sequence exhausted",
      );
      expect((await queue.listPending({ orderBy: "admission" })).map((row) => row.id)).toEqual([
        "prior",
        "next",
      ]);
    }
  });

  it("uses the same guarded order before pagination and claim scan limits", async () => {
    const stateDir = tempDirs.make("ingress-cursor-");
    const queue = queueAt(stateDir);
    const malformed = [
      null,
      "null",
      "[]",
      "broken",
      "{}",
      ...[0, -1, 1.5, 9007199254740992, '"1"', "true", "null"].map(
        (value) => `{"__openclawIngress":{"sequence":${value}}}`,
      ),
      '{"__openclawIngress":{"sequence":1.01}}',
    ];
    const { db } = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const kysely = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
    const expected: string[] = [];
    for (let index = 0; index < 113; index++) {
      const id = `legacy-${String(index).padStart(3, "0")}`;
      expected.push(id);
      await queue.enqueue(id, id, { receivedAt: index, laneKey: "room" });
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("channel_ingress_events")
          .set({ metadata_json: malformed[index % malformed.length] })
          .where("event_id", "=", id),
      );
    }
    for (const id of ["z", "m", "a"]) {
      await queue.enqueue(id, id, options);
      expected.push(id);
    }
    expect(
      (await queue.listPending({ orderBy: "admission", limit: "all" })).map((row) => row.id),
    ).toEqual(expected);
    for (const id of expected) {
      const claim = await queue.claimNext({ orderBy: "admission", scanLimit: 1 });
      expect(claim?.id).toBe(id);
      if (!claim) {
        throw new Error("Expected a claim");
      }
      await queue.complete(claim);
    }
  });
});
