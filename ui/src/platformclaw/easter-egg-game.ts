import { property, state } from "lit/decorators.js";
import {
  BASEBALL_BATS,
  BASEBALL_RPC,
  type BaseballBatId,
  type BaseballLeaderboard,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../styles/platformclaw-easter-egg.css";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { PausableGameClock } from "./easter-egg-clock.ts";
import {
  baseballWorldScreenX,
  resolveBaseballFieldLayout,
  setBaseballWorldPosition,
} from "./easter-egg-layout.ts";
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
import { PLATFORMCLAW_EASTER_EGG_EVENT } from "./easter-egg.ts";

const BETWEEN_ROUNDS_MS = 650;
const MIN_WINDUP_DELAY_MS = 520;
const MAX_WINDUP_DELAY_MS = 820;
const LEG_LIFT_MS = 190;
const FOLLOW_THROUGH_MS = 250;
const SWING_ANIMATION_MS = 190;
const FEEDBACK_VISIBLE_MS = 1_100;

type AnimationState = "idle" | "leg-lift" | "throw" | "follow-through" | "swing" | "swing-perfect";
type GamePhase = "ready" | "pitch" | "in-play" | "result";
type TimerKey = "pitch" | "follow" | "batter" | "result" | "feedback";
type PendingMutation = {
  method: string;
  params: Record<string, unknown>;
  label: string;
  onSuccess?: () => void;
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "input, textarea, select, button, a, [contenteditable], [role='button'], [role='link'], [role='menuitem'], [role='option'], [role='combobox'], [role='dialog']",
      ),
    )
  );
}

function createRequestId(random: () => number): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `baseball-${Date.now()}-${random().toString(36).slice(2)}`
  );
}

class PlatformClawEasterEgg extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Test seams; production retains Math.random and performance.now. */
  @property({ attribute: false }) random: () => number = Math.random;
  @property({ attribute: false }) now: () => number = () => performance.now();

  @state() private active = false;
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
  @state() private progress: BaseballProgress | null = null;
  @state() private leaderboard: BaseballLeaderboard | null = null;
  @state() private leaderboardStatus = "";
  @state() private persistenceStatus = "";
  @state() private persistenceBusy = false;

  private animationFrame = 0;
  private playSequence = 0;
  private clientEpoch = 0;
  private leaderboardRequest = 0;
  private pitch: Pitch | null = null;
  private pitchElapsedMs = 0;
  private battedBall: BattedBallSimulation | null = null;
  private roundBatId: BaseballBatId = "wood";
  private lastFrameAt = 0;
  private pointerId: number | null = null;
  private pendingMutation: PendingMutation | null = null;
  private readonly clock = new PausableGameClock<TimerKey>(() => this.now());
  private arenaElement: HTMLElement | null = null;
  private playerElement: HTMLElement | null = null;
  private pitcherElement: HTMLElement | null = null;
  private outfielderElement: HTMLElement | null = null;
  private fenceElement: HTMLElement | null = null;
  private leaderboardElement: HTMLElement | null = null;
  private projectileElement: HTMLElement | null = null;
  private trailElements: HTMLElement[] = [];
  private trail: BaseballPoint[] = [];

  private readonly handleTrigger = (): void => {
    if (this.active) {
      this.finishGame();
    } else {
      void this.startGame();
    }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleGlobalKeydown, true);
    window.addEventListener("pointerdown", this.handleGlobalPointerDown, true);
    window.addEventListener("pointerup", this.handleGlobalPointerUp, true);
    window.addEventListener("pointercancel", this.handleGlobalPointerCancel, true);
    window.addEventListener("resize", this.handleResize);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, this.handleTrigger);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("keydown", this.handleGlobalKeydown, true);
    window.removeEventListener("pointerdown", this.handleGlobalPointerDown, true);
    window.removeEventListener("pointerup", this.handleGlobalPointerUp, true);
    window.removeEventListener("pointercancel", this.handleGlobalPointerCancel, true);
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, this.handleTrigger);
    this.finishGame();
    super.disconnectedCallback();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("client")) {
      this.clientEpoch += 1;
      this.pendingMutation = null;
      this.persistenceBusy = false;
      this.progress = null;
      this.leaderboard = null;
      this.leaderboardStatus = "";
      if (this.active) {
        this.persistenceStatus = this.client ? "진행도 다시 불러오는 중" : "진행 저장 불가";
        void this.loadProgress(this.playSequence);
      }
    }
    if (!this.active) {
      return;
    }
    this.cacheElements();
    this.layoutStaticField();
    this.renderProjectile();
  }

  override render() {
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
      pendingMutationMethod: this.pendingMutation?.method ?? null,
      roundBatId: this.roundBatId,
      pitchSpeedKph: this.pitch?.speedKph ?? null,
      onOpenShop: this.openShop,
      onRetry: this.retryPendingMutation,
      onCancel: this.dismissPendingMutation,
      onRetryLoad: this.retryLoad,
      onCloseShop: this.closeShop,
      onSelectBat: (batId, owned) => void this.selectBat(batId, owned),
      onStopEvent: this.stopEvent,
    });
  }

  private async startGame(): Promise<void> {
    const sequence = ++this.playSequence;
    this.resetRuntime();
    this.active = true;
    this.round = 0;
    this.hits = 0;
    this.homeRuns = 0;
    this.streak = 0;
    this.result = "";
    this.lastDistance = null;
    this.leaderboard = null;
    this.leaderboardStatus = "";
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
    this.persistenceBusy = true;
    try {
      const progress = await client.request<BaseballProgress>(BASEBALL_RPC.progress, {});
      if (!this.isCurrentRequest(client, epoch, sequence)) {
        return;
      }
      this.progress = progress;
      this.streak = progress.currentHomeRunStreak;
      this.persistenceStatus = "";
      this.startRound(sequence);
      void this.loadLeaderboard(sequence);
    } catch {
      if (this.isCurrentRequest(client, epoch, sequence)) {
        this.persistenceStatus = "진행 저장 불가";
      }
    } finally {
      if (this.isCurrentRequest(client, epoch, sequence)) {
        this.persistenceBusy = false;
      }
    }
  }

  private async loadLeaderboard(sequence: number): Promise<void> {
    const client = this.client;
    const epoch = this.clientEpoch;
    const request = ++this.leaderboardRequest;
    if (!client || !this.active || sequence !== this.playSequence) {
      return;
    }
    this.leaderboardStatus = "랭킹 불러오는 중";
    try {
      const leaderboard = await client.request<BaseballLeaderboard>(BASEBALL_RPC.leaderboard, {});
      if (!this.isCurrentRequest(client, epoch, sequence) || this.leaderboardRequest !== request) {
        return;
      }
      this.leaderboard = leaderboard;
      this.leaderboardStatus = "";
    } catch {
      if (this.isCurrentRequest(client, epoch, sequence) && this.leaderboardRequest === request) {
        this.leaderboardStatus = "랭킹 불러오기 실패";
      }
    }
  }

  private startRound(sequence: number): void {
    if (!this.active || sequence !== this.playSequence || !this.progress || this.pendingMutation) {
      return;
    }
    this.clearTimer("pitch");
    this.clearTimer("follow");
    this.clearTimer("batter");
    this.clearTimer("feedback");
    this.round += 1;
    this.phase = "ready";
    this.result = "";
    this.lastDistance = null;
    this.feedbackVisible = false;
    this.playerState = "idle";
    this.pitcherState = "idle";
    this.pitch = createPitch(this.random);
    this.pitchElapsedMs = 0;
    this.battedBall = null;
    this.roundBatId = this.progress.equippedBatId;
    this.trail = [];
    this.scheduleTimer("pitch", this.windupDelay(), () => {
      this.pitcherState = "leg-lift";
      this.scheduleTimer("pitch", LEG_LIFT_MS, () => this.launchPitch(sequence));
    });
    this.ensureAnimationLoop();
  }

  private launchPitch(sequence: number): void {
    if (!this.active || sequence !== this.playSequence || !this.pitch) {
      return;
    }
    this.phase = "pitch";
    this.pitchElapsedMs = 0;
    this.pitcherState = "throw";
    this.lastFrameAt = this.now();
    this.trail = [pitchPositionAt(this.pitch, 0)];
    this.renderProjectile();
    this.scheduleTimer("follow", FOLLOW_THROUGH_MS, () => (this.pitcherState = "follow-through"));
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
        this.outfielderElement,
        this.battedBall.outfielder.x,
        0,
        resolveBaseballFieldLayout(this, this.arenaElement),
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
      this.phase !== "pitch" ||
      !this.pitch ||
      isInteractiveTarget(event.target)
    ) {
      return;
    }
    if (event instanceof KeyboardEvent) {
      event.preventDefault();
    }
    const timingDeltaMs = this.pitchElapsedMs - this.pitch.idealContactTimeMs;
    const timing = classifyTimingDelta(timingDeltaMs);
    this.result = formatTimingFeedback(timingDeltaMs, timing);
    this.showFeedback();
    if (timing === "MISS") {
      this.resolveAtBat("miss");
      return;
    }
    const bat = BASEBALL_BATS.find((entry) => entry.id === this.roundBatId) ?? BASEBALL_BATS[0];
    this.battedBall = createBattedBall({ timingDeltaMs, batPower: bat.exitVelocityMultiplier });
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
    this.clearTimer("batter");
    this.playerState = outcome === "miss" ? "idle" : "follow-through";
    if (outcome === "home_run") {
      this.result = "홈런";
      this.homeRuns += 1;
      this.streak += 1;
      this.lastDistance = distanceM ?? null;
    } else if (outcome === "hit") {
      this.result = "안타";
      this.hits += 1;
      this.streak = 0;
      this.lastDistance = distanceM ?? null;
    } else if (outcome === "out") {
      this.result = "아웃";
      this.streak = 0;
      this.lastDistance = distanceM ?? null;
    } else {
      this.result = "MISS";
      this.streak = 0;
      this.lastDistance = null;
    }
    this.showFeedback();
    void this.runMutation({
      method: BASEBALL_RPC.plateAppearance,
      params: {
        requestId: createRequestId(this.random),
        outcome,
        ...(outcome === "hit" || outcome === "home_run" ? { distanceM } : {}),
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
      params: { requestId: createRequestId(this.random), batId },
      label: owned ? "배트 장착 실패" : "배트 구매 실패",
    });
  }

  private async runMutation(mutation: PendingMutation): Promise<void> {
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
      const response = await client.request<{ progress: BaseballProgress }>(
        mutation.method,
        mutation.params,
      );
      if (!this.isCurrentRequest(client, epoch, sequence)) {
        return;
      }
      if (!this.progress || response.progress.revision >= this.progress.revision) {
        this.progress = response.progress;
        this.streak = response.progress.currentHomeRunStreak;
      }
      this.pendingMutation = null;
      this.persistenceStatus = "";
      mutation.onSuccess?.();
      if (mutation.method === BASEBALL_RPC.plateAppearance) {
        void this.loadLeaderboard(sequence);
      }
    } catch {
      if (this.isCurrentRequest(client, epoch, sequence)) {
        this.persistenceStatus = mutation.label;
      }
    } finally {
      if (this.isCurrentRequest(client, epoch, sequence)) {
        this.persistenceBusy = false;
      }
    }
  }

  private scheduleNextRound(): void {
    const sequence = this.playSequence;
    this.scheduleTimer("result", BETWEEN_ROUNDS_MS, () => this.startRound(sequence));
  }

  private readonly retryPendingMutation = (): void => {
    if (this.pendingMutation && !this.persistenceBusy) {
      void this.runMutation(this.pendingMutation);
    }
  };

  private readonly dismissPendingMutation = (): void => {
    const wasAtBat = this.pendingMutation?.method === BASEBALL_RPC.plateAppearance;
    this.pendingMutation = null;
    this.persistenceStatus = "";
    if (wasAtBat) {
      this.scheduleNextRound();
    }
  };

  private readonly retryLoad = (): void => {
    if (!this.persistenceBusy) {
      this.persistenceStatus = "진행도 불러오는 중";
      void this.loadProgress(this.playSequence);
    }
  };

  private readonly openShop = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.shopOpen) {
      this.shopOpen = true;
      this.pauseGameTime();
    }
  };

  private readonly closeShop = (event?: Event): void => {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.shopOpen && !this.pendingMutation) {
      this.shopOpen = false;
      this.resumeGameTime();
      void this.updateComplete.then(() =>
        this.querySelector<HTMLElement>('[role="application"]')?.focus(),
      );
    }
  };

  private readonly stopEvent = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (!this.active) {
      return;
    }
    if (event.key === "Escape" && this.shopOpen) {
      this.closeShop(event);
      return;
    }
    if (isInteractiveTarget(event.target)) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.finishGame();
    } else if (event.code === "Space" && !event.repeat && !event.defaultPrevented) {
      this.swing(event);
    }
  };

  private readonly handleGlobalPointerDown = (event: PointerEvent): void => {
    if (
      !this.active ||
      this.shopOpen ||
      isInteractiveTarget(event.target) ||
      !this.isSwingZone(event)
    ) {
      return;
    }
    this.pointerId = event.pointerId;
  };

  private readonly handleGlobalPointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    this.pointerId = null;
    if (!this.shopOpen && this.isSwingZone(event)) {
      this.swing(event);
    }
  };

  private readonly handleGlobalPointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === event.pointerId) {
      this.pointerId = null;
    }
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

  private isSwingZone(event: PointerEvent): boolean {
    if (event.clientY < window.innerHeight * 0.7) {
      return false;
    }
    const rect = this.playerElement?.getBoundingClientRect();
    return Boolean(rect && event.clientX >= rect.left - 96 && event.clientX <= rect.right + 96);
  }

  private isCurrentRequest(client: GatewayBrowserClient, epoch: number, sequence: number): boolean {
    return this.client === client && this.clientEpoch === epoch && this.playSequence === sequence;
  }

  private showFeedback(): void {
    this.feedbackVisible = true;
    this.scheduleTimer("feedback", FEEDBACK_VISIBLE_MS, () => (this.feedbackVisible = false));
  }

  private windupDelay(): number {
    return MIN_WINDUP_DELAY_MS + this.random() * (MAX_WINDUP_DELAY_MS - MIN_WINDUP_DELAY_MS);
  }

  private scheduleTimer(key: TimerKey, delayMs: number, callback: () => void): void {
    this.clock.schedule(key, delayMs, callback, this.isPaused());
  }

  private clearTimer(key: TimerKey): void {
    this.clock.clear(key);
  }

  private pauseGameTime(): void {
    this.stopAnimationLoop();
    this.clock.pause();
  }

  private resumeGameTime(): void {
    if (this.isPaused()) {
      return;
    }
    this.clock.resume();
    this.lastFrameAt = this.now();
    this.ensureAnimationLoop();
  }

  private isPaused(): boolean {
    return this.shopOpen || document.hidden;
  }

  private ensureAnimationLoop(): void {
    if (!this.animationFrame && this.active && !this.isPaused()) {
      this.lastFrameAt = this.now();
      this.animationFrame = requestAnimationFrame(this.tick);
    }
  }

  private cacheElements(): void {
    this.arenaElement = this.querySelector<HTMLElement>(".platformclaw-easter-egg__arena");
    this.playerElement = this.querySelector<HTMLElement>(".platformclaw-easter-egg__player");
    this.pitcherElement = this.querySelector<HTMLElement>(".platformclaw-easter-egg__target");
    this.outfielderElement = this.querySelector<HTMLElement>(
      ".platformclaw-easter-egg__outfielder",
    );
    this.fenceElement = this.querySelector<HTMLElement>(".platformclaw-easter-egg__fence");
    this.leaderboardElement = this.querySelector<HTMLElement>(
      ".platformclaw-easter-egg__leaderboards",
    );
    this.projectileElement = this.querySelector<HTMLElement>(
      ".platformclaw-easter-egg__projectile",
    );
    this.trailElements = Array.from(
      this.querySelectorAll<HTMLElement>(".platformclaw-easter-egg__trail-dot"),
    );
  }

  private layoutStaticField(): void {
    const layout = resolveBaseballFieldLayout(this, this.arenaElement);
    setBaseballWorldPosition(this.playerElement, BASEBALL_WORLD.contactX, 0, layout);
    setBaseballWorldPosition(this.pitcherElement, BASEBALL_WORLD.pitcherX, 0, layout, 1, true);
    setBaseballWorldPosition(
      this.outfielderElement,
      this.battedBall?.outfielder.x ?? 55,
      0,
      layout,
    );
    this.style.setProperty("--platformclaw-baseball-ui-left", `${layout.uiLeft}px`);
    if (this.fenceElement) {
      const fenceX = baseballWorldScreenX(BASEBALL_WORLD.fenceX, layout);
      this.fenceElement.style.left = `${fenceX}px`;
      this.fenceElement.style.top = `${layout.groundY - BASEBALL_WORLD.fenceHeight * layout.scale}px`;
      this.fenceElement.style.height = `${BASEBALL_WORLD.fenceHeight * layout.scale}px`;
      if (this.leaderboardElement) {
        this.leaderboardElement.style.right = `${Math.max(8, layout.width - fenceX - 2)}px`;
        this.leaderboardElement.style.bottom = `${layout.height - layout.groundY + BASEBALL_WORLD.fenceHeight * layout.scale}px`;
      }
    }
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
    const point = this.currentBallPoint();
    const pitchProjection = this.phase === "pitch";
    const layout = resolveBaseballFieldLayout(this, this.arenaElement);
    if (this.projectileElement) {
      this.projectileElement.style.opacity = point ? "1" : "0";
      if (point) {
        setBaseballWorldPosition(
          this.projectileElement,
          point.x,
          point.y,
          layout,
          1,
          pitchProjection,
        );
      }
    }
    const points = this.trail.slice(-BASEBALL_TRAIL_POINTS);
    this.trailElements.forEach((element, index) => {
      const trailPoint = points[points.length - 1 - index];
      if (!trailPoint) {
        element.style.opacity = "0";
        return;
      }
      const age = index / Math.max(1, BASEBALL_TRAIL_POINTS - 1);
      element.style.opacity = String((1 - age) * 0.42);
      setBaseballWorldPosition(
        element,
        trailPoint.x,
        trailPoint.y,
        layout,
        0.92 - age * 0.28,
        pitchProjection,
      );
    });
  }

  private finishGame(): void {
    this.playSequence += 1;
    this.resetRuntime();
    this.active = false;
    this.shopOpen = false;
    this.progress = null;
    this.leaderboard = null;
    this.leaderboardStatus = "";
    this.persistenceStatus = "";
  }

  private resetRuntime(): void {
    this.stopAnimationLoop();
    this.clock.clearAll();
    this.pointerId = null;
    this.pendingMutation = null;
    this.persistenceBusy = false;
    this.pitch = null;
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
