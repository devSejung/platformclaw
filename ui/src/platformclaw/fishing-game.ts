import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html } from "lit";
import { property, state } from "lit/decorators.js";
import {
  FISHING_RPC,
  type FishingSnapshot,
  type FishingLeaderboard,
} from "../../../packages/platformclaw-control-plane/src/fishing-contracts.ts";
import { fishingFinishPosition } from "../../../packages/platformclaw-control-plane/src/fishing-simulation.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { generateUUID } from "../lib/uuid.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { resolveFishingPresentation } from "./fishing-presentation.ts";
import { FishingScene } from "./fishing-scene.ts";
import { renderFishing, type FishingPanel } from "./fishing-view.ts";
import { platformClawT as t } from "./i18n.ts";
import "../styles/platformclaw-fishing.css";

type PendingFishingMutation = { method: string; params: Record<string, unknown> };
const copy = (key: string) => t(`platformClaw.fishing.${key}`);

class PlatformClawFishing extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) preferenceScope: string | null = null;
  @state() private snapshot: FishingSnapshot | null = null;
  @state() private leaderboard: FishingLeaderboard | null = null;
  @state() private panel: FishingPanel | null = null;
  @state() private statusText = "";
  @state() private busy = false;
  @state() private pending: PendingFishingMutation | null = null;
  @state() private stale = true;
  @state() private opacity = 45;
  @state() private reducedMotion = false;
  @state() private newBest = false;
  private epoch = 0;
  private receivedAt = 0;
  private frame = 0;
  private lastUiAt = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scene = new FishingScene();
  private held = false;
  private readonly controlsHeld = new Set<string>();
  private motionQuery: MediaQueryList | null = null;
  private settlingAttempt: string | null = null;
  private refreshing: symbol | null = null;
  private messageVersion = 0;
  private snapshotMessageVersion = 0;

  private get message(): string {
    return this.statusText;
  }
  private set message(value: string) {
    this.messageVersion++;
    this.statusText = value;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("pointerup", this.release);
    window.addEventListener("keyup", this.globalKeyup);
    window.addEventListener("keydown", this.controlKeydown, true);
    this.motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = this.motionQuery.matches;
    this.motionQuery.addEventListener("change", this.motion);
    void this.updateComplete.then(() => this.focusPlay());
  }

  override disconnectedCallback(): void {
    this.controlsHeld.clear();
    this.epoch++;
    this.stop();
    document.removeEventListener("visibilitychange", this.visibility);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("pointerup", this.release);
    window.removeEventListener("keyup", this.globalKeyup);
    window.removeEventListener("keydown", this.controlKeydown, true);
    this.motionQuery?.removeEventListener("change", this.motion);
    super.disconnectedCallback();
  }

  override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("client") || changed.has("preferenceScope")) {
      this.epoch++;
      this.stop();
      this.snapshot = null;
      this.leaderboard = null;
      this.pending = null;
      this.busy = false;
      this.held = false;
      this.controlsHeld.clear();
      this.stale = true;
      this.newBest = false;
      this.panel = null;
      this.opacity = this.loadOpacity();
      this.settlingAttempt = null;
      this.refreshing = null;
      this.message = copy(this.client ? "loading" : "disconnected");
      this.snapshotMessageVersion = this.messageVersion;
      void this.refresh();
    }
    this.paint();
  }

  private get serverNow(): number {
    // Server time is projected with a monotonic clock for display only. Every
    // reward/input is timestamped again by the authenticated server owner.
    return this.snapshot
      ? this.snapshot.serverNow + Math.max(0, performance.now() - this.receivedAt)
      : 0;
  }

  private current(epoch: number, client: GatewayBrowserClient): boolean {
    return this.isConnected && this.epoch === epoch && this.client === client;
  }

  private accept(snapshot: FishingSnapshot): void {
    if (
      this.snapshot &&
      (snapshot.revision < this.snapshot.revision ||
        snapshot.walletRevision < this.snapshot.walletRevision ||
        snapshot.serverNow < this.snapshot.serverNow)
    ) {
      return;
    }
    const result = snapshot.attempt?.result;
    if (this.snapshot && result && result.id !== this.snapshot.attempt?.result?.id) {
      const old = this.snapshot.bestCatch;
      this.newBest =
        !old ||
        result.lengthCm > old.lengthCm ||
        (result.lengthCm === old.lengthCm && result.weightKg > old.weightKg);
    }
    this.snapshot = snapshot;
    this.receivedAt = performance.now();
    this.stale = false;
    this.start();
  }

  private async refresh(): Promise<void> {
    const client = this.client;
    if (
      !client ||
      this.busy ||
      this.pending ||
      this.refreshing ||
      document.hidden ||
      !this.isConnected
    ) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const epoch = this.epoch;
    const operation = Symbol();
    const statusVersion = this.messageVersion;
    const startingSnapshot = this.snapshot;
    this.refreshing = operation;
    try {
      const snapshot = await client.request<FishingSnapshot>(FISHING_RPC.snapshot, {});
      if (this.current(epoch, client)) {
        this.accept(snapshot);
        // Reads clear their own loading/connection notice. Mutation rejections
        // stay visible until the next action or an explicit refresh.
        if (
          this.messageVersion === statusVersion &&
          this.snapshotMessageVersion === statusVersion &&
          !this.pending &&
          !this.busy
        ) {
          this.message = "";
        }
      }
    } catch {
      if (this.current(epoch, client) && this.snapshot === startingSnapshot) {
        this.stale = true;
        if (this.messageVersion === statusVersion && !this.pending && !this.busy) {
          this.message = copy("loadFailed");
          this.snapshotMessageVersion = this.messageVersion;
        }
      }
    }
    if (this.refreshing === operation) {
      this.refreshing = null;
    }
    if (this.current(epoch, client) && !document.hidden) {
      this.pollTimer = setTimeout(
        () => void this.refresh(),
        this.snapshot?.attempt?.phase === "waiting" ||
          this.snapshot?.attempt?.phase === "fighting" ||
          this.snapshot?.attempt?.phase === "finishing"
          ? 1000
          : 10_000,
      );
    }
  }

  private async loadRanks(): Promise<void> {
    const client = this.client;
    const epoch = this.epoch;
    if (!client) {
      return;
    }
    try {
      const ranks = await client.request<FishingLeaderboard>(FISHING_RPC.leaderboard, {});
      if (this.current(epoch, client)) {
        this.leaderboard = ranks;
      }
    } catch {
      if (this.current(epoch, client)) {
        this.message = copy("loadFailed");
      }
    }
  }

  private async mutate(method: string, params: Record<string, unknown>): Promise<void> {
    if (this.busy || this.pending || this.stale || !this.client) {
      return;
    }
    this.pending = { method, params: { ...params, requestId: generateUUID() } };
    await this.retry();
  }

  private readonly retry = async (): Promise<void> => {
    const mutation = this.pending;
    const client = this.client;
    if (!mutation || !client || this.busy) {
      return;
    }
    const epoch = this.epoch;
    let accepted = false;
    this.busy = true;
    this.message = "";
    try {
      const snapshot = await client.request<FishingSnapshot>(mutation.method, mutation.params);
      if (!this.current(epoch, client) || this.pending !== mutation) {
        return;
      }
      this.accept(snapshot);
      accepted = true;
      this.pending = null;
      this.message = "";
    } catch (error) {
      if (!this.current(epoch, client) || this.pending !== mutation) {
        return;
      }
      const rejected =
        error instanceof GatewayRequestError &&
        isRecord(error.details) &&
        error.details.errorKind === "proxy-rejection" &&
        error.details.requestDisposition !== "outcome-unknown" &&
        ["INVALID_REQUEST", "FORBIDDEN", "UNAUTHENTICATED"].includes(error.code);
      if (rejected) {
        this.pending = null;
        this.held = false;
        this.message = error.message;
      } else {
        // Unknown transport outcomes retain the same nonce and payload; a retry
        // cannot issue a second catch or credit its reward twice.
        this.message = copy("unknown");
      }
    } finally {
      if (this.current(epoch, client)) {
        this.busy = false;
        if (!this.pending) {
          void this.refresh();
          // Drain a newer physical edge only after success. A confirmed
          // rejection must wait for a new gesture, rather than loop new nonces.
          if (accepted) this.pumpReel();
        }
      }
    }
  };

  private pumpReel(): void {
    const attempt = this.snapshot?.attempt;
    if (
      !this.pending &&
      !this.busy &&
      attempt?.phase === "fighting" &&
      (attempt.inputs.at(-1)?.held ?? false) !== this.held
    ) {
      void this.mutate(FISHING_RPC.reel, { attemptId: attempt.id, held: this.held });
    }
  }

  private readonly press = (): void => {
    const attempt = this.snapshot?.attempt;
    const phase = this.presentation().scene.phase;
    if (attempt?.phase === "waiting" && phase === "miss") {
      void this.refresh();
      return;
    }
    if (this.held || this.stale || ["prepare", "casting", "splash"].includes(phase)) {
      return;
    }
    if (attempt?.phase === "fighting") {
      // Preserve the latest physical hold while a previous edge is in flight;
      // dropping a quick release/press pair can otherwise leave the line slack.
      this.held = true;
      this.pumpReel();
      return;
    }
    if (this.pending || this.busy) {
      return;
    }
    this.held = true;
    if (attempt?.phase === "waiting") {
      void this.mutate(FISHING_RPC.hook, { attemptId: attempt.id });
    } else if (attempt?.phase === "finishing") {
      void this.mutate(FISHING_RPC.finish, { attemptId: attempt.id });
    } else {
      this.newBest = false;
      this.settlingAttempt = null;
      void this.mutate(FISHING_RPC.begin, {});
    }
  };

  private readonly release = (): void => {
    this.held = false;
    this.pumpReel();
  };
  private readonly globalKeyup = (event: KeyboardEvent): void => {
    if (event.key === "Control") {
      this.controlsHeld.delete(event.code);
      if (this.controlsHeld.size === 0) this.release();
    } else if (event.code === "Space" || event.code === "Enter") {
      this.release();
    }
  };
  private readonly controlKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Control") return;
    const held = this.controlsHeld.size > 0;
    this.controlsHeld.add(event.code);
    if (
      held ||
      event.repeat ||
      event.altKey ||
      event.metaKey ||
      event.defaultPrevented ||
      !(event.target instanceof Element) ||
      event.target.closest(
        "input, select, textarea, [contenteditable], button:not([data-fishing-action]), a, [role=dialog]",
      )
    )
      return;
    // Match baseball: every action begins on keydown; release only eases the line.
    this.press();
  };
  private focusPlay(): void {
    // This stable role=button surface keeps focus when the action is disabled.
    // Chat's document-capture Space handler also recognizes its activation semantics.
    this.querySelector<HTMLElement>("[data-fishing-surface]")?.focus({ preventScroll: true });
  }
  private readonly pointerdown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.focusPlay();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.press();
  };
  private readonly onPlayClick = (event: MouseEvent): void => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest("[data-fishing-action], [data-fishing-surface]")
    ) {
      return;
    }
    this.focusPlay();
    if (event.detail === 0) {
      this.press();
      this.release();
    }
  };
  private handlesPlayKey(event: KeyboardEvent): boolean {
    const target = event.target;
    return (
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      target instanceof Element &&
      !target.closest(
        "input, select, textarea, [contenteditable], button:not([data-fishing-action])",
      ) &&
      (event.code === "Space" ||
        (event.code === "Enter" && Boolean(target.closest("[data-fishing-surface]"))))
    );
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.exit("close");
      return;
    }
    if (this.handlesPlayKey(event)) {
      event.preventDefault();
      if (!event.repeat) {
        this.press();
      }
    }
  };
  private readonly keyup = (event: KeyboardEvent): void => {
    if (this.handlesPlayKey(event)) {
      event.preventDefault();
      this.release();
    }
  };

  private presentation() {
    return resolveFishingPresentation(this.snapshot, this.serverNow, this.held, this.reducedMotion);
  }

  private paint(): void {
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    if (canvas && !document.hidden) {
      this.scene.paint(canvas, this.presentation().scene);
    }
    const attempt = this.snapshot?.attempt;
    const cursor = this.querySelector<HTMLElement>("[data-fishing-finish-cursor]");
    if (cursor && attempt?.phase === "finishing" && attempt.finishStartedAt !== null) {
      // The timing marker paints at canvas cadence, not the slower text refresh.
      cursor.style.left = `${fishingFinishPosition(attempt.seed, this.serverNow - attempt.finishStartedAt) * 100}%`;
    }
  }
  private readonly tick = (now: number): void => {
    this.frame = 0;
    if (!this.isConnected || document.hidden) {
      return;
    }
    this.paint();
    if (now - this.lastUiAt > 100) {
      this.lastUiAt = now;
      this.requestUpdate();
      const attempt = this.snapshot?.attempt;
      const { scene, fight } = this.presentation();
      if (attempt?.phase === "waiting" && scene.phase === "miss") void this.refresh();
      if (attempt?.phase === "fighting" && fight && !this.busy && !this.pending && !this.stale) {
        if (fight.status !== "fighting" && this.settlingAttempt !== attempt.id) {
          this.settlingAttempt = attempt.id;
          this.held = false;
          void this.mutate(FISHING_RPC.settle, { attemptId: attempt.id });
        }
      }
    }
    this.frame = requestAnimationFrame(this.tick);
  };
  private start(): void {
    if (!this.frame && this.isConnected && !document.hidden) {
      this.frame = requestAnimationFrame(this.tick);
    }
  }
  private stop(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
  private readonly visibility = (): void => {
    this.stop();
    this.controlsHeld.clear();
    this.release();
    if (!document.hidden) {
      void this.refresh();
    }
  };
  private readonly onWindowBlur = (): void => {
    this.controlsHeld.clear();
    this.release();
  };
  private readonly motion = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
  };
  private exit(action: "games" | "close"): void {
    this.release();
    this.stop();
    this.dispatchEvent(
      new CustomEvent("fishing-exit", { detail: action, bubbles: true, composed: true }),
    );
  }
  private loadOpacity(): number {
    try {
      const value = this.preferenceScope
        ? Number(
            getSafeLocalStorage()?.getItem(`platformclaw.fishing.opacity:${this.preferenceScope}`),
          )
        : NaN;
      return Number.isInteger(value) && value >= 10 && value <= 100 && value % 5 === 0 ? value : 45;
    } catch {
      return 45;
    }
  }

  private setOpacity(value: number): void {
    if (!Number.isInteger(value) || value < 10 || value > 100 || value % 5 !== 0) return;
    this.opacity = value;
    try {
      if (this.preferenceScope)
        getSafeLocalStorage()?.setItem(
          `platformclaw.fishing.opacity:${this.preferenceScope}`,
          String(value),
        );
    } catch {
      /* Session rendering still applies when browser storage is unavailable. */
    }
  }

  override render() {
    const { scene, fight } = this.presentation();
    return html`${renderFishing({
      snapshot: this.snapshot,
      leaderboard: this.leaderboard,
      panel: this.panel,
      phase: scene.phase,
      fight,
      busy: this.busy,
      pending: Boolean(this.pending),
      stale: this.stale,
      message: this.message,
      now: this.serverNow,
      opacity: this.opacity,
      newBest: this.newBest,
      onGames: () => this.exit("games"),
      onClose: () => this.exit("close"),
      onRelease: this.release,
      onPointerdown: this.pointerdown,
      onClick: this.onPlayClick,
      onKeydown: this.keydown,
      onKeyup: this.keyup,
      onPanel: (panel) => {
        this.panel = this.panel === panel ? null : panel;
        if (this.panel === "ranking") {
          void this.loadRanks();
        }
      },
      onOpacity: (value) => this.setOpacity(value),
      onRefresh: () => {
        this.message = "";
        void this.refresh();
        if (this.panel === "ranking") {
          void this.loadRanks();
        }
      },
      onRetry: () => void this.retry(),
    })}`;
  }
}

if (!customElements.get("platformclaw-fishing")) {
  customElements.define("platformclaw-fishing", PlatformClawFishing);
}
