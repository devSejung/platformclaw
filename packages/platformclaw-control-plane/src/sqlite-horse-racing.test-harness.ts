import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect } from "vitest";
import type { EnterprisePrincipal } from "./contracts.js";
import type { HorseBetRequest, RacingHorse } from "./horse-racing-contracts.js";
import { drawHorseFinishOrder } from "./horse-racing-engine.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

export const START = Date.parse("2026-10-15T11:00:00+09:00");
export const OPEN = START - 10 * 60_000;
const stores = new Set<SqliteControlPlaneStore>();
const directories: string[] = [];

export function createStore(databasePath: string) {
  const store = new SqliteControlPlaneStore({
    databasePath,
    initialAdminAccountIds: ["alice"],
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
  });
  stores.add(store);
  return store;
}

export function closeStore(store: SqliteControlPlaneStore) {
  stores.delete(store);
  store.close();
}

function principal(accountId: string): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: accountId,
    accountId,
    employeeId: accountId,
    displayName: accountId,
  };
}

async function earnGold(store: SqliteControlPlaneStore, userId: string, hits = 20) {
  for (let index = 0; index < hits; index++) {
    await store.rewardBaseballPlateAppearance({
      userId,
      requestId: `earned-hit-${index}`,
      outcome: "hit",
      distanceM: 80,
    });
  }
}

export async function setup(hits = 400) {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-racing-"));
  directories.push(directory);
  const databasePath = join(directory, "control.sqlite");
  const first = createStore(databasePath);
  const alice = (await first.upsertPrincipal(principal("alice"), OPEN)).user;
  const bob = (await first.upsertPrincipal(principal("bob"), OPEN)).user;
  await earnGold(first, alice.id, hits);
  await earnGold(first, bob.id, hits);
  const second = createStore(databasePath);
  const snapshot = first.racing.snapshot(alice.id, OPEN);
  const race = snapshot.race!;
  expect(race).toMatchObject({ startsAt: START, status: "betting" });
  return { databasePath, first, second, alice, bob, race };
}

export function inspect<T>(databasePath: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath);
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

export function finishOrder(databasePath: string, raceId: string): string[] {
  // Read the server's private state only in the test, so assertions do not depend on lucky random results.
  return inspect(databasePath, (db) => {
    const row = db
      .prepare("SELECT horses_json, seed FROM horse_races WHERE id = ?")
      .get(raceId) as {
      horses_json: string;
      seed: string;
    };
    return drawHorseFinishOrder(JSON.parse(row.horses_json) as RacingHorse[], row.seed);
  });
}

export function bet(
  raceId: string,
  requestId: string,
  amount: number,
  selection: string[],
  market: HorseBetRequest["market"] = "win",
): HorseBetRequest {
  return { raceId, requestId, amount, selection, market };
}

afterEach(() => {
  for (const store of stores) {
    store.close();
  }
  stores.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
