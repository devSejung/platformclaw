import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  HORSE_RACING_RPC,
  HORSE_RACING_MIN_BET_GOLD,
  HORSE_RACING_MAX_BET_GOLD,
  type HorseBetMarket,
  type HorseBetRequest,
  type HorseBetResult,
  type HorseRacingSnapshot,
  type HorseRaceSnapshot,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { generateUUID } from "../lib/uuid.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "../styles/platformclaw-horse-racing.css";
import "../styles/platformclaw-horse-racing-perimeter.css";
import "../styles/platformclaw-horse-racing-betting.css";
import { HorseRacingCelebration, type RacingWinReaction } from "./horse-racing-celebration.ts";
import { paintHorsePerimeter, renderHorsePerimeter } from "./horse-racing-perimeter-view.ts";
import { horseRaceBoosts } from "./horse-racing-perimeter.ts";
import { verifyHorseRace } from "./horse-racing-verification.ts";
import { renderHorseRacing } from "./horse-racing-view.ts";
import { platformClawT as t } from "./i18n.ts";

function rejectedRacingMutation(error: unknown): error is GatewayRequestError {
  return (
    error instanceof GatewayRequestError &&
    isRecord(error.details) &&
    error.details.errorKind === "proxy-rejection" &&
    error.details.requestDisposition !== "outcome-unknown" &&
    ["INVALID_REQUEST", "FORBIDDEN", "UNAUTHENTICATED"].includes(error.code)
  );
}

/** One mounted spectator owns its polling; server snapshots alone own money and race positions. */
class PlatformClawHorseRacing extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) preferenceScope: string | null = null;
  @state() private snapshot: HorseRacingSnapshot | null = null;
  @state() private market: HorseBetMarket = "win";
  @state() private selection: string[] = [];
  @state() private amount = HORSE_RACING_MIN_BET_GOLD;
  @state() private message = "";
  @state() private stale = true;
  @state() private busy = false;
  @state() private pending: HorseBetRequest | null = null;
  @state() private pendingCancel: { betId: string; raceId: string } | null = null;
  @state() private muted = true;
  @state() private reducedMotion = false;
  @state() private viewingRaceId: string | null = null;
  @state() private verification = "";
  @state() private presentation: "compact" | "expanded" | "collapsed" = "compact";
  @state() private closed = false;
  @state() private reaction: RacingWinReaction | null = null;
  private reactionExpiresAt = 0;
  private readonly celebration = new HorseRacingCelebration();
  private epoch = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private receivedAt = 0;
  private sound: AudioContext | null = null;
  private motionQuery: MediaQueryList | null = null;
  @state() private viewportWidth = window.innerWidth;
  @state() private viewportHeight = window.innerHeight;
  private displayedPositions = new Map<string, number>();
  private boostedHorses: ReadonlySet<string> = new Set();
  private motionFrame = 0;
  private tween: { startsAt: number; from: Map<string, number>; to: Map<string, number> } | null =
    null;

  override connectedCallback(): void {
    super.connectedCallback();
    if (window.innerWidth < 1000) {
      this.presentation = "collapsed";
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("keydown", this.onKeydown, true);
    window.addEventListener("resize", this.onResize);
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = this.motionQuery.matches;
    this.motionQuery.addEventListener("change", this.onMotion);
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>("[data-racing-close]")?.focus(),
    );
  }

  override disconnectedCallback(): void {
    this.stop();
    this.clearRailLayout();
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("keydown", this.onKeydown, true);
    window.removeEventListener("resize", this.onResize);
    this.motionQuery?.removeEventListener("change", this.onMotion);
    void this.sound?.close();
    this.sound = null;
    super.disconnectedCallback();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (this.closed) {
      this.clearRailLayout();
      return;
    }
    if (changed.has("client") || changed.has("preferenceScope")) {
      this.stop();
      this.celebration.reset();
      this.reaction = null;
      this.snapshot = null;
      this.selection = [];
      this.pending = null;
      this.pendingCancel = null;
      this.busy = false;
      this.viewingRaceId = null;
      this.stale = true;
      this.message = this.client
        ? t("platformClaw.racing.loading")
        : t("platformClaw.racing.disconnected");
      if (!this.client) {
        this.presentation = "collapsed";
      }
      this.resume();
    }
    this.syncRailLayout();
    this.paintPerimeter();
  }

  private get serverNow(): number {
    return this.snapshot
      ? this.snapshot.serverNow + Math.max(0, Date.now() - this.receivedAt)
      : Date.now();
  }

  private get pendingCancelId(): string | null {
    return this.pendingCancel?.betId ?? null;
  }

  override render() {
    if (this.closed) {
      return nothing;
    }
    const panel = renderHorseRacing({
      snapshot: this.snapshot,
      reaction: this.reaction,
      now: this.serverNow,
      market: this.market,
      selection: this.selection,
      amount: this.amount,
      message: this.message,
      busy: this.busy,
      stale: this.stale,
      pending: this.pending !== null,
      pendingCancelId: this.pendingCancelId,
      onCancel: (betId) => void this.cancelBet(betId),
      muted: this.muted,
      reducedMotion: this.reducedMotion,
      historical: this.viewingRaceId !== null,
      verification: this.verification,
      presentation: this.presentation,
      onPresentation: (presentation) => this.setPresentation(presentation),
      onVerify: () => void this.verify(),
      onExit: (action) => this.exit(action),
      onMarket: (market) => {
        this.market = market;
        this.selection = [];
      },
      onSelect: (id) => this.select(id),
      onAmount: (amount) => {
        this.amount = amount;
      },
      onBet: () => void this.bet(),
      onRefresh: () => {
        this.stop();
        this.resume();
      },
      onHistory: (id) => this.showRace(id),
      onMute: () => this.toggleSound(),
      onMotion: () => {
        this.setReducedMotion(!this.reducedMotion);
      },
    });
    return html`${renderHorsePerimeter(
      this.snapshot?.race ?? null,
      this.viewportWidth,
      this.viewportHeight,
      this.displayedPositions,
      this.stale,
      this.reducedMotion,
      this.boostedHorses,
    )}${panel}`;
  }

  private exit(action: "games" | "baseball" | "close"): void {
    if (this.closed) {
      return;
    }
    // Exit ends this mounted spectator. Late updates and visibility events cannot reopen its private session.
    this.closed = true;
    this.stop();
    this.clearRailLayout();
    this.dispatchEvent(
      new CustomEvent("racing-exit", { detail: action, bubbles: true, composed: true }),
    );
  }

  private setPresentation(presentation: "compact" | "expanded" | "collapsed"): void {
    const wasCollapsed = this.presentation === "collapsed";
    this.presentation = presentation;
    this.syncRailLayout();
    if (wasCollapsed || presentation === "collapsed") {
      void this.updateComplete.then(() =>
        this.querySelector<HTMLElement>("[data-racing-restore], [data-racing-collapse]")?.focus(),
      );
    }
  }

  private select(id: string): void {
    if (this.pending || this.pendingCancelId) {
      return;
    }
    if (this.market === "win") {
      this.selection = [id];
      return;
    }
    this.selection = this.selection.includes(id)
      ? this.selection.filter((entry) => entry !== id)
      : [...this.selection.slice(-1), id].toSorted();
  }

  private showRace(id: string | null): void {
    if (this.pending || this.pendingCancelId || this.busy) {
      return;
    }
    this.stop();
    if (this.snapshot) {
      this.celebration.observe(this.snapshot, true);
    }
    this.reaction = null;
    this.viewingRaceId = id;
    this.selection = [];
    this.snapshot = null;
    this.stale = true;
    this.message = t("platformClaw.racing.loading");
    this.resume();
  }

  private canPoll(): boolean {
    return !this.closed && this.isConnected && Boolean(this.client) && !document.hidden;
  }

  private stop(): void {
    // A hidden, closed or replaced account cannot receive old private snapshots.
    this.epoch += 1;
    this.busy = false;
    this.stopMotion();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private resume(): void {
    if (!this.canPoll()) {
      return;
    }
    const epoch = this.epoch;
    this.clockTimer = setInterval(() => {
      if (this.reaction && Date.now() >= this.reactionExpiresAt) {
        this.reaction = null;
      }
      this.requestUpdate();
      this.playHoofbeat();
    }, 250);
    void this.poll(epoch);
  }

  private current(epoch: number, client: GatewayBrowserClient): boolean {
    return this.canPoll() && this.epoch === epoch && this.client === client;
  }

  private accept(snapshot: HorseRacingSnapshot): void {
    // Mutation replies may arrive behind polling. Never move the shared wallet or race clock backwards.
    if (
      this.snapshot &&
      (snapshot.serverNow < this.snapshot.serverNow ||
        snapshot.walletRevision < this.snapshot.walletRevision)
    ) {
      return;
    }
    if (snapshot.race?.id !== this.snapshot?.race?.id) {
      this.selection = [];
      this.verification = "";
    }
    this.prepareMotion(snapshot.race);
    this.boostedHorses =
      this.stale || this.reducedMotion ? new Set() : horseRaceBoosts(this.snapshot, snapshot);
    const reaction = this.celebration.observe(snapshot, this.viewingRaceId !== null);
    if (reaction) {
      this.reaction = reaction;
      this.reactionExpiresAt = Date.now() + 6_000;
    }
    const cancellation = this.pendingCancel;
    const receipt =
      cancellation && snapshot.race?.id === cancellation.raceId
        ? snapshot.race.myBets.find((bet) => bet.id === cancellation.betId)
        : undefined;
    if (receipt && (receipt.cancelledAt !== null || receipt.payout !== null)) {
      this.pendingCancel = null;
      this.message = t(
        receipt.cancelledAt !== null
          ? "platformClaw.racing.cancelAccepted"
          : "platformClaw.racing.cancelSettled",
      );
    }
    const phase = snapshot.race?.status;
    const phaseChanged = phase !== this.snapshot?.race?.status;
    this.snapshot = snapshot;
    this.receivedAt = Date.now();
    this.stale = false;
    if (phaseChanged && (phase === "racing" || phase === "settled")) {
      const epoch = this.epoch;
      const raceId = snapshot.race?.id;
      // Bring the new live order/result into view once; ordinary snapshots must preserve reader scroll.
      void this.updateComplete.then(() => {
        if (
          !this.closed &&
          this.epoch === epoch &&
          this.snapshot?.race?.id === raceId &&
          this.snapshot?.race?.status === phase
        ) {
          const panel = this.querySelector<HTMLElement>(".platformclaw-racing");
          if (panel) {
            panel.scrollTop = 0;
          }
        }
      });
    }
  }

  private stopMotion(): void {
    if (this.motionFrame) {
      cancelAnimationFrame(this.motionFrame);
      this.motionFrame = 0;
    }
    this.tween = null;
    this.boostedHorses = new Set();
    this.paintPerimeter();
  }

  private prepareMotion(race: HorseRaceSnapshot | null): void {
    const previousRaceId = this.snapshot?.race?.id;
    const target = new Map(race?.positions.map((entry) => [entry.horseId, entry.position]));
    this.stopMotion();
    if (!race || race.status !== "racing" || race.id !== previousRaceId || this.reducedMotion) {
      this.displayedPositions = target;
      return;
    }
    // One snapshot behind: interpolate already observed progress, never predict the next position or winner.
    this.tween = {
      startsAt: performance.now(),
      from: new Map(this.displayedPositions),
      to: target,
    };
    this.motionFrame = requestAnimationFrame(this.animatePerimeter);
  }

  private readonly animatePerimeter = (now: number): void => {
    this.motionFrame = 0;
    const tween = this.tween;
    if (!tween || !this.canPoll()) {
      return;
    }
    const fraction = Math.max(0, Math.min(1, (now - tween.startsAt) / 1_000));
    for (const [id, target] of tween.to) {
      const from = tween.from.get(id) ?? target;
      this.displayedPositions.set(id, from + (target - from) * fraction);
    }
    this.paintPerimeter();
    if (fraction < 1) {
      this.motionFrame = requestAnimationFrame(this.animatePerimeter);
    } else {
      this.tween = null;
    }
  };

  private paintPerimeter(): void {
    paintHorsePerimeter(
      this,
      this.snapshot?.race ?? null,
      this.viewportWidth,
      this.viewportHeight,
      this.displayedPositions,
      this.boostedHorses,
    );
  }

  private readonly onResize = (): void => {
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.innerHeight;
    if (this.viewportWidth < 1000) {
      this.presentation = "collapsed";
    }
    this.syncRailLayout();
    this.paintPerimeter();
  };

  private clearRailLayout(): void {
    document.body.classList.remove(
      "platformclaw-racing-rail",
      "platformclaw-racing-rail--expanded",
      "platformclaw-racing-rail--minimized",
    );
  }

  private syncRailLayout(): void {
    const active = this.canPoll() && this.viewportWidth >= 1000;
    // Reserve real shell space, as the existing operator panels do, so no chat text sits under game controls.
    document.body.classList.toggle("platformclaw-racing-rail", active);
    document.body.classList.toggle(
      "platformclaw-racing-rail--expanded",
      active && this.presentation === "expanded" && this.viewportWidth >= 1280,
    );
    document.body.classList.toggle(
      "platformclaw-racing-rail--minimized",
      active && this.presentation === "collapsed",
    );
  }

  private setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      this.stopMotion();
      this.displayedPositions = new Map(
        this.snapshot?.race?.positions.map((entry) => [entry.horseId, entry.position]),
      );
      this.paintPerimeter();
    }
  }

  private async verify(): Promise<void> {
    const race = this.snapshot?.race;
    const epoch = this.epoch;
    if (!race?.revealedSeed) {
      return;
    }
    this.verification = t("platformClaw.racing.verifying");
    try {
      const valid = await verifyHorseRace(race);
      if (this.epoch === epoch && this.snapshot?.race?.id === race.id) {
        this.verification = t(
          valid ? "platformClaw.racing.verified" : "platformClaw.racing.verificationFailed",
        );
      }
    } catch {
      if (this.epoch === epoch) {
        this.verification = t("platformClaw.racing.verificationUnavailable");
      }
    }
  }

  private async poll(epoch: number): Promise<void> {
    const client = this.client;
    if (!client || !this.current(epoch, client)) {
      return;
    }
    try {
      // An ambiguous cancellation keeps its original race reachable across hidden tabs and hourly rollover.
      const raceId = this.pendingCancel?.raceId ?? this.viewingRaceId;
      const snapshot = await client.request<HorseRacingSnapshot>(
        HORSE_RACING_RPC.snapshot,
        raceId ? { raceId } : {},
      );
      if (!this.current(epoch, client)) {
        return;
      }
      const wasCancelling = this.pendingCancel !== null;
      this.accept(snapshot);
      if (!wasCancelling && !this.pending && !this.pendingCancelId && !this.busy) {
        this.message = "";
      }
    } catch {
      if (this.current(epoch, client)) {
        this.stopMotion();
        this.stale = true;
        this.message = t("platformClaw.racing.loadFailed");
      }
    } finally {
      if (this.current(epoch, client)) {
        this.pollTimer = setTimeout(() => void this.poll(epoch), 1_000);
      }
    }
  }

  private async bet(): Promise<void> {
    const client = this.client;
    const race = this.snapshot?.race;
    if (!client || !race || this.busy || this.pendingCancelId || this.stale || !this.canPoll()) {
      return;
    }
    if (!this.pending) {
      const valid =
        race.status === "betting" &&
        this.serverNow < race.closesAt &&
        this.selection.length === (this.market === "win" ? 1 : 2) &&
        Number.isSafeInteger(this.amount) &&
        this.amount >= HORSE_RACING_MIN_BET_GOLD &&
        this.amount <= HORSE_RACING_MAX_BET_GOLD &&
        this.amount <= (this.snapshot?.gold ?? 0);
      if (!valid) {
        this.message = t("platformClaw.racing.invalidBet");
        return;
      }
      try {
        this.pending = {
          requestId: generateUUID(),
          raceId: race.id,
          market: this.market,
          selection: [...this.selection],
          amount: this.amount,
        };
      } catch {
        this.message = t("platformClaw.racing.cryptoRequired");
        return;
      }
    }
    const request = this.pending;
    const epoch = this.epoch;
    this.busy = true;
    this.message = t("platformClaw.racing.sending");
    try {
      const result = await client.request<HorseBetResult>(HORSE_RACING_RPC.bet, request);
      if (!this.current(epoch, client)) {
        return;
      }
      this.accept(result.snapshot);
      this.pending = null;
      this.message = t("platformClaw.racing.accepted", { amount: String(result.receipt.amount) });
    } catch (error) {
      if (this.current(epoch, client)) {
        if (rejectedRacingMutation(error)) {
          this.pending = null;
          this.message = t("platformClaw.racing.rejected", { reason: error.message });
        } else {
          this.message = t("platformClaw.racing.betFailed");
        }
      }
    } finally {
      if (this.current(epoch, client)) {
        this.busy = false;
      }
    }
  }

  private async cancelBet(betId: string): Promise<void> {
    const client = this.client;
    const race = this.snapshot?.race;
    if (!client || !race || this.busy || this.pending || this.stale || !this.canPoll()) {
      return;
    }
    if (this.pendingCancelId && this.pendingCancelId !== betId) {
      return;
    }
    const receipt = race.myBets.find((bet) => bet.id === betId);
    if (!receipt) {
      return;
    }
    if (
      !this.pendingCancelId &&
      (race.status !== "betting" ||
        this.serverNow >= race.closesAt ||
        receipt.cancelledAt !== null ||
        receipt.payout !== null)
    ) {
      return;
    }
    const epoch = this.epoch;
    this.pendingCancel ??= { betId, raceId: race.id };
    this.busy = true;
    this.message = t("platformClaw.racing.cancelling");
    try {
      const result = await client.request<HorseBetResult>(HORSE_RACING_RPC.cancel, { betId });
      if (!this.current(epoch, client)) {
        return;
      }
      this.accept(result.snapshot);
      this.pendingCancel = null;
      this.message = t("platformClaw.racing.cancelAccepted");
    } catch (error) {
      if (!this.current(epoch, client) || this.pendingCancelId !== betId) {
        return;
      }
      if (rejectedRacingMutation(error)) {
        this.pendingCancel = null;
        this.message = t("platformClaw.racing.cancelRejected", { reason: error.message });
      } else {
        this.message = t("platformClaw.racing.cancelUnknown");
      }
    } finally {
      if (this.current(epoch, client)) {
        this.busy = false;
      }
    }
  }

  private readonly onVisibility = (): void => {
    if (this.closed) {
      return;
    }
    this.stop();
    this.busy = false;
    this.stale = true;
    this.syncRailLayout();
    this.resume();
  };

  private readonly onMotion = (event: MediaQueryListEvent): void => {
    this.setReducedMotion(event.matches);
  };

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (!this.closed && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.exit("close");
    }
  };

  private toggleSound(): void {
    this.muted = !this.muted;
    if (!this.muted) {
      try {
        this.sound ??= new AudioContext();
        void this.sound.resume();
      } catch {
        this.muted = true;
        this.message = t("platformClaw.racing.soundUnavailable");
      }
    }
  }

  private playHoofbeat(): void {
    if (
      this.muted ||
      this.presentation === "collapsed" ||
      !this.sound ||
      this.stale ||
      this.snapshot?.race?.status !== "racing" ||
      document.hidden
    ) {
      return;
    }
    const oscillator = this.sound.createOscillator();
    const gain = this.sound.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(100, this.sound.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(35, this.sound.currentTime + 0.08);
    gain.gain.setValueAtTime(0.035, this.sound.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.sound.currentTime + 0.09);
    oscillator.connect(gain);
    gain.connect(this.sound.destination);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
    oscillator.start();
    oscillator.stop(this.sound.currentTime + 0.1);
  }
}

if (!customElements.get("platformclaw-horse-racing")) {
  customElements.define("platformclaw-horse-racing", PlatformClawHorseRacing);
}
