import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BaseballAtBatStore } from "./baseball-at-bat-store.js";
import { BaseballGameError, getBaseballBatDefinition } from "./baseball-contracts.js";
import { resolveBaseballAtBatPower } from "./baseball-enhancement.js";
import {
  advanceBattedBall,
  createBattedBall,
  createPitch,
  pitchPositionAt,
} from "./baseball-simulation.js";
import { runImmediateTransaction } from "./kysely-sync.js";

const databases: DatabaseSync[] = [];

function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE platform_users (id TEXT PRIMARY KEY) STRICT;
    INSERT INTO platform_users (id) VALUES ('alice'), ('bob');
  `);
  const store = new BaseballAtBatStore(db);
  store.ensureSchema();
  const transaction = <T>(operation: () => T): T => runImmediateTransaction(db, operation);
  return { db, store, transaction };
}

function errorCode(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BaseballGameError);
    return (error as BaseballGameError).code;
  }
  throw new Error("Expected an at-bat error");
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

describe("BaseballAtBatStore", () => {
  it.each([-25, 0, 25])(
    "persists the enhancement rule snapshot and judges timing %ims with shared power",
    (timingDeltaMs) => {
      const { db, store, transaction } = setup();
      const snapshot = { enhancementLevel: 20, powerRuleVersion: "sweetspot-v1" as const };
      const issued = transaction(() =>
        store.issue("alice", "enhanced", "diamond", 1_000, snapshot),
      );
      expect(issued).toMatchObject(snapshot);
      const reopened = new BaseballAtBatStore(db);
      reopened.ensureSchema();
      expect(
        transaction(() =>
          reopened.issue("alice", "enhanced", "wood", 1_100, {
            enhancementLevel: 0,
            powerRuleVersion: "sweetspot-v1",
          }),
        ),
      ).toEqual(issued);
      const result = transaction(() => reopened.consume("alice", issued.id, timingDeltaMs, 2_000));
      const simulated = advanceBattedBall(
        createBattedBall({
          timingDeltaMs,
          batPower: resolveBaseballAtBatPower(issued, timingDeltaMs),
        }),
        30_000,
      ).result!;
      expect(result).toEqual(
        timingDeltaMs === 0
          ? { outcome: "home_run", distanceM: Math.round(simulated.distanceM) }
          : { outcome: "out" },
      );
      expect(simulated.kind).toBe(timingDeltaMs === 0 ? "HOME_RUN" : "OUT");
      if (timingDeltaMs !== 0) {
        const legacy = transaction(() => store.issue("bob", "legacy", "diamond", 1_000));
        expect(legacy).not.toHaveProperty("enhancementLevel");
        expect(
          transaction(() => store.consume("bob", legacy.id, timingDeltaMs, 2_000)).outcome,
        ).toBe("home_run");
      }
    },
  );

  it("prunes enhancement snapshots with their parent at-bats and rolls both back on an aborted issuance", () => {
    const { db, store, transaction } = setup();
    const snapshot = { enhancementLevel: 12, powerRuleVersion: "sweetspot-v1" as const };
    expect(() =>
      transaction(() => {
        store.issue("alice", "aborted", "titanium", 0, snapshot);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM baseball_at_bat_enhancement_snapshots").get(),
    ).toEqual({ count: 0 });
    transaction(() => store.issue("alice", "old-enhanced", "titanium", 0, snapshot));
    transaction(() => store.issue("alice", "new-legacy", "wood", 172_800_001));
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM baseball_at_bat_enhancement_snapshots").get(),
    ).toEqual({ count: 0 });
  });

  it.each([
    ["fastball", 0.1171875, 150],
    ["changeup", 0.3515625, 120],
    ["underhand", 0.5859375, 135],
    ["curve", 0.8203125, 110],
    ["knuckleball", 0.9765625, 105],
  ] as const)(
    "replays the issued %s and judges the same normalized contact time",
    (kind, sample, speedKph) => {
      const { db, store, transaction } = setup();
      const issued = transaction(() => store.issue("alice", "pitch-round", "platinum", 1_000));
      db.prepare("UPDATE baseball_at_bats SET pitch_sample = ? WHERE id = ?").run(
        sample,
        issued.id,
      );
      const replay = transaction(() => store.issue("alice", "pitch-round", "wood", 1_100));
      expect(replay.pitchSample).toBe(sample);
      expect(replay.batId).toBe("platinum");
      const pitch = createPitch(() => replay.pitchSample);
      expect(pitch.kind).toBe(kind);
      expect(pitchPositionAt(pitch, pitch.idealContactTimeMs)).toEqual({ x: 0, y: 1.05 });
      const swingElapsedMs = (18.44 / (speedKph / 3.6)) * 1_000;
      const timingDeltaMs = swingElapsedMs - pitch.idealContactTimeMs;
      expect(timingDeltaMs).toBeCloseTo(0, 10);
      const result = transaction(() => store.consume("alice", replay.id, timingDeltaMs, 10_000));
      const expected = advanceBattedBall(
        createBattedBall({ timingDeltaMs, batPower: 1.12 }),
        30_000,
      ).result!;
      expect(result).toEqual({ outcome: "home_run", distanceM: Math.round(expected.distanceM) });
    },
  );

  it("issues user-bound durable pitches, replays requests, and supersedes the previous live pitch", () => {
    const { db, store, transaction } = setup();
    const first = transaction(() => store.issue("alice", "round-1", "wood", 1_000));
    expect(first).toMatchObject({ batId: "wood", issuedAt: 1_000, expiresAt: 181_000 });
    expect(first.id).toMatch(/^[\da-f-]{36}$/);
    expect(first.pitchSample).toBeGreaterThanOrEqual(0);
    expect(first.pitchSample).toBeLessThan(1);
    expect(transaction(() => store.issue("alice", "round-1", "diamond", 1_100))).toEqual(first);
    expect(errorCode(() => transaction(() => store.issue("alice", "round-2", "wood", 1_699)))).toBe(
      "at_bat_rate_limited",
    );
    const second = transaction(() => store.issue("alice", "round-2", "diamond", 1_700));
    expect(second.id).not.toBe(first.id);
    expect(errorCode(() => transaction(() => store.consume("alice", first.id, 0, 2_000)))).toBe(
      "at_bat_consumed",
    );
    const reopened = new BaseballAtBatStore(db);
    reopened.ensureSchema();
    expect(transaction(() => reopened.issue("alice", "round-2", "wood", 2_000))).toEqual(second);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM baseball_at_bats WHERE consumed_at IS NULL").get(),
    ).toEqual({ count: 1 });
  });

  it("rejects fabricated IDs, another user's nonce, expiry, early rewards, and repeated consumption", () => {
    const { store, transaction } = setup();
    const pitch = transaction(() => store.issue("alice", "round-1", "wood", 1_000));
    expect(
      errorCode(() => transaction(() => store.consume("alice", "fake-home-run", 0, 2_000))),
    ).toBe("at_bat_unavailable");
    expect(errorCode(() => transaction(() => store.consume("bob", pitch.id, 0, 2_000)))).toBe(
      "at_bat_unavailable",
    );
    expect(errorCode(() => transaction(() => store.consume("alice", pitch.id, 0, 999)))).toBe(
      "at_bat_too_early",
    );
    expect(errorCode(() => transaction(() => store.consume("alice", pitch.id, 0, 1_299)))).toBe(
      "at_bat_too_early",
    );
    expect(transaction(() => store.consume("alice", pitch.id, null, 1_300))).toEqual({
      outcome: "miss",
    });
    expect(errorCode(() => transaction(() => store.consume("alice", pitch.id, 0, 1_301)))).toBe(
      "at_bat_consumed",
    );
    const next = transaction(() => store.issue("alice", "round-2", "wood", 2_000));
    expect(
      errorCode(() => transaction(() => store.consume("alice", next.id, 0, next.expiresAt))),
    ).toBe("at_bat_expired");
  });

  it("uses the issued bat snapshot and canonical physics rather than supplied result claims", () => {
    const { store, transaction } = setup();
    const wood = transaction(() => store.issue("alice", "wood-round", "wood", 1_000));
    const diamond = transaction(() => store.issue("bob", "diamond-round", "diamond", 1_000));
    const woodResult = transaction(() => store.consume("alice", wood.id, 0, 2_000));
    const diamondResult = transaction(() => store.consume("bob", diamond.id, 0, 2_000));
    for (const [pitch, result] of [
      [wood, woodResult],
      [diamond, diamondResult],
    ] as const) {
      const simulation = advanceBattedBall(
        createBattedBall({
          timingDeltaMs: 0,
          batPower: getBaseballBatDefinition(pitch.batId)!.exitVelocityMultiplier,
        }),
        30_000,
      );
      expect(result).toEqual({
        outcome: "home_run",
        distanceM: Math.round(simulation.result!.distanceM),
      });
    }
    expect(diamondResult.distanceM).toBeGreaterThan(woodResult.distanceM!);
    const miss = transaction(() => store.issue("alice", "miss-round", "wood", 3_000));
    expect(transaction(() => store.consume("alice", miss.id, 101, 4_000))).toEqual({
      outcome: "miss",
    });
  });

  it("does not consume the nonce for invalid timing or an aborted award transaction", () => {
    const { store, transaction } = setup();
    const pitch = transaction(() => store.issue("alice", "round-1", "wood", 1_000));
    for (const timing of [Number.NaN, Number.POSITIVE_INFINITY, 2_001, -2_001]) {
      expect(
        errorCode(() => transaction(() => store.consume("alice", pitch.id, timing, 2_000))),
      ).toBe("invalid_swing");
    }
    expect(() =>
      transaction(() => {
        store.consume("alice", pitch.id, 0, 2_000);
        throw new Error("award failed");
      }),
    ).toThrow("award failed");
    expect(transaction(() => store.consume("alice", pitch.id, 0, 2_000))).toMatchObject({
      outcome: "home_run",
    });
  });

  it("drains more than one expired cleanup batch without postponing the backlog", () => {
    const { db, store, transaction } = setup();
    const insert = db.prepare(
      "INSERT INTO baseball_at_bats (id,user_id,request_id,pitch_sample,bat_id,issued_at,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    transaction(() => {
      for (let index = 0; index < 1_005; index++) {
        insert.run(`old-${index}`, "alice", `old-${index}`, 0.25, "wood", 0, 1, 2);
      }
    });
    const now = 2 * 86_400_000;
    transaction(() => store.issue("alice", "batch-one", "wood", now));
    expect(
      db.prepare("SELECT count(*) AS count FROM baseball_at_bats WHERE expires_at = 1").get(),
    ).toEqual({ count: 5 });
    transaction(() => store.issue("bob", "batch-two", "wood", now));
    expect(
      db.prepare("SELECT count(*) AS count FROM baseball_at_bats WHERE expires_at = 1").get(),
    ).toEqual({ count: 0 });
  });

  it("keeps recent retries, prunes old pitch state, and leaves the SQLite version unchanged", () => {
    const { db, store, transaction } = setup();
    db.exec("PRAGMA user_version = 3");
    const old = transaction(() => store.issue("alice", "old-round", "wood", 0));
    const recent = transaction(() => store.issue("bob", "recent-round", "wood", 86_400_000));
    transaction(() => store.issue("alice", "new-round", "wood", 172_800_001));
    expect(errorCode(() => transaction(() => store.consume("alice", old.id, 0, 172_900_000)))).toBe(
      "at_bat_unavailable",
    );
    expect(transaction(() => store.issue("bob", "recent-round", "wood", 172_900_000))).toEqual(
      recent,
    );
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  });
});
