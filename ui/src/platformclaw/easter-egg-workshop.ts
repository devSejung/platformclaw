import { state } from "lit/decorators.js";
import {
  BASEBALL_RPC,
  isBaseballKboTeamId,
  type BaseballEnhanceBatResult,
  type BaseballRecoverBatResult,
  type BaseballSelectTeamResult,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { createBaseballRequestId } from "./easter-egg-controls.ts";
import {
  BaseballPersistence,
  type BaseballMutation,
  type BaseballMutationResponse,
} from "./easter-egg-persistence.ts";
import {
  loadPendingWorkshop,
  savePendingWorkshop,
  clearPendingWorkshop,
  claimWorkshopTaunt,
  isWorkshopJournalEvent,
} from "./easter-egg-workshop-journal.ts";

export type BaseballWorkshopNotice = {
  requestId: string;
  outcome: string;
  level: number;
  targetLevel?: number;
  chargedGold: number;
  evolved?: boolean;
  automaticRestart?: boolean;
};

/** Confirmed server receipts own workshop feedback; unknown outcomes remain retryable. */
export abstract class BaseballWorkshop extends BaseballPersistence {
  abstract random: () => number;
  abstract preferenceScope: string | null;
  @state() protected workshopNotice: BaseballWorkshopNotice | null = null;
  @state() protected workshopEffect = "";
  @state() protected workshopTaunt = "";
  private workshopEffectTimer: number | undefined;
  private workshopTauntTimer: number | undefined;
  private lastWorkshopReceipt: string | undefined;
  private workshopStorageAvailable = false;
  private workshopFeedbackEpoch = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("storage", this.handleWorkshopStorage);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("storage", this.handleWorkshopStorage);
    this.resetWorkshop();
    super.disconnectedCallback();
  }

  private readonly handleWorkshopStorage = (event: StorageEvent): void => {
    if (isWorkshopJournalEvent(this.preferenceScope, event.key)) {
      this.onMutationSettled();
      void this.refreshSharedProgress();
    }
  };

  protected override onMutationSettled(resumeGameplay = true): void {
    const previous = this.pendingMutation;
    const workshopPending = this.restorePendingWorkshop();
    if (previous && previous !== this.pendingMutation) {
      this.releaseKnownMutation(previous);
    }
    if (resumeGameplay || workshopPending) {
      this.onWorkshopQueueUpdated();
    }
  }

  protected onWorkshopQueueUpdated(): void {}

  protected restorePendingWorkshop(): boolean {
    // Other tabs may queue work, but the active gameplay receipt still owns its callback.
    if (this.pendingMutation?.method === BASEBALL_RPC.plateAppearance) {
      return false;
    }
    try {
      const pending = loadPendingWorkshop(this.preferenceScope);
      const stored = pending[0];
      this.workshopStorageAvailable = true;
      if (!stored) {
        if (this.pendingMutation) {
          this.pendingMutation = null;
          this.persistenceStatus = "";
        }
        return false;
      }
      if (this.pendingMutation?.params.requestId === stored.params.requestId) {
        return true;
      }
      this.pendingMutation = {
        ...stored,
        journaled: true,
        label: "미확정 요청 · 같은 요청으로 결과 확인",
        onSuccess: (response) =>
          this.confirmWorkshop(stored.method, stored.params.requestId as string, response),
      };
      this.persistenceStatus = this.pendingMutation.label;
      return true;
    } catch {
      this.workshopStorageAvailable = false;
      this.persistenceStatus = "미확정 요청 복구 정보를 확인할 수 없습니다.";
      return false;
    }
  }

  protected override rememberMutation(mutation: BaseballMutation): boolean {
    const remembered =
      mutation.method === BASEBALL_RPC.plateAppearance ||
      savePendingWorkshop(this.preferenceScope, mutation, mutation.journaled);
    if (remembered) {
      mutation.journaled = true;
    }
    return remembered;
  }

  protected override async forgetMutation(mutation: BaseballMutation): Promise<void> {
    if (
      [
        BASEBALL_RPC.enhanceBat,
        BASEBALL_RPC.recoverBat,
        BASEBALL_RPC.equipEnhancedBat,
        BASEBALL_RPC.selectTeam,
      ].includes(mutation.method as typeof BASEBALL_RPC.enhanceBat)
    ) {
      try {
        await clearPendingWorkshop(this.preferenceScope, mutation);
      } catch {
        // Keep a replayable journal if local storage becomes unavailable after confirmation.
      }
    }
  }

  protected readonly enhanceBat = (): void => {
    void this.workshopMutation(BASEBALL_RPC.enhanceBat, {}, "강화 결과 확인 실패");
  };

  protected readonly recoverBat = (action: "restore" | "restart"): void => {
    void this.workshopMutation(BASEBALL_RPC.recoverBat, { action }, "배트 복구 결과 확인 실패");
  };

  protected readonly selectTeam = (teamId: string): void => {
    if (isBaseballKboTeamId(teamId)) {
      void this.workshopMutation(BASEBALL_RPC.selectTeam, { teamId }, "팀 변경 결과 확인 실패");
    }
  };

  protected resetWorkshop(): void {
    this.workshopFeedbackEpoch += 1;
    window.clearTimeout(this.workshopEffectTimer);
    window.clearTimeout(this.workshopTauntTimer);
    this.workshopNotice = null;
    this.workshopEffect = "";
    this.workshopTaunt = "";
    this.lastWorkshopReceipt = undefined;
  }

  private async workshopMutation(
    method: string,
    values: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    if (!this.progress || this.persistenceBusy || this.pendingMutation) {
      return;
    }
    if (this.restorePendingWorkshop() || !this.workshopStorageAvailable) {
      return;
    }
    this.workshopNotice = null;
    this.workshopEffect = "";
    const requestId = createBaseballRequestId(this.random);
    await this.runMutation({
      method,
      params: { requestId, expectedRevision: this.progress.revision, ...values },
      label,
      onSuccess: (response) => this.confirmWorkshop(method, requestId, response),
    });
  }

  private confirmWorkshop(
    method: string,
    requestId: string,
    response: BaseballMutationResponse,
  ): void {
    if (this.lastWorkshopReceipt === requestId) {
      return;
    }
    this.lastWorkshopReceipt = requestId;
    const feedbackEpoch = ++this.workshopFeedbackEpoch;
    window.clearTimeout(this.workshopTauntTimer);
    this.workshopTaunt = "";
    const level = response.progress.enhancement?.level ?? 0;
    if (method === BASEBALL_RPC.enhanceBat) {
      const receipt = response as BaseballEnhanceBatResult;
      this.workshopNotice = { ...receipt };
      this.workshopEffect = receipt.evolved ? "evolution" : receipt.outcome;
      if (["maintain", "drop", "destroy", "total_destroy"].includes(receipt.outcome)) {
        // Cosmetic selection only; the server has already committed the economic outcome.
        void this.showWorkshopTaunt(requestId, feedbackEpoch);
      }
    } else if (method === BASEBALL_RPC.recoverBat) {
      const receipt = response as BaseballRecoverBatResult;
      this.workshopNotice = {
        requestId,
        outcome: receipt.outcome,
        level,
        chargedGold: receipt.chargedGold,
      };
      this.workshopEffect = receipt.outcome;
    } else if (method === BASEBALL_RPC.selectTeam) {
      const receipt = response as BaseballSelectTeamResult;
      this.workshopNotice = { requestId, outcome: "team", level, chargedGold: receipt.chargedGold };
    } else {
      this.workshopNotice = { requestId, outcome: "equipped", level, chargedGold: 0 };
    }
    window.clearTimeout(this.workshopEffectTimer);
    this.workshopEffectTimer = window.setTimeout(() => {
      this.workshopEffect = "";
    }, 700);
  }

  private async showWorkshopTaunt(requestId: string, epoch: number): Promise<void> {
    const scope = this.preferenceScope;
    const canDisplay = () =>
      this.isConnected &&
      !document.hidden &&
      scope === this.preferenceScope &&
      epoch === this.workshopFeedbackEpoch &&
      this.querySelector('[role="application"]') !== null;
    const claimed = await claimWorkshopTaunt(scope, requestId, canDisplay);
    if (!claimed || !canDisplay()) {
      return;
    }
    const messages = [
      "줴줴이야~",
      "ㅋㅋ",
      "ㅋ",
      "ㅋㅋㄹㅇ",
      "어림없지",
      "다시 와라",
      "ㅈㄴ못하네~",
    ];
    this.workshopTaunt = messages[Math.floor(Math.random() * messages.length)]!;
    this.workshopTauntTimer = window.setTimeout(() => {
      this.workshopTaunt = "";
    }, 2_000);
  }
}
