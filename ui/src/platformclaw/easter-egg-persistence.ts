import { property, state } from "lit/decorators.js";
import {
  BASEBALL_RPC,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";

export type BaseballMutation = {
  method: string;
  params: Record<string, unknown>;
  label: string;
  onSuccess?: () => void;
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
  @state() protected persistenceStatus = "";
  @state() protected persistenceBusy = false;
  protected pendingMutation: BaseballMutation | null = null;
  protected playSequence = 0;
  protected clientEpoch = 0;

  protected abstract onProgress(progress: BaseballProgress): void;
  protected abstract onPlateAppearanceConfirmed(
    mutation: BaseballMutation,
    response: BaseballMutationResponse,
  ): void;
  protected abstract onAtBatRejected(): void;
  protected abstract loadLeaderboard(sequence: number): Promise<void>;

  protected isCurrentRequest(
    client: GatewayBrowserClient,
    epoch: number,
    sequence: number,
  ): boolean {
    return this.client === client && this.clientEpoch === epoch && this.playSequence === sequence;
  }

  protected async runMutation(mutation: BaseballMutation): Promise<void> {
    const client = this.client;
    const sequence = this.playSequence;
    const epoch = this.clientEpoch;
    if (!client) {
      this.pendingMutation = mutation;
      this.persistenceStatus = "진행 저장 불가";
      return;
    }
    this.pendingMutation = mutation;
    this.persistenceBusy = true;
    this.persistenceStatus = "저장 중";
    try {
      const response = await client.request<BaseballMutationResponse>(
        mutation.method,
        mutation.params,
      );
      if (!this.isCurrentRequest(client, epoch, sequence)) {
        return;
      }
      if (!this.progress || response.progress.revision >= this.progress.revision) {
        this.progress = response.progress;
        this.onProgress(response.progress);
      }
      this.pendingMutation = null;
      this.persistenceStatus = "";
      mutation.onSuccess?.();
      if (mutation.method === BASEBALL_RPC.plateAppearance) {
        this.onPlateAppearanceConfirmed(mutation, response);
        void this.loadLeaderboard(sequence);
      }
    } catch (error) {
      if (this.isCurrentRequest(client, epoch, sequence)) {
        if (
          mutation.method === BASEBALL_RPC.plateAppearance &&
          error instanceof GatewayRequestError &&
          error.code === "INVALID_REQUEST"
        ) {
          // A rejected nonce cannot become valid on retry; start a fresh server-issued round.
          this.pendingMutation = null;
          this.onAtBatRejected();
          this.persistenceStatus = `타석 저장 거절 · ${error.message} · 다시 불러오기를 눌러주세요`;
        } else {
          this.persistenceStatus = mutation.label;
        }
      }
    } finally {
      if (this.isCurrentRequest(client, epoch, sequence)) {
        this.persistenceBusy = false;
      }
    }
  }
}
