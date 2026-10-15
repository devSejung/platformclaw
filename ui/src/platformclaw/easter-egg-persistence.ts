import { property, state } from "lit/decorators.js";
import {
  BASEBALL_RPC,
  type BaseballLeaderboard,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

export type BaseballMutation = {
  method: string;
  params: Record<string, unknown>;
  label: string;
  onSuccess?: (response: BaseballMutationResponse) => void;
  journaled?: boolean;
};
export type BaseballMutationResponse = {
  progress: BaseballProgress;
  awardedGold?: number;
  homeRunBonusGold?: 0 | 5;
};

/** The mutation owner keeps unknown outcomes retryable and rejects responses from a replaced account/game. */
export abstract class BaseballPersistence extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @state() protected progress: BaseballProgress | null = null;
  @state() private persistenceStatusValue = "";
  private persistenceStatusVersion = 0;
  @state() protected persistenceBusy = false;
  private readonly persistenceOperations = new Set<symbol>();
  private readonly mutationOperations = new Map<BaseballMutation, () => void>();
  @state() protected leaderboard: BaseballLeaderboard | null = null;
  @state() protected leaderboardStatus = "";
  private leaderboardRequest = 0;
  protected pendingMutation: BaseballMutation | null = null;
  protected playSequence = 0;
  protected clientEpoch = 0;

  protected rememberMutation(_mutation: BaseballMutation): boolean {
    return true;
  }

  protected forgetMutation(_mutation: BaseballMutation): void | Promise<void> {}
  protected onMutationSettled(_resumeGameplay = true): void {}

  protected async refreshSharedProgress(): Promise<void> {
    const client = this.client;
    const epoch = this.clientEpoch;
    const sequence = this.playSequence;
    if (client) {
      try {
        const progress = await client.request<BaseballProgress>(BASEBALL_RPC.progress, {});
        if (this.isCurrentRequest(client, epoch, sequence)) {
          this.applyBaseballProgress(progress);
        }
      } catch {
        // A cross-tab refresh never changes the current request's feedback or ownership.
      }
    }
  }

  protected get persistenceStatus(): string {
    return this.persistenceStatusValue;
  }

  protected set persistenceStatus(value: string) {
    this.persistenceStatusVersion += 1;
    this.persistenceStatusValue = value;
  }

  protected beginPersistence(): () => void {
    const operation = Symbol();
    this.persistenceOperations.add(operation);
    this.persistenceBusy = true;
    return () => {
      this.persistenceOperations.delete(operation);
      this.persistenceBusy = this.persistenceOperations.size > 0;
    };
  }

  protected resetPersistence(): void {
    this.persistenceOperations.clear();
    this.mutationOperations.clear();
    this.persistenceBusy = false;
  }

  protected releaseKnownMutation(mutation: BaseballMutation): void {
    this.mutationOperations.get(mutation)?.();
    this.mutationOperations.delete(mutation);
  }

  protected abstract onProgress(progress: BaseballProgress): void;
  protected abstract onPlateAppearanceConfirmed(
    mutation: BaseballMutation,
    response: BaseballMutationResponse,
  ): void;
  protected abstract onAtBatRejected(): void;

  protected async loadLeaderboard(sequence: number): Promise<void> {
    const client = this.client;
    const epoch = this.clientEpoch;
    const request = ++this.leaderboardRequest;
    if (!client || sequence !== this.playSequence) {
      return;
    }
    this.leaderboardStatus = "랭킹 불러오는 중";
    try {
      const leaderboard = await client.request<BaseballLeaderboard>(BASEBALL_RPC.leaderboard, {});
      if (this.isCurrentRequest(client, epoch, sequence) && this.leaderboardRequest === request) {
        this.leaderboard = leaderboard;
        this.leaderboardStatus = "";
      }
    } catch {
      if (this.isCurrentRequest(client, epoch, sequence) && this.leaderboardRequest === request) {
        this.leaderboardStatus = "랭킹 불러오기 실패";
      }
    }
  }

  protected isCurrentRequest(
    client: GatewayBrowserClient,
    epoch: number,
    sequence: number,
  ): boolean {
    return this.client === client && this.clientEpoch === epoch && this.playSequence === sequence;
  }

  protected applyBaseballProgress(progress: BaseballProgress): void {
    if (!this.progress || progress.revision >= this.progress.revision) {
      this.progress = progress;
      this.onProgress(progress);
    }
  }

  protected async runMutation(mutation: BaseballMutation): Promise<void> {
    if (this.pendingMutation && this.pendingMutation !== mutation) {
      return;
    }
    const wasPending = this.pendingMutation === mutation;
    if (!this.rememberMutation(mutation)) {
      this.onMutationSettled();
      if (wasPending && this.pendingMutation?.params.requestId !== mutation.params.requestId) {
        void this.refreshSharedProgress();
        return;
      }
      this.persistenceStatus = "요청 복구 정보를 저장할 수 없어 전송하지 않았습니다.";
      return;
    }
    const client = this.client;
    const sequence = this.playSequence;
    const epoch = this.clientEpoch;
    const retrying = this.pendingMutation === mutation;
    if (!client) {
      this.pendingMutation = mutation;
      this.persistenceStatus = "진행 저장 불가";
      return;
    }
    this.pendingMutation = mutation;
    const finishPersistence = this.beginPersistence();
    this.mutationOperations.set(mutation, finishPersistence);
    this.persistenceStatus = "저장 중";
    try {
      const response = await client.request<BaseballMutationResponse>(
        mutation.method,
        mutation.params,
      );
      if (!this.isCurrentRequest(client, epoch, sequence) || this.pendingMutation !== mutation) {
        return;
      }
      this.applyBaseballProgress(response.progress);
      this.pendingMutation = null;
      this.persistenceStatus = "";
      finishPersistence();
      await this.forgetMutation(mutation);
      if (!this.isCurrentRequest(client, epoch, sequence)) {
        return;
      }
      mutation.onSuccess?.(response);
      if (mutation.method === BASEBALL_RPC.plateAppearance) {
        this.onPlateAppearanceConfirmed(mutation, response);
        void this.loadLeaderboard(sequence);
      }
      this.onMutationSettled();
      if (retrying) {
        const ownsStatus = !this.pendingMutation;
        if (ownsStatus) {
          this.persistenceStatus = "결과 확인됨 · 최신 진행도 갱신 중";
        }
        const statusVersion = this.persistenceStatusVersion;
        try {
          const progress = await client.request<BaseballProgress>(BASEBALL_RPC.progress, {});
          if (this.isCurrentRequest(client, epoch, sequence)) {
            this.applyBaseballProgress(progress);
            if (ownsStatus && this.persistenceStatusVersion === statusVersion) {
              this.persistenceStatus = "";
            }
          }
        } catch {
          if (
            this.isCurrentRequest(client, epoch, sequence) &&
            ownsStatus &&
            this.persistenceStatusVersion === statusVersion
          ) {
            this.persistenceStatus =
              "결과 확인됨 · 최신 진행도 갱신 실패 · 다시 불러오기를 눌러주세요";
          }
        }
      }
    } catch (error) {
      if (this.isCurrentRequest(client, epoch, sequence) && this.pendingMutation === mutation) {
        if (
          mutation.method === BASEBALL_RPC.plateAppearance &&
          error instanceof GatewayRequestError &&
          error.code === "INVALID_REQUEST"
        ) {
          // A rejected nonce cannot become valid on retry; start a fresh server-issued round.
          this.pendingMutation = null;
          this.onAtBatRejected();
          this.persistenceStatus = `타석 저장 거절 · ${error.message} · 다시 불러오기를 눌러주세요`;
          finishPersistence();
          // Adopt queued workshop work; without it, retain the explicit fresh-nonce reload.
          this.onMutationSettled(false);
        } else if (
          error instanceof GatewayRequestError &&
          error.code === "INVALID_REQUEST" &&
          [
            BASEBALL_RPC.equipBat,
            BASEBALL_RPC.purchaseBat,
            BASEBALL_RPC.enhanceBat,
            BASEBALL_RPC.recoverBat,
            BASEBALL_RPC.equipEnhancedBat,
            BASEBALL_RPC.selectTeam,
          ].includes(mutation.method as typeof BASEBALL_RPC.enhanceBat)
        ) {
          // A definitive rejection cannot become valid on retry with the same receipt and revision.
          this.pendingMutation = null;
          await this.forgetMutation(mutation);
          if (!this.isCurrentRequest(client, epoch, sequence)) {
            return;
          }
          this.persistenceStatus = error.message;
          finishPersistence();
          this.onMutationSettled();
          try {
            const progress = await client.request<BaseballProgress>(BASEBALL_RPC.progress, {});
            if (this.isCurrentRequest(client, epoch, sequence)) {
              this.applyBaseballProgress(progress);
            }
          } catch {
            // Keep the visible rejection and allow an explicit refresh if the balance read is offline.
          }
        } else {
          this.persistenceStatus = mutation.label;
        }
      }
    } finally {
      finishPersistence();
      // A reconnect retry can reuse this object while owning a newer release callback.
      if (this.mutationOperations.get(mutation) === finishPersistence) {
        this.mutationOperations.delete(mutation);
      }
    }
  }
}
