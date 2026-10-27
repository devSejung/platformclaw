import { html, nothing } from "lit";
import type {
  FishingLeaderboard,
  FishingSnapshot,
  FishingFight,
} from "../../../packages/platformclaw-control-plane/src/fishing-contracts.ts";
import { getFishingSpecies } from "../../../packages/platformclaw-control-plane/src/fishing-economy.ts";
import type { FishingScenePhase } from "./fishing-scene.ts";
import { platformClawT as t } from "./i18n.ts";

export type FishingPanel = "ranking" | "records";
type FishingView = {
  snapshot: FishingSnapshot | null;
  leaderboard: FishingLeaderboard | null;
  panel: FishingPanel | null;
  phase: FishingScenePhase;
  fight: FishingFight | null;
  busy: boolean;
  pending: boolean;
  stale: boolean;
  message: string;
  now: number;
  opacity: number;
  newBest: boolean;
  onGames: () => void;
  onClose: () => void;
  onRelease: () => void;
  onPointerdown: (event: PointerEvent) => void;
  onClick: (event: MouseEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
  onKeyup: (event: KeyboardEvent) => void;
  onPanel: (panel: FishingPanel) => void;
  onOpacity: (opacity: number) => void;
  onRefresh: () => void;
  onRetry: () => void;
};
const copy = (key: string, params?: Record<string, string>) =>
  t(`platformClaw.fishing.${key}`, params);
const number = (value: number) => value.toLocaleString();

function renderPanel(view: FishingView) {
  const snapshot = view.snapshot;
  if (!snapshot) {
    return nothing;
  }
  if (view.panel === "ranking") {
    return html`<button @click=${view.onRefresh} ?disabled=${view.busy}>${copy("refresh")}</button>
      ${view.leaderboard
        ? (["catches", "earnedGold"] as const).map(
            (category) => html`
              <h3>${copy(category === "catches" ? "catchRanking" : "goldRanking")}</h3>
              ${view.leaderboard![category].length
                ? html`<ol>
                    ${view.leaderboard![category].map(
                      (entry) => html`
                        <li class=${entry.isCurrentUser ? "platformclaw-fishing__mine" : ""}>
                          ${entry.displayName} · ${number(entry.value)}
                        </li>
                      `,
                    )}
                  </ol>`
                : html`<p>${copy("noRanks")}</p>`}
            `,
          )
        : html`<p>${copy("loading")}</p>`}`;
  }
  const best = snapshot.bestCatch;
  return html`<p>
      ${copy("caught", { count: number(snapshot.totalCaught) })} ·
      ${copy("earned", { gold: number(snapshot.totalEarnedGold) })}
    </p>
    ${best
      ? html`<p>
          ${copy("best")} · ${getFishingSpecies(best.fishId).nameKo} ${best.lengthCm} cm ·
          ${best.weightKg} kg
        </p>`
      : nothing}
    <p>
      ${copy("daily", { count: number(snapshot.goals.dailyCaught) })} ·
      ${copy("weekly", { count: number(snapshot.goals.weeklyCaught) })}
    </p>`;
}

export function renderFishing(view: FishingView) {
  const snapshot = view.snapshot;
  const attempt = snapshot?.attempt;
  const reeling = attempt?.phase === "fighting";
  const expiredBite = attempt?.phase === "waiting" && view.phase === "miss";
  const finishing = attempt?.phase === "finishing" && view.phase === "finishing";
  const expiredFinish = attempt?.phase === "finishing" && !finishing;
  const disabled =
    expiredBite ||
    expiredFinish ||
    (view.busy && !reeling) ||
    (view.pending && !view.busy) ||
    view.stale ||
    !snapshot ||
    ["prepare", "casting", "splash"].includes(view.phase);
  const action = expiredFinish
    ? "landing"
    : finishing
      ? "finish"
      : reeling
        ? "reel"
        : attempt?.phase === "waiting" && !expiredBite
          ? "hook"
          : "cast";
  const cue = copy(
    {
      idle: "ready",
      prepare: "prepare",
      casting: "casting",
      splash: "wait",
      waiting: "wait",
      nibble: "nibble",
      bite: "bite",
      hook: "bite",
      fighting: "reel",
      finishing: "finishCue",
      landing: "landing",
      success: "ready",
      miss: "miss",
    }[view.phase],
  );
  const escapeReason = view.fight?.escapeReason ?? attempt?.fight?.escapeReason;
  const result = attempt?.result;
  return html`<section
    class="platformclaw-fishing"
    role="region"
    aria-label=${copy("title")}
    tabindex="-1"
    style=${`--fish-opacity:${view.opacity / 100}`}
    @keydown=${view.onKeydown}
    @keyup=${view.onKeyup}
    @click=${view.onClick}
  >
    <header class="platformclaw-fishing__header">
      <span>${number(snapshot?.gold ?? 0)} G</span>
      <button @click=${view.onGames} aria-label=${copy("games")}>⋯</button>
      <button @click=${view.onClose} aria-label=${copy("close")}>×</button>
    </header>
    <div
      class="platformclaw-fishing__scene"
      data-fishing-surface
      role="button"
      tabindex="0"
      aria-label=${copy(action)}
      aria-disabled=${disabled}
      @pointerdown=${view.onPointerdown}
      @pointerup=${view.onRelease}
      @pointercancel=${view.onRelease}
      @lostpointercapture=${view.onRelease}
    >
      <canvas aria-label=${copy("scene")} role="img"></canvas>
      ${view.phase === "bite"
        ? html`<strong
            class="platformclaw-fishing__bite"
            data-fishing-bite
            role="status"
            aria-label=${copy("bite")}
            >!</strong
          >`
        : nothing}
      <div class="platformclaw-fishing__cue" aria-live="polite">
        ${attempt?.quality &&
        ["hook", "fighting"].includes(view.phase) &&
        view.now - (attempt.hookedAt ?? 0) < 1000
          ? html`<strong>${attempt.quality}!</strong>`
          : nothing}
        <span
          >${view.phase === "bite"
            ? nothing
            : view.phase === "miss" && escapeReason
              ? copy(escapeReason)
              : cue}</span
        >
      </div>
    </div>
    ${view.fight && reeling
      ? html`<div class="platformclaw-fishing__gauges">
          <div
            class="platformclaw-fishing__tension"
            data-danger=${view.fight.tension >= 0.85
              ? "high"
              : view.fight.tension <= 0.12
                ? "low"
                : "safe"}
          >
            <span>${copy("tension")} <b>${Math.round(view.fight.tension * 100)}%</b></span>
            <span
              >${copy(
                view.fight.tension >= 0.85
                  ? "easeWarning"
                  : view.fight.tension <= 0.12
                    ? "reelWarning"
                    : "tensionHelp",
              )}</span
            >
            <meter
              aria-label=${copy("tension")}
              min="0"
              max="1"
              low="0.12"
              high="0.85"
              optimum="0.5"
              .value=${view.fight.tension}
            ></meter>
            <div class="platformclaw-fishing__tension-track" aria-hidden="true">
              <i style=${`left:${view.fight.tension * 100}%`}></i>
            </div>
            <span>${copy("loose")}</span><span>${copy("break")}</span>
          </div>
          <label class="platformclaw-fishing__progress"
            >${copy("progress")}
            <progress
              aria-label=${copy("progress")}
              max="1"
              .value=${view.fight.progress}
            ></progress
          ></label>
        </div>`
      : nothing}
    ${finishing
      ? html`<div class="platformclaw-fishing__finish" data-fishing-finish>
          <div
            class="platformclaw-fishing__finish-track"
            role="img"
            aria-label=${copy("finishHelp")}
          >
            <span class="platformclaw-fishing__finish-target"></span>
            <span class="platformclaw-fishing__finish-cursor" data-fishing-finish-cursor></span>
          </div>
          <span
            >${copy("finishHelp")} ·
            ${Math.max(
              0,
              Math.ceil(((attempt.finishDeadlineAt ?? view.now) - view.now) / 1000),
            )}s</span
          >
        </div>`
      : nothing}
    ${result
      ? html`<div class="platformclaw-fishing__catch" data-fishing-catch>
          ${getFishingSpecies(result.fishId).nameKo} · ${result.lengthCm} cm ·
          <strong>+${result.rewardGold} G</strong>${view.newBest ? ` · ${copy("newBest")}` : ""}
          <span>
            ·
            ${copy("accuracy", {
              accuracy: String(Math.round(result.accuracy * 100)),
              multiplier: result.bonusMultiplier.toFixed(2),
            })}</span
          >
        </div>`
      : nothing}
    <div class="platformclaw-fishing__controls">
      <button
        data-fishing-action
        ?disabled=${disabled}
        @pointerdown=${view.onPointerdown}
        @pointerup=${view.onRelease}
        @pointercancel=${view.onRelease}
        @lostpointercapture=${view.onRelease}
      >
        ${copy(action)}
      </button>
      ${(["ranking", "records"] as const).map(
        (panel) => html`<button
          aria-expanded=${view.panel === panel}
          aria-controls="fishing-panel"
          @click=${() => view.onPanel(panel)}
        >
          ${copy(panel)}
        </button>`,
      )}
    </div>
    <label class="platformclaw-fishing__opacity"
      >${copy("opacity")}
      <input
        type="range"
        min="10"
        max="100"
        step="5"
        .value=${String(view.opacity)}
        @input=${(event: Event) => view.onOpacity(Number((event.target as HTMLInputElement).value))}
      />
      <span>${view.opacity}%</span>
    </label>
    ${view.message
      ? html`<div class="platformclaw-fishing__notice" role="status">
          ${view.message}
          <button @click=${view.pending ? view.onRetry : view.onRefresh} ?disabled=${view.busy}>
            ${copy(view.pending ? "retry" : "refresh")}
          </button>
        </div>`
      : nothing}
    ${view.panel
      ? html`<div
          class="platformclaw-fishing__panel"
          id="fishing-panel"
          role="region"
          aria-label=${copy(view.panel)}
        >
          ${renderPanel(view)}
        </div>`
      : nothing}
  </section>`;
}
