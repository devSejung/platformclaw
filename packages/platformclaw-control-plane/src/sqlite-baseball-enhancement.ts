import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BASEBALL_TEAM_CHANGE_COST,
  BaseballGameError,
  isBaseballKboTeamId,
  type BaseballEnhanceBatRequest,
  type BaseballEnhanceBatResult,
  type BaseballEnhancementState,
  type BaseballEquipEnhancedBatRequest,
  type BaseballEquipEnhancedBatResult,
  type BaseballKboTeamId,
  type BaseballRecoverBatRequest,
  type BaseballRecoverBatResult,
  type BaseballSelectTeamRequest,
  type BaseballSelectTeamResult,
} from "./baseball-contracts.js";
import {
  BASEBALL_ENHANCEMENT_RECOVERY_COST,
  getBaseballEnhancementAppearance,
  getBaseballEnhancementRule,
  resolveBaseballEnhancement,
} from "./baseball-enhancement.js";
import { createSyncKysely, executeSync, takeFirstSync } from "./kysely-sync.js";
import { SqliteGameEconomy } from "./sqlite-game-economy.js";

type EnhancementRow = {
  user_id: string;
  level: number;
  status: "ready" | "broken";
  equipped: number;
  version: 1;
};
type EnhancementDatabase = {
  baseball_bat_enhancements: EnhancementRow;
  baseball_team_selections: { user_id: string; team_id: BaseballKboTeamId };
  baseball_game_progress: { user_id: string; revision: number };
};

/** All methods run inside the store's existing idempotent BEGIN IMMEDIATE transaction. */
export class SqliteBaseballEnhancement {
  private readonly query = createSyncKysely<EnhancementDatabase>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly economy: SqliteGameEconomy,
    private readonly roll = () => randomInt(10_000),
  ) {}

  ensure(userId: string): void {
    const current = this.readEnhancement(userId);
    if (current?.equipped === 1) {
      return;
    }
    // Activation retires legacy gameplay without changing refund evidence, levels, or wallet revision.
    this.writeEnhancement(
      current
        ? { ...current, equipped: 1 }
        : { user_id: userId, level: 0, status: "ready", equipped: 1, version: 1 },
    );
  }

  read(userId: string): { enhancement?: BaseballEnhancementState; teamId?: BaseballKboTeamId } {
    const row = this.readEnhancement(userId);
    const team = takeFirstSync(
      this.db,
      this.query
        .selectFrom("baseball_team_selections")
        .select("team_id")
        .where("user_id", "=", userId),
    );
    return {
      ...(row
        ? {
            enhancement: {
              level: row.level,
              status: row.status,
              equipped: row.equipped === 1,
              version: row.version,
            },
          }
        : {}),
      ...(team ? { teamId: team.team_id } : {}),
    };
  }

  equip(
    userId: string,
    request: BaseballEquipEnhancedBatRequest,
  ): Omit<BaseballEquipEnhancedBatResult, "progress"> {
    this.expectRevision(userId, request.expectedRevision);
    const current = this.readEnhancement(userId);
    if (current?.status === "broken") {
      throw new BaseballGameError(
        "bat_broken",
        "Restore the broken enhancement bat or restart at +0 first",
      );
    }
    const changed = current?.equipped !== 1;
    if (changed) {
      this.writeEnhancement(
        current
          ? { ...current, equipped: 1 }
          : { user_id: userId, level: 0, status: "ready", equipped: 1, version: 1 },
      );
      this.bumpRevision(userId);
    }
    return { requestId: request.requestId, changed };
  }

  enhance(
    userId: string,
    request: BaseballEnhanceBatRequest,
    now: number,
  ): Omit<BaseballEnhanceBatResult, "progress"> {
    this.expectRevision(userId, request.expectedRevision);
    const current = this.readEnhancement(userId);
    if (!current || current.equipped !== 1) {
      throw new BaseballGameError(
        "invalid_enhancement",
        "Equip the enhancement bat before enhancing it",
      );
    }
    if (current.status === "broken") {
      throw new BaseballGameError("bat_broken", "Restore the broken bat or restart at +0 first");
    }
    if (current.level === 20) {
      throw new BaseballGameError("enhancement_max", "The enhancement bat is already at +20");
    }
    const targetLevel = current.level + 1;
    const rule = getBaseballEnhancementRule(targetLevel);
    const balanceAfterFee = this.economy.read(userId).gold - rule.costGold;
    if (balanceAfterFee < 0) {
      throw new BaseballGameError("insufficient_gold", "Not enough G for this enhancement attempt");
    }
    // Exactly one server draw follows all rejection checks; replay never enters this method.
    const outcome = resolveBaseballEnhancement(targetLevel, this.roll());
    const automaticRestart =
      outcome === "destroy" && balanceAfterFee < BASEBALL_ENHANCEMENT_RECOVERY_COST;
    const level =
      outcome === "success"
        ? targetLevel
        : outcome === "maintain"
          ? current.level
          : outcome === "drop"
            ? rule.dropTo!
            : 0;
    const status = outcome === "destroy" && !automaticRestart ? "broken" : "ready";
    const evolved =
      outcome === "success" &&
      getBaseballEnhancementAppearance(current.level).appearanceId !==
        getBaseballEnhancementAppearance(level).appearanceId;
    this.economy.change(userId, -rule.costGold, "bat_enhancement", request.requestId, now);
    this.writeEnhancement({ ...current, level, status });
    return {
      requestId: request.requestId,
      outcome,
      fromLevel: current.level,
      targetLevel,
      level,
      chargedGold: rule.costGold,
      evolved,
      automaticRestart,
    };
  }

  recover(
    userId: string,
    request: BaseballRecoverBatRequest,
    now: number,
  ): Omit<BaseballRecoverBatResult, "progress"> {
    this.expectRevision(userId, request.expectedRevision);
    const current = this.readEnhancement(userId);
    if (!current || current.status !== "broken") {
      throw new BaseballGameError("bat_not_broken", "This enhancement bat does not need recovery");
    }
    if (request.action !== "restore" && request.action !== "restart") {
      throw new BaseballGameError("invalid_enhancement", "Choose restore or restart");
    }
    const restore =
      request.action === "restore" &&
      this.economy.read(userId).gold >= BASEBALL_ENHANCEMENT_RECOVERY_COST;
    const chargedGold = restore ? BASEBALL_ENHANCEMENT_RECOVERY_COST : 0;
    if (chargedGold > 0) {
      this.economy.change(userId, -chargedGold, "bat_recovery", request.requestId, now);
    } else {
      this.bumpRevision(userId);
    }
    this.writeEnhancement({ ...current, level: restore ? 12 : 0, status: "ready" });
    return {
      requestId: request.requestId,
      outcome: restore ? "restored" : "restarted",
      chargedGold,
    };
  }

  selectTeam(
    userId: string,
    request: BaseballSelectTeamRequest,
    now: number,
  ): Omit<BaseballSelectTeamResult, "progress"> {
    this.expectRevision(userId, request.expectedRevision);
    if (!isBaseballKboTeamId(request.teamId)) {
      throw new BaseballGameError("invalid_team", "Choose one of the ten KBO teams");
    }
    const current = this.read(userId).teamId;
    if (current === request.teamId) {
      return {
        requestId: request.requestId,
        teamId: request.teamId,
        changed: false,
        chargedGold: 0,
      };
    }
    const chargedGold = current ? BASEBALL_TEAM_CHANGE_COST : 0;
    if (chargedGold > 0) {
      this.economy.change(userId, -chargedGold, "baseball_team_change", request.requestId, now);
    } else {
      this.bumpRevision(userId);
    }
    executeSync(
      this.db,
      this.query
        .insertInto("baseball_team_selections")
        .values({ user_id: userId, team_id: request.teamId })
        .onConflict((conflict) =>
          conflict.column("user_id").doUpdateSet({ team_id: request.teamId }),
        ),
    );
    return { requestId: request.requestId, teamId: request.teamId, changed: true, chargedGold };
  }

  private expectRevision(userId: string, expectedRevision: number): void {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      this.economy.read(userId).revision !== expectedRevision
    ) {
      throw new BaseballGameError(
        "stale_progress",
        "Game balance or loadout changed; refresh progress and try again",
      );
    }
  }

  private bumpRevision(userId: string): void {
    const { revision } = this.economy.read(userId);
    executeSync(
      this.db,
      this.query
        .updateTable("baseball_game_progress")
        .set({ revision: revision + 1 })
        .where("user_id", "=", userId),
    );
  }

  private readEnhancement(userId: string): EnhancementRow | undefined {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("baseball_bat_enhancements").selectAll().where("user_id", "=", userId),
    );
  }

  private writeEnhancement(row: EnhancementRow): void {
    executeSync(
      this.db,
      this.query
        .insertInto("baseball_bat_enhancements")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("user_id").doUpdateSet({
            level: row.level,
            status: row.status,
            equipped: row.equipped,
            version: row.version,
          }),
        ),
    );
  }
}
