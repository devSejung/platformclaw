import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

// Core-reserved metadata; opt-in queues keep their other metadata fields intact.
const ADMISSION_PATH = "$.__openclawIngress.sequence";
export const ingressAdmissionSequenceSql = sql<number>`case
  when json_valid(metadata_json) then case
    when json_type(metadata_json, ${ADMISSION_PATH}) in ('integer', 'real')
      and json_extract(metadata_json, ${ADMISSION_PATH}) between 1 and ${Number.MAX_SAFE_INTEGER}
      and json_extract(metadata_json, ${ADMISSION_PATH}) = cast(json_extract(metadata_json, ${ADMISSION_PATH}) as integer)
    then json_extract(metadata_json, ${ADMISSION_PATH}) else 0 end
  else 0 end`;
export const ingressAdmissionLegacyTimeSql = sql<number>`case
  when ${ingressAdmissionSequenceSql} = 0 then received_at else 0 end`;

export function readIngressAdmissionAheadCount(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const host = (metadata as { __openclawIngress?: unknown })["__openclawIngress"];
  if (!host || typeof host !== "object" || Array.isArray(host)) {
    return undefined;
  }
  const { sequence, aheadCount } = host as { sequence?: unknown; aheadCount?: unknown };
  return typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    typeof aheadCount === "number" &&
    Number.isSafeInteger(aheadCount) &&
    aheadCount >= 0
    ? aheadCount
    : undefined;
}

/** Preserve a legacy scalar/array metadata value while storing host order separately. */
export function readIngressUserMetadata(metadata: unknown): unknown {
  if (readIngressAdmissionAheadCount(metadata) !== undefined) {
    const host = (metadata as { __openclawIngress: Record<string, unknown> })["__openclawIngress"];
    if (Object.hasOwn(host, "legacyMetadata")) {
      return host.legacyMetadata;
    }
  }
  return metadata;
}

/** Called inside the enqueue/resubmit transaction, before inserting the new tail. */
export function prepareIngressAdmission(params: {
  db: DatabaseSync;
  queueName: string;
  eventId: string;
  laneKey: string | undefined;
  metadata: unknown;
  activeEventIds?: Iterable<string>;
}): { metadataJson: string; aheadCount: number } {
  const { db, queueName } = params;
  const objectMetadata =
    params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
      ? (params.metadata as Record<string, unknown>)
      : undefined;
  const kysely = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
  const maximum =
    executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("channel_ingress_events")
        .select(sql<number>`coalesce(max(${ingressAdmissionSequenceSql}), 0)`.as("sequence"))
        .where("queue_name", "=", queueName)
        .where("status", "in", ["pending", "claimed", "failed"]),
    ).rows[0]?.sequence ?? 0;
  if (maximum >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Ingress admission sequence exhausted");
  }
  const ahead = new Set(params.activeEventIds);
  const rows = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("channel_ingress_events")
      .select("event_id")
      .where("queue_name", "=", queueName)
      .where("lane_key", params.laneKey === undefined ? "is" : "=", params.laneKey ?? null)
      .where("status", "in", ["pending", "claimed"]),
  ).rows;
  for (const row of rows) {
    ahead.add(row.event_id);
  }
  ahead.delete(params.eventId);
  return {
    metadataJson: JSON.stringify({
      ...objectMetadata,
      __openclawIngress: {
        sequence: maximum + 1,
        aheadCount: ahead.size,
        ...(params.metadata !== undefined && !objectMetadata
          ? { legacyMetadata: params.metadata }
          : {}),
      },
    }),
    aheadCount: ahead.size,
  };
}
