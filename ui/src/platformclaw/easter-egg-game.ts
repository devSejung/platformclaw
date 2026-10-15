import { property, state } from "lit/decorators.js";
import {
  BASEBALL_RPC,
  type BaseballBatId,
  type BaseballAtBat,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { resolveBaseballAtBatPower } from "../../../packages/platformclaw-control-plane/src/baseball-enhancement.ts";
import "../styles/platformclaw-easter-egg.css";
import { renderArcade } from "./easter-egg-arcade-view.ts";
import { BaseballCelebration } from "./easter-egg-celebration.ts";
import { PausableGameClock } from "./easter-egg-clock.ts";
import {
  createBaseballRequestId,
  focusBaseballShop,
  isBaseballInteractiveTarget,
  ArcadeInputController,
} from "./easter-egg-controls.ts";
import {
  cacheBaseballFieldElements,
  layoutBaseballStaticField,
  renderBaseballProjectile,
  resolveBaseballFieldLayout,
  setBaseballWorldPosition,
} from "./easter-egg-layout.ts";
import type { BaseballMutation, BaseballMutationResponse } from "./easter-egg-persistence.ts";
import {
  BASEBALL_DEFAULT_SETTINGS,
  isBaseballTeamId,
  loadBaseballSettings,
  saveBaseballSettings,
  type BaseballSettings,
} from "./easter-egg-settings.ts";
import {
  BASEBALL_WORLD,
  advanceBattedBall,
  createBattedBall,
  createPitch,
  pitchPositionAt,
  type BaseballPoint,
  type BattedBallSimulation,
  type Pitch,
} from "./easter-egg-simulation.ts";
import { classifyTimingDelta, formatTimingFeedback } from "./easter-egg-timing.ts";
import { BASEBALL_TRAIL_POINTS, renderBaseballGame } from "./easter-egg-view.ts";
import { BaseballWorkshop } from "./easter-egg-workshop.ts";
import { PLATFORMCLAW_EASTER_EGG_EVENT } from "./easter-egg.ts";
import { platformClawT as t } from "./i18n.ts";

const BETWEEN_ROUNDS_MS = 650;
const MIN_WINDUP_DELAY_MS = 520;
const MAX_WINDUP_DELAY_MS = 820;
const LEG_LIFT_MS = 190;
const FOLLOW_THROUGH_MS = 250;
const SWING_ANIMATION_MS = 190;
const FEEDBACK_VISIBLE_MS = 1_100;

type AnimationState = Parameters<typeof renderBaseballGame>[0]["pitcherState"];
type GamePhase = "ready" | "pitch" | "in-play" | "result";
type TimerKey = "pitch" | "follow" | "batter" | "result" | "feedback";
class PlatformClawEasterEgg extends BaseballWorkshop {
  @property({ attribute: false }) preferenceScope: string | null = null;
  /** Test seams; production retains Math.random and performance.now. */
  @property({ attribute: false }) random: () => number = Math.random;
  @property({ attribute: false }) now: () => number = () => performance.now();

  @state() private active = false;
  @state() private gameScreen: "closed" | "selector" | "baseball" | "racing" = "closed";
  @state() private shopOpen = false;
  @state() private phase: GamePhase = "ready";
  @state() private round = 0;
  @state() private hits = 0;
  @state() private homeRuns = 0;
  @state() private streak = 0;
  @state() private result = "";
  @state() private lastDistance: number | null = null;
  @state() private feedbackVisible = false;
  @state() private playerState: AnimationState = "idle";
  @state() private pitcherState: AnimationState = "idle";
  @state() private settings: BaseballSettings = { ...BASEBALL_DEFAULT_SETTINGS };
  @state() private settingsStatus = "";
  @state() private awardedGold: number | null = null;

  private animationFrame = 0;
  private readonly celebration = new BaseballCelebration(this);
  private pitch: Pitch | null = null;
  private atBat: BaseballAtBat | null = null;
  private atBatRequestId: string | null = null;
  private swingTimingDeltaMs: number | null = null;
  private pitchElapsedMs = 0;
  private battedBall: BattedBallSimulation | null = null;
  private roundBatId: BaseballBatId = "wood";
  private lastFrameAt = 0;
  private readonly input = new ArcadeInputController({
    host: this,
    active: () => this.active,
    selector: () => this.gameScreen === "selector",
    shopOpen: () => this.shopOpen,
    player: () => this.field.player,
    swing: (event) => this.swing(event),
    closeShop: (event) => this.closeShop(event),
    close: () => this.finishGame(),
  });
  private readonly clock = new PausableGameClock<TimerKey>(() => this.now());
  private field = cacheBaseballFieldElements(this);
  private trail: BaseballPoint[] = [];

  private readonly handleTrigger = (): void =>
    this.gameScreen !== "closed" ? this.finishGame() : this.showGameSelector();

  private returnFocus: HTMLElement | null = null;

  private showGameSelector(): void {
    if (this.gameScreen === "closed") {
      this.returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.finishGame();
    this.gameScreen = "selector";
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>("[data-game-choice]")?.focus(),
    );
  }

  private startRacing(): void {
    this.finishGame();
    this.gameScreen = "racing";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.input.connect();
    window.addEventListener("resize", this.handleResize);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, this.handleTrigger);
  }

  override disconnectedCallback(): void {
    this.input.disconnect();
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, this.handleTrigger);
    this.finishGame();
    super.disconnectedCallback();
  }

  override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("preferenceScope")) {
      if (this.gameScreen !== "closed" && changed.get("preferenceScope") !== undefined) {
        this.finishGame();
      }
      this.settings = loadBaseballSettings(this.preferenceScope);
      this.settingsStatus = "";
    }
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("client")) {
      this.clientEpoch += 1;
      this.celebration.reset();
      this.resetPersistence();
      const preservePending =
        this.preferenceScope !== null && !changed.has("preferenceScope") && this.pendingMutation;
      if (preservePending) {
        this.persistenceStatus = this.pendingMutation!.label;
      } else {
        this.resetWorkshop();
        this.pendingMutation = null;
        this.progress = null;
        this.leaderboard = null;
        this.leaderboardStatus = "";
      }
      if (this.active && !preservePending) {
        this.persistenceStatus = this.client ? "진행도 다시 불러오는 중" : "진행 저장 불가";
        void this.loadProgress(this.playSequence);
      }
    }
    if (!this.active) {
      return;
    }
    this.field = cacheBaseballFieldElements(this);
    this.layoutStaticField();
    this.renderProjectile();
  }

  override render() {
    return renderArcade({
      screen: this.gameScreen,
      client: this.client,
      preferenceScope: this.preferenceScope,
      onBaseball: () => void this.startGame(),
      onRacing: () => this.startRacing(),
      onGames: () => this.showGameSelector(),
      onClose: () => this.finishGame(),
      baseball: () => this.renderBaseball(),
    });
  }
  private renderBaseball() {
    return renderBaseballGame({
      active: this.active,
      shopOpen: this.shopOpen,
      phase: this.phase,
      round: this.round,
      hits: this.hits,
      homeRuns: this.homeRuns,
      streak: this.streak,
      result: this.result,
      lastDistance: this.lastDistance,
      feedbackVisible: this.feedbackVisible,
      playerState: this.playerState,
      pitcherState: this.pitcherState,
      progress: this.progress,
      leaderboard: this.leaderboard,
      leaderboardStatus: this.leaderboardStatus,
      persistenceStatus: this.persistenceStatus,
      persistenceBusy: this.persistenceBusy,
      settings: this.settings,
      settingsStatus: this.settingsStatus,
      awardedGold: this.awardedGold,
      bonusVisible: this.celebration.visible,
      pendingMutationMethod: this.pendingMutation?.method ?? null,
      roundBatId: this.roundBatId,
      roundEnhancementLevel: this.atBat?.enhancementLevel ?? null,
      workshopNotice: this.workshopNotice,
      workshopEffect: this.workshopEffect,
      workshopTaunt: this.workshopTaunt,
      revealedPitch: this.phase === "in-play" || this.phase === "result" ? this.pitch : null,
      onOpenShop: this.openShop,
      onRetry: this.retryPendingMutation,
      onRetryLoad: this.retryLoad,
      onCloseShop: this.closeShop,
      onSelectBat: (batId, owned) => void this.selectBat(batId, owned),
      onSelectTeam: this.selectTeam,
      onEnhance: this.enhanceBat,
      onRecover: this.recoverBat,
      onEquipEnhanced: this.equipEnhancedBat,
      onOpacity: (opacity) => {
        if (Number.isInteger(opacity) && opacity >= 30 && opacity <= 100 && opacity % 5 === 0) {
          this.updateSettings({ ...this.settings, opacity });
        }
      },
      onStopEvent: (event) => event.stopPropagation(),
    });
  }

  private async startGame(): Promise<void> {
    this.finishGame();
    this.gameScreen = "baseball";
    const sequence = ++this.playSequence;
    document.body.classList.add("platformclaw-baseball-active");
    this.active = true;
    this.shopOpen = this.restorePendingWorkshop();
    this.round = 0;
    this.hits = 0;
    this.homeRuns = 0;
    this.streak = 0;
    this.result = "";
    this.lastDistance = null;
    this.awardedGold = null;
    this.persistenceStatus = this.client ? "진행도 불러오는 중" : "진행 저장 불가";
    await this.updateComplete;
    this.querySelector<HTMLElement>('[role="application"]')?.focus();
    await this.loadProgress(sequence);
  }

  private async loadProgress(sequence: number): Promise<void> {
    const client = this.client;
    const epoch = this.clientEpoch;
    if (!client || !this.active || sequence !== this.playSequence) {
      return;
    }
    const finishPersistence = this.beginPersistence();
    try {
      const progress = await client.request<BaseballProgress>(BASEBALL_RPC.progress, {});
      if (!this.isCurrentRequest(client, epoch, sequence)) {
        return;
      }
      this.applyBaseballProgress(progress);
      this.persistenceStatus = this.pendingMutation?.label ?? "";
      void this.loadLeaderboard(sequence);
      await this.startRound(sequence);
    } catch {
      if (this.isCurrentRequest(client, epoch, sequence)) {
        this.persistenceStatus = "진행 저장 불가";
      }
    } finally {
      finishPersistence();
    }
  }

  private async startRound(sequence: number): Promise<void> {
    if (!this.active || sequence !== this.playSequence || !this.progress || this.pendingMutation) {
      return;
    }
    this.clock.clear("pitch");
    this.clock.clear("follow");
    this.clock.clear("batter");
    this.clock.clear("feedback");
    this.round += 1;
    this.phase = "ready";
    this.result = "";
    this.lastDistance = null;
    this.feedbackVisible = false;
    this.playerState = "idle";
    this.pitcherState = "idle";
    this.pitch = null;
    this.atBat = null;
    this.swingTimingDeltaMs = null;
    this.pitchElapsedMs = 0;
    this.battedBall = null;
    this.trail = [];
    this.atBatRequestId = createBaseballRequestId(this.random);
    if (this.progress.enhancement?.equipped && this.progress.enhancement.status === "broken") {
      this.persistenceStatus = "배트가 파괴되었습니다. 상점에서 복구 또는 재시작하세요.";
      return;
    }
    await this.loadAtBat(sequence);
  }

  private async loadAtBat(sequence: number): Promise<void> {
    const client = this.client;
    const epoch = this.clientEpoch;
    const requestId = this.atBatRequestId;
    if (!client || !requestId || !this.active || sequence !== this.playSequence) {
      return;
    }
    const finishPersistence = this.beginPersistence();
    this.persistenceStatus = "투구 준비 중";
    try {
      const atBat = await client.request<BaseballAtBat>(BASEBALL_RPC.beginAtBat, { requestId });
      if (!this.isCurrentRequest(client, epoch, sequence) || this.atBatRequestId !== requestId) {
        return;
      }
      this.atBat = atBat;
      this.atBatRequestId = null;
      this.pitch = createPitch(() => atBat.pitchSample);
      this.roundBatId = atBat.batId;
      this.persistenceStatus = "";
      this.schedulePitch(sequence);
      this.resumeGameTime();
    } catch {
      if (this.isCurrentRequest(client, epoch, sequence) && this.atBatRequestId === requestId) {
        this.persistenceStatus = "투구 준비 실패 · 다시 불러오기를 눌러주세요";
      }
    } finally {
      finishPersistence();
    }
  }

  private schedulePitch(sequence: number): void {
    this.scheduleTimer(
      "pitch",
      MIN_WINDUP_DELAY_MS + this.random() * (MAX_WINDUP_DELAY_MS - MIN_WINDUP_DELAY_MS),
      () => {
        this.pitcherState = this.pitch?.kind === "underhand" ? "underhand-windup" : "leg-lift";
        this.scheduleTimer("pitch", LEG_LIFT_MS, () => this.launchPitch(sequence));
      },
    );
    this.ensureAnimationLoop();
  }

  private launchPitch(sequence: number): void {
    if (!this.active || sequence !== this.playSequence || !this.pitch) {
      return;
    }
    this.phase = "pitch";
    this.pitchElapsedMs = 0;
    const underhand = this.pitch.kind === "underhand";
    this.pitcherState = underhand ? "underhand-throw" : "throw";
    this.lastFrameAt = this.now();
    this.trail = [pitchPositionAt(this.pitch, 0)];
    this.renderProjectile();
    this.scheduleTimer("follow", FOLLOW_THROUGH_MS, () => {
      this.pitcherState = underhand ? "underhand-follow-through" : "follow-through";
    });
  }

  private readonly tick = (now: number): void => {
    if (!this.active || this.isPaused()) {
      this.animationFrame = 0;
      return;
    }
    const deltaMs = Math.max(0, now - this.lastFrameAt);
    this.lastFrameAt = now;
    if (this.phase === "pitch" && this.pitch) {
      this.pitchElapsedMs += deltaMs;
      this.pushTrail(pitchPositionAt(this.pitch, this.pitchElapsedMs));
      if (this.pitchElapsedMs - this.pitch.idealContactTimeMs > 100) {
        this.resolveAtBat("miss");
      }
    } else if (this.phase === "in-play" && this.battedBall) {
      advanceBattedBall(this.battedBall, deltaMs);
      this.pushTrail(this.battedBall.ball);
      setBaseballWorldPosition(
        this.field.outfielder,
        this.battedBall.outfielder.x,
        0,
        resolveBaseballFieldLayout(this, this.field.arena),
      );
      if (this.battedBall.result) {
        const { kind, distanceM } = this.battedBall.result;
        this.resolveAtBat(
          kind === "HOME_RUN" ? "home_run" : kind === "HIT" ? "hit" : "out",
          Math.max(0, Math.round(distanceM)),
        );
      }
    }
    this.renderProjectile();
    if (this.active && !this.isPaused()) {
      this.animationFrame = requestAnimationFrame(this.tick);
    }
  };

  private swing(event: Event): void {
    if (
      !this.active ||
      this.isPaused() ||
      this.phase !== "pitch" ||
      !this.pitch ||
      isBaseballInteractiveTarget(event.target)
    ) {
      return;
    }
    if (event instanceof KeyboardEvent && event.code === "Space") {
      event.preventDefault();
    }
    const now = this.now();
    this.pitchElapsedMs += Math.max(0, now - this.lastFrameAt);
    this.lastFrameAt = now;
    const timingDeltaMs = this.pitchElapsedMs - this.pitch.idealContactTimeMs;
    this.swingTimingDeltaMs = timingDeltaMs;
    const timing = classifyTimingDelta(timingDeltaMs);
    this.result = formatTimingFeedback(timingDeltaMs, timing);
    this.showFeedback();
    if (timing === "MISS") {
      this.resolveAtBat("miss");
      return;
    }
    const batPower = resolveBaseballAtBatPower(
      this.atBat ?? { batId: this.roundBatId },
      timingDeltaMs,
    );
    this.battedBall = createBattedBall({ timingDeltaMs, batPower });
    this.phase = "in-play";
    this.playerState = timing === "PERFECT" ? "swing-perfect" : "swing";
    this.trail = [{ x: BASEBALL_WORLD.contactX, y: BASEBALL_WORLD.pitchY }];
    this.scheduleTimer("batter", SWING_ANIMATION_MS, () => {
      if (this.phase === "in-play") {
        this.playerState = "follow-through";
      }
    });
  }

  private resolveAtBat(outcome: "home_run" | "hit" | "out" | "miss", distanceM?: number): void {
    if (this.phase === "result") {
      return;
    }
    this.phase = "result";
    this.battedBall = null;
    this.trail = [];
    this.renderProjectile();
    this.clock.clear("batter");
    this.playerState = outcome === "miss" ? "idle" : "follow-through";
    this.streak = outcome === "home_run" ? this.streak + 1 : 0;
    if (outcome === "home_run") {
      this.result = "홈런";
      this.homeRuns += 1;
      this.lastDistance = distanceM ?? null;
    } else if (outcome === "hit") {
      this.result = "안타";
      this.hits += 1;
      this.lastDistance = distanceM ?? null;
    } else if (outcome === "out") {
      this.result = "아웃";
      this.lastDistance = distanceM ?? null;
    } else {
      this.result = "MISS";
      this.lastDistance = null;
    }
    this.showFeedback();
    if (!this.atBat) {
      this.persistenceStatus = "타석 정보가 없습니다 · 다시 불러오기를 눌러주세요";
      return;
    }
    void this.runMutation({
      method: BASEBALL_RPC.plateAppearance,
      params: {
        requestId: createBaseballRequestId(this.random),
        atBatId: this.atBat.id,
        timingDeltaMs: this.swingTimingDeltaMs,
      },
      label: "타석 저장 실패",
      onSuccess: () => this.scheduleNextRound(),
    });
  }

  private async selectBat(batId: BaseballBatId, owned: boolean): Promise<void> {
    if (!this.progress || this.persistenceBusy || this.pendingMutation) {
      return;
    }
    await this.runMutation({
      method: owned ? BASEBALL_RPC.equipBat : BASEBALL_RPC.purchaseBat,
      params: { requestId: createBaseballRequestId(this.random), batId },
      label: owned ? "배트 장착 실패" : "배트 구매 실패",
    });
  }

  protected override onProgress(progress: BaseballProgress): void {
    this.streak = progress.currentHomeRunStreak;
    const teamId =
      progress.teamId && isBaseballTeamId(progress.teamId)
        ? progress.teamId
        : BASEBALL_DEFAULT_SETTINGS.teamId;
    if (this.settings.teamId !== teamId) {
      this.updateSettings({ ...this.settings, teamId });
    }
  }

  protected override onPlateAppearanceConfirmed(
    mutation: BaseballMutation,
    response: BaseballMutationResponse,
  ): void {
    if (typeof mutation.params.requestId === "string") {
      this.celebration.confirm(
        mutation.params.requestId,
        response.homeRunBonusGold,
        !this.isPaused(),
      );
    }
    if (typeof response.awardedGold === "number" && Number.isFinite(response.awardedGold)) {
      this.awardedGold = response.awardedGold;
    }
  }

  protected override onAtBatRejected(): void {
    this.atBat = null;
    this.atBatRequestId = null;
    this.phase = "ready";
  }
  protected override onWorkshopQueueUpdated(): void {
    if (this.active && !this.shopOpen) {
      this.closeShop();
    }
  }
  private scheduleNextRound(): void {
    const sequence = this.playSequence;
    this.scheduleTimer("result", BETWEEN_ROUNDS_MS, () => void this.startRound(sequence));
  }

  private readonly retryPendingMutation = (): void => {
    if (this.pendingMutation && !this.persistenceBusy) {
      void this.runMutation(this.pendingMutation);
    }
  };

  private readonly retryLoad = (): void => {
    if (!this.persistenceBusy) {
      this.persistenceStatus = "진행도 불러오는 중";
      if (this.atBatRequestId) {
        void this.loadAtBat(this.playSequence);
      } else {
        void this.loadProgress(this.playSequence);
      }
    }
  };

  private updateSettings(settings: BaseballSettings): void {
    this.settings = settings;
    this.settingsStatus = saveBaseballSettings(this.preferenceScope, settings)
      ? t("platformClaw.baseball.saved")
      : t("platformClaw.baseball.unsaved");
  }

  private readonly openShop = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.shopOpen) {
      this.shopOpen = true;
      this.pauseGameTime();
      void this.updateComplete.then(() => focusBaseballShop(this));
    }
  };

  private readonly closeShop = (event?: Event): void => {
    event?.preventDefault();
    event?.stopPropagation();
    this.shopOpen = false;
    if (!this.pendingMutation) {
      if (
        !this.atBat &&
        this.phase === "ready" &&
        !this.persistenceBusy &&
        !(this.progress?.enhancement?.equipped && this.progress.enhancement.status === "broken")
      ) {
        void this.startRound(this.playSequence);
      }
      this.resumeGameTime();
    } else {
      this.pauseGameTime();
    }
    // Background receipt/storage settlement must not steal focus from an input.
    void this.updateComplete.then(
      () => event && this.querySelector<HTMLElement>('[role="application"]')?.focus(),
    );
  };

  private readonly handleResize = (): void => {
    if (this.active) {
      this.layoutStaticField();
      this.renderProjectile();
    }
  };

  private readonly handleVisibilityChange = (): void => {
    if (!this.active) {
      return;
    }
    if (document.hidden) {
      this.pauseGameTime();
    } else if (!this.shopOpen) {
      this.resumeGameTime();
    }
  };

  private showFeedback(): void {
    this.feedbackVisible = true;
    this.scheduleTimer("feedback", FEEDBACK_VISIBLE_MS, () => (this.feedbackVisible = false));
  }

  private scheduleTimer(key: TimerKey, delayMs: number, callback: () => void): void {
    this.clock.schedule(key, delayMs, callback, this.isPaused());
  }

  private pauseGameTime(): void {
    this.celebration.hide();
    this.stopAnimationLoop();
    this.clock.pause();
  }

  private resumeGameTime(): void {
    if (this.isPaused()) {
      return;
    }
    if (this.atBat && this.atBat.expiresAt <= Date.now() && !this.pendingMutation) {
      this.clock.clearAll();
      void this.startRound(this.playSequence);
      return;
    }
    this.clock.resume();
    this.lastFrameAt = this.now();
    this.ensureAnimationLoop();
  }

  private isPaused(): boolean {
    return this.shopOpen || document.hidden || this.pendingMutation !== null;
  }

  private ensureAnimationLoop(): void {
    if (!this.animationFrame && this.active && !this.isPaused()) {
      this.lastFrameAt = this.now();
      this.animationFrame = requestAnimationFrame(this.tick);
    }
  }

  private layoutStaticField(): void {
    layoutBaseballStaticField({
      arena: this.field.arena,
      fence: this.field.fence,
      host: this,
      leaderboard: this.field.leaderboard,
      outfielder: this.field.outfielder,
      outfielderX: this.battedBall?.outfielder.x ?? 55,
      pitcher: this.field.pitcher,
      player: this.field.player,
      score: this.field.score,
    });
  }

  private currentBallPoint(): BaseballPoint | null {
    if (this.phase === "pitch" && this.pitch) {
      return pitchPositionAt(this.pitch, this.pitchElapsedMs);
    }
    return this.phase === "in-play" && this.battedBall ? this.battedBall.ball : null;
  }

  private pushTrail(point: BaseballPoint): void {
    this.trail.push({ x: point.x, y: point.y });
    if (this.trail.length > BASEBALL_TRAIL_POINTS) {
      this.trail.shift();
    }
  }

  private renderProjectile(): void {
    renderBaseballProjectile({
      arena: this.field.arena,
      host: this,
      pitchProjection: this.phase === "pitch",
      point: this.currentBallPoint(),
      projectile: this.field.projectile,
      trail: this.trail,
      trailElements: this.field.trails,
      trailPointLimit: BASEBALL_TRAIL_POINTS,
    });
  }

  private finishGame(): void {
    this.playSequence += 1;
    this.resetRuntime();
    document.body.classList.remove("platformclaw-baseball-active");
    this.active = false;
    this.shopOpen = false;
    this.progress = null;
    this.leaderboard = null;
    this.leaderboardStatus = "";
    this.persistenceStatus = "";
    this.gameScreen = "closed";
    this.returnFocus?.focus();
  }

  private resetRuntime(): void {
    this.celebration.reset();
    this.resetWorkshop();
    this.stopAnimationLoop();
    this.clock.clearAll();
    this.input.reset();
    this.pendingMutation = null;
    this.resetPersistence();
    this.pitch = null;
    this.atBat = null;
    this.atBatRequestId = null;
    this.swingTimingDeltaMs = null;
    this.battedBall = null;
    this.trail = [];
    this.phase = "ready";
  }

  private stopAnimationLoop(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }
}

if (!customElements.get("platformclaw-easter-egg")) {
  customElements.define("platformclaw-easter-egg", PlatformClawEasterEgg);
}
