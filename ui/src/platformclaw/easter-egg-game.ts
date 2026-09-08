import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import {
  HIT_WINDOW_MS,
  classifyTimingDelta,
  classifyHitResult,
  distanceForTiming,
  formatHitResult,
  formatTimingFeedback,
  type HitResult,
  type TimingOutcome,
} from "./easter-egg-timing.ts";
import { PLATFORMCLAW_EASTER_EGG_EVENT } from "./easter-egg.ts";

const PITCH_SPEED = 360;
const PITCH_FLIGHT_GRAVITY = 8;
const BATTED_GRAVITY = 360;
const BATTED_MIN_SPEED = 360;
const BATTED_MAX_SPEED = 520;
const BATTED_MIN_LIFT = 300;
const BATTED_MAX_LIFT = 470;
const TRAJECTORY_POINTS = 160;
const BETWEEN_ROUNDS_MS = 650;
const MIN_WINDUP_DELAY_MS = 520;
const MAX_WINDUP_DELAY_MS = 820;
const LEG_LIFT_MS = 190;
const FOLLOW_THROUGH_MS = 250;
const SWING_ANIMATION_MS = 190;
const MAX_DISTANCE_M = 150;
const MIN_DISTANCE_M = 70;
const BASELINE_OFFSET_PX = 138;
const PROJECTILE_RADIUS_PX = 3;
const FEEDBACK_VISIBLE_MS = 1_100;
const BEST_STORAGE_KEY = "platformclaw.easter-egg.stickman-duel.best";

type DuelAnimationState =
  | "idle"
  | "leg-lift"
  | "throw"
  | "follow-through"
  | "swing"
  | "swing-perfect";
type DuelOutcome = TimingOutcome;
type DuelPoint = { x: number; y: number };

type DuelRound = {
  potentialDistanceM: number;
  targetX: number;
  idealContactTime: number | null;
  contactY: number;
  pitchStarted: boolean;
};

type Projectile = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  lastAt: number;
  batted: boolean;
  outcome?: DuelOutcome;
  timingDeltaMs?: number;
  distanceM?: number;
  trajectory: DuelPoint[];
};

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest(
      "input, textarea, select, button, a, [contenteditable], [role='button'], [role='link'], [role='menuitem'], [role='option'], [role='combobox']",
    ),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readBestDistance(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(BEST_STORAGE_KEY) ?? "0", 10);
    return Number.isFinite(value) ? clamp(value, 0, MAX_DISTANCE_M) : 0;
  } catch {
    return 0;
  }
}

function saveBestDistance(value: number): void {
  try {
    localStorage.setItem(BEST_STORAGE_KEY, String(value));
  } catch {
    // Private browsing may disable storage; the in-memory score still works.
  }
}

class PlatformClawEasterEgg extends OpenClawLightDomContentsElement {
  @state() private active = false;
  @state() private round = 0;
  @state() private hits = 0;
  @state() private homeRuns = 0;
  @state() private streak = 0;
  @state() private best = 0;
  @state() private result = "";
  @state() private lastDistance: number | null = null;
  @state() private lastHitResult: HitResult | null = null;
  @state() private feedbackVisible = false;
  @state() private playerState: DuelAnimationState = "idle";
  @state() private targetState: DuelAnimationState = "idle";

  private animationFrame = 0;
  private pitchTimer: ReturnType<typeof setTimeout> | null = null;
  private followThroughTimer: ReturnType<typeof setTimeout> | null = null;
  private batterTimer: ReturnType<typeof setTimeout> | null = null;
  private resultTimer: ReturnType<typeof setTimeout> | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private playSequence = 0;
  private currentRound: DuelRound | null = null;
  private projectile: Projectile | null = null;
  private arenaWidth = 640;
  private arenaHeight = 800;
  private pointerId: number | null = null;
  private arenaElement: HTMLElement | null = null;
  private playerElement: HTMLElement | null = null;
  private targetElement: HTMLElement | null = null;
  private projectileElement: HTMLElement | null = null;
  private trajectoryElement: SVGPolylineElement | null = null;

  private readonly handleTrigger = (): void => {
    if (this.active) {
      this.finishGame();
      return;
    }
    void this.startGame();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleGlobalKeydown, true);
    window.addEventListener("pointerdown", this.handleGlobalPointerDown, true);
    window.addEventListener("pointerup", this.handleGlobalPointerUp, true);
    window.addEventListener("pointercancel", this.handleGlobalPointerCancel, true);
    window.addEventListener("resize", this.handleResize);
    window.addEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, this.handleTrigger);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("keydown", this.handleGlobalKeydown, true);
    window.removeEventListener("pointerdown", this.handleGlobalPointerDown, true);
    window.removeEventListener("pointerup", this.handleGlobalPointerUp, true);
    window.removeEventListener("pointercancel", this.handleGlobalPointerCancel, true);
    window.removeEventListener("resize", this.handleResize);
    window.removeEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, this.handleTrigger);
    this.finishGame();
    super.disconnectedCallback();
  }

  override render() {
    if (!this.active) {
      return nothing;
    }
    const pitchInFlight = Boolean(this.projectile && !this.projectile.batted);
    const ballInPlay = Boolean(this.projectile?.batted);
    return html`
      <div
        class="platformclaw-easter-egg"
        role="application"
        tabindex="-1"
        aria-label="PlatformClaw Stickman Baseball"
        style="--platformclaw-easter-egg-baseline: ${BASELINE_OFFSET_PX}px"
        data-round=${this.round}
        data-streak=${this.streak}
        data-best=${this.best}
        data-player-state=${this.playerState}
        data-target-state=${this.targetState}
        data-pitch-state=${ballInPlay ? "in-play" : pitchInFlight ? "in-flight" : "ready"}
      >
        <div class="platformclaw-easter-egg__hud" aria-live="polite">
          <span>안타 ${this.hits}</span>
          <span>홈런 ${this.homeRuns}</span>
          <span>연속 ${this.streak}</span>
          <span>최고 ${this.best}m</span>
        </div>
        <div
          class="platformclaw-easter-egg__result platformclaw-easter-egg__feedback ${this
            .feedbackVisible
            ? ""
            : "platformclaw-easter-egg__feedback--faded"}"
          aria-live="assertive"
        >
          ${this.result}
        </div>
        ${this.lastDistance !== null
          ? html`<div
              class="platformclaw-easter-egg__distance platformclaw-easter-egg__feedback ${this
                .feedbackVisible
                ? ""
                : "platformclaw-easter-egg__feedback--faded"}"
            >
              ${this.lastHitResult ? `${formatHitResult(this.lastHitResult)} · ` : ""}${this
                .lastDistance}m
            </div>`
          : nothing}
        <div class="platformclaw-easter-egg__arena">
          <svg
            class="platformclaw-easter-egg__trajectory"
            viewBox="0 0 1000 1000"
            aria-hidden="true"
          >
            <polyline class="platformclaw-easter-egg__trajectory-line" points="" />
          </svg>
          <div
            class="platformclaw-easter-egg__player platformclaw-easter-egg__player--${this
              .playerState}"
            aria-hidden="true"
          >
            ${this.renderStickman()}
            <span class="platformclaw-easter-egg__bat"></span>
          </div>
          <div
            class="platformclaw-easter-egg__target platformclaw-easter-egg__target--${this
              .targetState}"
            aria-hidden="true"
          >
            ${this.renderStickman()}
          </div>
          <span
            class="platformclaw-easter-egg__projectile"
            aria-hidden="true"
            style="opacity: ${this.projectile ? 1 : 0}"
          ></span>
        </div>
      </div>
    `;
  }

  override updated(): void {
    // Lit replaces the transient projectile/trajectory nodes on round updates;
    // refresh the imperative handles before the next physics tick mutates them.
    if (this.active) {
      this.cacheElements();
      this.setProjectileVisibility(Boolean(this.projectile));
    }
  }

  private renderStickman() {
    return html`
      <svg viewBox="0 0 48 64" role="presentation" focusable="false">
        <circle cx="24" cy="10" r="6" fill="currentColor" />
        <path
          d="M24 17v20m0-14L12 30m12-7 12 7M24 37 13 54m11-17 14 14"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="3.5"
        />
      </svg>
    `;
  }

  private async startGame(): Promise<void> {
    const sequence = ++this.playSequence;
    this.stopAnimationLoop();
    this.clearPitchTimer();
    this.clearFollowThroughTimer();
    this.clearBatterTimer();
    this.clearFeedbackTimer();
    this.clearResultTimer();
    this.active = false;
    this.round = 0;
    this.hits = 0;
    this.homeRuns = 0;
    this.streak = 0;
    this.best = readBestDistance();
    this.result = "";
    this.lastDistance = null;
    this.lastHitResult = null;
    this.feedbackVisible = false;
    this.playerState = "idle";
    this.targetState = "idle";
    this.currentRound = null;
    this.projectile = null;
    await this.updateComplete;
    if (!this.isConnected || sequence !== this.playSequence) {
      return;
    }
    this.active = true;
    await this.updateComplete;
    this.cacheElements();
    this.startRound(sequence);
    this.animationFrame = requestAnimationFrame(this.tick);
    this.querySelector<HTMLElement>('[role="application"]')?.focus();
  }

  private startRound(sequence: number): void {
    if (!this.active || sequence !== this.playSequence) {
      return;
    }
    this.clearPitchTimer();
    this.clearFollowThroughTimer();
    this.clearBatterTimer();
    this.clearFeedbackTimer();
    this.round += 1;
    this.result = "";
    this.lastDistance = null;
    this.lastHitResult = null;
    this.feedbackVisible = false;
    this.playerState = "idle";
    this.targetState = "idle";
    this.projectile = null;
    this.setProjectileVisibility(false);
    this.clearTrajectory();
    this.currentRound = {
      potentialDistanceM: 120 + Math.floor(Math.random() * 31),
      targetX: 0,
      idealContactTime: null,
      contactY: 0,
      pitchStarted: false,
    };
    this.updateArenaLayout();
    const windupDelay =
      MIN_WINDUP_DELAY_MS + Math.random() * (MAX_WINDUP_DELAY_MS - MIN_WINDUP_DELAY_MS);
    this.pitchTimer = setTimeout(() => {
      this.pitchTimer = null;
      if (!this.active || sequence !== this.playSequence) {
        return;
      }
      this.targetState = "leg-lift";
      this.pitchTimer = setTimeout(() => {
        this.pitchTimer = null;
        this.launchPitch(sequence);
      }, LEG_LIFT_MS);
    }, windupDelay);
  }

  private readonly tick = (now: number): void => {
    if (!this.active) {
      this.animationFrame = 0;
      return;
    }
    if (this.projectile) {
      this.updateProjectile(now);
    }
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private launchPitch(sequence: number): void {
    if (!this.active || sequence !== this.playSequence || !this.currentRound || this.projectile) {
      return;
    }
    const now = performance.now();
    const launchX = this.currentRound.targetX - PROJECTILE_RADIUS_PX;
    const hitZoneX = this.getHitZoneX() - PROJECTILE_RADIUS_PX;
    const groundY = this.getGroundY();
    const launchY = Math.max(8, groundY - 40);
    // The bat is drawn about 20px above the visual baseline; keep the ball
    // center aligned to that sweet spot instead of a frame-dependent guess.
    const contactY = Math.max(8, groundY - 21);
    const flightSeconds = Math.max(0.001, (launchX - hitZoneX) / PITCH_SPEED);
    this.currentRound.pitchStarted = true;
    this.currentRound.contactY = contactY;
    this.currentRound.idealContactTime = now + flightSeconds * 1000;
    this.targetState = "throw";
    this.projectile = {
      x: launchX,
      y: launchY,
      vx: -PITCH_SPEED,
      vy: (contactY - launchY) / flightSeconds - 0.5 * PITCH_FLIGHT_GRAVITY * flightSeconds,
      lastAt: now,
      batted: false,
      trajectory: [{ x: launchX, y: launchY }],
    };
    this.setProjectileVisibility(true);
    this.setProjectilePosition(launchX, launchY);
    this.setTrajectory(this.projectile.trajectory);
    this.followThroughTimer = setTimeout(() => {
      this.followThroughTimer = null;
      if (this.active && sequence === this.playSequence) {
        this.targetState = "follow-through";
      }
    }, FOLLOW_THROUGH_MS);
  }

  private updateProjectile(now: number): void {
    const projectile = this.projectile;
    const round = this.currentRound;
    if (!projectile || !round) {
      return;
    }
    const deltaSeconds = Math.min(0.05, Math.max(0, (now - projectile.lastAt) / 1000));
    projectile.lastAt = now;
    projectile.vy += (projectile.batted ? BATTED_GRAVITY : PITCH_FLIGHT_GRAVITY) * deltaSeconds;
    projectile.x += projectile.vx * deltaSeconds;
    projectile.y += projectile.vy * deltaSeconds;
    projectile.trajectory.push({ x: projectile.x, y: projectile.y });
    if (projectile.trajectory.length > TRAJECTORY_POINTS) {
      projectile.trajectory.shift();
    }
    this.setProjectilePosition(projectile.x, projectile.y);
    this.setTrajectory(projectile.trajectory);

    if (!projectile.batted && round.idealContactTime !== null) {
      const timingDeltaMs = now - round.idealContactTime;
      if (timingDeltaMs > HIT_WINDOW_MS) {
        this.resolveAtBat("MISS", timingDeltaMs);
        return;
      }
    }
    if (projectile.batted) {
      const groundY = this.getGroundY();
      if (projectile.y >= groundY || projectile.x > this.arenaWidth + 24) {
        this.resolveAtBat(projectile.outcome ?? "MISS", projectile.timingDeltaMs);
      }
    }
  }

  private resolveAtBat(outcome: DuelOutcome, timingDeltaMs?: number): void {
    const projectile = this.projectile;
    const round = this.currentRound;
    if (!projectile || !round) {
      return;
    }
    this.projectile = null;
    this.setProjectileVisibility(false);
    this.clearBatterTimer();
    this.result =
      outcome === "MISS" && timingDeltaMs === undefined
        ? "MISS"
        : formatTimingFeedback(timingDeltaMs ?? 0, outcome);
    this.playerState = outcome === "MISS" ? "idle" : "follow-through";
    if (outcome === "MISS") {
      this.streak = 0;
      this.lastDistance = null;
      this.lastHitResult = null;
    } else {
      const distanceM = projectile.distanceM ?? round.potentialDistanceM;
      const hitResult = classifyHitResult(distanceM);
      this.lastDistance = distanceM;
      this.lastHitResult = hitResult;
      if (hitResult === "HOME_RUN") {
        this.homeRuns += 1;
      } else {
        this.hits += 1;
      }
      this.streak += 1;
      this.best = Math.max(this.best, distanceM);
      saveBestDistance(this.best);
    }
    this.showFeedback();
    const sequence = this.playSequence;
    this.resultTimer = setTimeout(() => {
      this.resultTimer = null;
      if (this.active && sequence === this.playSequence) {
        this.startRound(sequence);
      }
    }, BETWEEN_ROUNDS_MS);
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (!this.active || isInteractiveTarget(event.target)) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.finishGame();
      return;
    }
    if (event.code === "Space" && !event.repeat && !event.defaultPrevented) {
      this.swing(event);
    }
  };

  private readonly handleGlobalPointerDown = (event: PointerEvent): void => {
    if (!this.active || isInteractiveTarget(event.target) || !this.isWithinSwingZone(event)) {
      return;
    }
    this.pointerId = event.pointerId;
  };

  private readonly handleGlobalPointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    this.pointerId = null;
    if (!this.isWithinSwingZone(event)) {
      return;
    }
    this.swing(event);
  };

  private readonly handleGlobalPointerCancel = (event: PointerEvent): void => {
    if (this.pointerId === event.pointerId) {
      this.pointerId = null;
    }
  };

  private swing(event: Event): void {
    const projectile = this.projectile;
    const round = this.currentRound;
    if (!this.active || !projectile || projectile.batted || !round?.pitchStarted) {
      return;
    }
    if (isInteractiveTarget(event.target)) {
      return;
    }
    if (event instanceof KeyboardEvent) {
      event.preventDefault();
    }
    const idealContactTime = round.idealContactTime;
    if (idealContactTime === null) {
      return;
    }
    const timingDeltaMs = performance.now() - idealContactTime;
    const outcome = classifyTimingDelta(timingDeltaMs);
    this.result = formatTimingFeedback(timingDeltaMs, outcome);
    this.showFeedback();
    if (outcome === "MISS") {
      this.resolveAtBat(outcome, timingDeltaMs);
      return;
    }
    const distanceM = distanceForTiming(timingDeltaMs, round.potentialDistanceM, MIN_DISTANCE_M);
    const distanceRatio = clamp(
      (distanceM - MIN_DISTANCE_M) / Math.max(1, round.potentialDistanceM - MIN_DISTANCE_M),
      0,
      1,
    );
    projectile.batted = true;
    projectile.outcome = outcome;
    projectile.timingDeltaMs = timingDeltaMs;
    projectile.distanceM = distanceM;
    projectile.x = this.getHitZoneX() - PROJECTILE_RADIUS_PX;
    projectile.y = round.contactY;
    projectile.vx = BATTED_MIN_SPEED + distanceRatio * (BATTED_MAX_SPEED - BATTED_MIN_SPEED);
    projectile.vy = -(BATTED_MIN_LIFT + distanceRatio * (BATTED_MAX_LIFT - BATTED_MIN_LIFT));
    projectile.lastAt = performance.now();
    projectile.trajectory = [{ x: projectile.x, y: projectile.y }];
    this.playerState = outcome === "PERFECT" ? "swing-perfect" : "swing";
    this.setProjectilePosition(projectile.x, projectile.y);
    this.setTrajectory(projectile.trajectory);
    this.clearBatterTimer();
    this.batterTimer = setTimeout(() => {
      this.batterTimer = null;
      if (this.active && this.projectile?.batted) {
        this.playerState = "follow-through";
      }
    }, SWING_ANIMATION_MS);
  }

  private readonly handleResize = (): void => {
    if (this.active) {
      this.updateArenaLayout();
    }
  };

  private isWithinSwingZone(event: PointerEvent): boolean {
    if (event.clientY < window.innerHeight * 0.7) {
      return false;
    }
    const playerRect = this.playerElement?.getBoundingClientRect();
    if (!playerRect) {
      return false;
    }
    return event.clientX >= playerRect.left - 96 && event.clientX <= playerRect.right + 96;
  }

  private showFeedback(): void {
    this.feedbackVisible = true;
    this.clearFeedbackTimer();
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = null;
      if (this.active) {
        this.feedbackVisible = false;
      }
    }, FEEDBACK_VISIBLE_MS);
  }

  private updateArenaLayout(): void {
    if (!this.arenaElement) {
      return;
    }
    const rect = this.arenaElement.getBoundingClientRect();
    this.arenaWidth = rect.width || window.innerWidth || 640;
    this.arenaHeight = rect.height || window.innerHeight || 800;
    if (!this.currentRound) {
      return;
    }
    const shell = this.closest<HTMLElement>(".shell");
    const configuredNavWidth = Number.parseFloat(
      getComputedStyle(shell ?? this).getPropertyValue("--shell-nav-width"),
    );
    const navWidth = clamp(
      Number.isFinite(configuredNavWidth) && configuredNavWidth > 0 ? configuredNavWidth : 258,
      120,
      this.arenaWidth,
    );
    const playerX = clamp(navWidth * 0.3, 38, 94);
    this.currentRound.targetX = clamp(navWidth - 30, playerX + 70, this.arenaWidth - 22);
    if (this.targetElement) {
      this.targetElement.style.left = `${this.currentRound.targetX}px`;
    }
    if (this.playerElement) {
      this.playerElement.style.left = `${playerX}px`;
    }
  }

  private getGroundY(): number {
    return Math.max(24, this.arenaHeight - BASELINE_OFFSET_PX - 7);
  }

  private getHitZoneX(): number {
    const playerLeft = this.playerElement
      ? Number.parseFloat(this.playerElement.style.left)
      : this.arenaWidth * 0.06;
    return clamp((Number.isFinite(playerLeft) ? playerLeft : 38) + 26, 22, this.arenaWidth - 22);
  }

  private cacheElements(): void {
    this.arenaElement = this.querySelector<HTMLElement>(".platformclaw-easter-egg__arena");
    this.playerElement = this.querySelector<HTMLElement>(".platformclaw-easter-egg__player");
    this.targetElement = this.querySelector<HTMLElement>(".platformclaw-easter-egg__target");
    this.projectileElement = this.querySelector<HTMLElement>(
      ".platformclaw-easter-egg__projectile",
    );
    this.trajectoryElement = this.querySelector<SVGPolylineElement>(
      ".platformclaw-easter-egg__trajectory-line",
    );
  }

  private setProjectilePosition(x: number, y: number): void {
    this.projectileElement?.style.setProperty("transform", `translate3d(${x}px, ${y}px, 0)`);
  }

  private setProjectileVisibility(visible: boolean): void {
    if (this.projectileElement) {
      this.projectileElement.style.opacity = visible ? "1" : "0";
    }
  }

  private setTrajectory(points: DuelPoint[]): void {
    if (!this.trajectoryElement) {
      return;
    }
    this.trajectoryElement.setAttribute(
      "points",
      points
        .map(
          (point) => `${(point.x / this.arenaWidth) * 1000},${(point.y / this.arenaHeight) * 1000}`,
        )
        .join(" "),
    );
    this.trajectoryElement.style.opacity = "1";
  }

  private clearTrajectory(): void {
    if (!this.trajectoryElement) {
      return;
    }
    this.trajectoryElement.setAttribute("points", "");
    this.trajectoryElement.style.opacity = "0";
  }

  private finishGame(): void {
    this.stopAnimationLoop();
    this.clearPitchTimer();
    this.clearFollowThroughTimer();
    this.clearBatterTimer();
    this.clearResultTimer();
    this.clearFeedbackTimer();
    this.playSequence += 1;
    this.active = false;
    this.pointerId = null;
    this.projectile = null;
    this.currentRound = null;
    this.arenaElement = null;
    this.playerElement = null;
    this.targetElement = null;
    this.projectileElement = null;
    this.trajectoryElement = null;
  }

  private stopAnimationLoop(): void {
    if (this.animationFrame !== 0) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
  }

  private clearPitchTimer(): void {
    if (this.pitchTimer !== null) {
      clearTimeout(this.pitchTimer);
      this.pitchTimer = null;
    }
  }

  private clearFollowThroughTimer(): void {
    if (this.followThroughTimer !== null) {
      clearTimeout(this.followThroughTimer);
      this.followThroughTimer = null;
    }
  }

  private clearBatterTimer(): void {
    if (this.batterTimer !== null) {
      clearTimeout(this.batterTimer);
      this.batterTimer = null;
    }
  }

  private clearResultTimer(): void {
    if (this.resultTimer !== null) {
      clearTimeout(this.resultTimer);
      this.resultTimer = null;
    }
  }

  private clearFeedbackTimer(): void {
    if (this.feedbackTimer !== null) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
    }
  }
}

if (!customElements.get("platformclaw-easter-egg")) {
  customElements.define("platformclaw-easter-egg", PlatformClawEasterEgg);
}
