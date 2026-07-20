import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Compilable, Kysely, QueryResult } from "kysely";
import { InsertQueryNode, Kysely as KyselyInstance, SqliteDialect } from "kysely";

const compileOnlyDialect = new SqliteDialect({
  database: async () => {
    throw new Error("PlatformClaw uses Kysely for compilation and node:sqlite for sync execution");
  },
});

export function createSyncKysely<Database>(): Kysely<Database> {
  return new KyselyInstance<Database>({ dialect: compileOnlyDialect });
}

export function executeSync<Row>(db: DatabaseSync, query: Compilable<Row>): QueryResult<Row> {
  const compiled = query.compile();
  const statement = db.prepare(compiled.sql);
  const parameters = compiled.parameters as SQLInputValue[];
  if (statement.columns().length > 0) {
    return { rows: statement.all(...parameters) as Row[] };
  }
  const result = statement.run(...parameters);
  return {
    rows: [],
    numAffectedRows: BigInt(result.changes),
    ...(InsertQueryNode.is(compiled.query) && result.changes > 0
      ? { insertId: BigInt(result.lastInsertRowid) }
      : {}),
  };
}

export function takeFirstSync<Row>(db: DatabaseSync, query: Compilable<Row>): Row | undefined {
  return executeSync(db, query).rows[0];
}

export function runImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    if (result && typeof result === "object" && "then" in result) {
      throw new Error("SQLite write transactions must be synchronous");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
