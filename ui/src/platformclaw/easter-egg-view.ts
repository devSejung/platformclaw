import { html, nothing, svg } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import {
  BASEBALL_TEAM_CHANGE_COST,
  type BaseballBatId,
  type BaseballLeaderboard,
  type BaseballLeaderboardEntry,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { getBaseballEnhancementAppearance } from "../../../packages/platformclaw-control-plane/src/baseball-enhancement.ts";
import { BASEBALL_CELEBRATION_MS } from "./easter-egg-celebration.ts";
import { renderBaseballForge, renderBaseballTaunt } from "./easter-egg-forge-view.ts";
import { BASEBALL_TEAMS, type BaseballSettings } from "./easter-egg-settings.ts";
import type { Pitch } from "./easter-egg-simulation.ts";
import type { BaseballWorkshopNotice } from "./easter-egg-workshop.ts";
import { platformClawT as t } from "./i18n.ts";

export const BASEBALL_TRAIL_POINTS = 9;

const BASEBALL_PITCH_NAMES: Record<Pitch["kind"], string> = {
  fastball: "직구",
  changeup: "체인지업",
  underhand: "언더핸드 패턴",
  curve: "커브",
  knuckleball: "너클볼",
};

export function renderBaseballGame(params: {
  active: boolean;
  shopOpen: boolean;
  phase: string;
  round: number;
  hits: number;
  homeRuns: number;
  streak: number;
  result: string;
  lastDistance: number | null;
  feedbackVisible: boolean;
  playerState: string;
  pitcherState:
    | "idle"
    | "leg-lift"
    | "throw"
    | "follow-through"
    | "underhand-windup"
    | "underhand-throw"
    | "underhand-follow-through"
    | "swing"
    | "swing-perfect";
  progress: BaseballProgress | null;
  leaderboard: BaseballLeaderboard | null;
  leaderboardStatus: string;
  persistenceStatus: string;
  persistenceBusy: boolean;
  settings: BaseballSettings;
  settingsStatus: string;
  awardedGold: number | null;
  bonusVisible: boolean;
  pendingMutationMethod: string | null;
  roundBatId: BaseballBatId;
  roundEnhancementLevel: number | null;
  workshopNotice: BaseballWorkshopNotice | null;
  workshopEffect: string;
  workshopTaunt: string;
  revealedPitch: Pitch | null;
  onOpenShop: (event: Event) => void;
  onRetry: () => void;
  onRetryLoad: () => void;
  onCloseShop: (event: Event) => void;
  onSelectTeam: (teamId: string) => void;
  onEnhance: () => void;
  onRecover: (action: "restore" | "restart") => void;
  onOpacity: (opacity: number) => void;
  onStopEvent: (event: Event) => void;
}) {
  if (!params.active) {
    return nothing;
  }
  const enhanced = params.progress?.enhancement;
  const level = enhanced?.level ?? 0;
  const equippedName = `${getBaseballEnhancementAppearance(level).name} +${level}`;
  const team =
    BASEBALL_TEAMS.find((entry) => entry.id === params.settings.teamId) ?? BASEBALL_TEAMS[0];
  const saveStatus = html`${params.persistenceStatus
    ? html`<div class="platformclaw-easter-egg__save-status" role="status">
        <span>${params.persistenceStatus}</span>
        ${params.pendingMutationMethod
          ? html`<button type="button" @click=${params.onRetry}>재시도</button>`
          : !params.persistenceBusy
            ? html`<button type="button" @click=${params.onRetryLoad}>다시 불러오기</button>`
            : nothing}
      </div>`
    : nothing}`;
  return html`<div
    class="platformclaw-easter-egg ${params.shopOpen ? "platformclaw-easter-egg--shop-open" : ""}"
    role="application"
    tabindex="-1"
    aria-label="PlatformClaw Stickman Baseball"
    data-round=${params.round}
    data-streak=${params.streak}
    data-best=${params.progress?.bestDistanceM ?? 0}
    data-bat-id=${params.roundBatId}
    data-bat-appearance=${params.roundEnhancementLevel === null
      ? nothing
      : getBaseballEnhancementAppearance(params.roundEnhancementLevel).appearanceId}
    data-round-enhancement=${params.roundEnhancementLevel ?? nothing}
    data-pitch-state=${params.phase}
    data-team-id=${team.id}
    style=${styleMap({
      "--baseball-opacity": String(params.settings.opacity / 100),
      "--baseball-team-color": team.color || undefined,
      "--baseball-cap-color": team.capColor || undefined,
      "--baseball-cap-mark-color": team.capMarkColor || undefined,
      "--baseball-celebration-duration": `${BASEBALL_CELEBRATION_MS}ms`,
    })}
  >
    ${!params.shopOpen ? saveStatus : nothing} ${renderBaseballTaunt(params.workshopTaunt)}
    <div class="platformclaw-easter-egg__scene">
      ${params.bonusVisible
        ? html`<div class="platformclaw-easter-egg__bonus" role="status">
            <strong>${t("platformClaw.baseball.bonus")}</strong>
            <span class="platformclaw-easter-egg__sparks" aria-hidden="true">
              ${Array.from(
                { length: 8 },
                (_, index) =>
                  html`<i style=${styleMap({ "--spark-angle": `${index * 45}deg` })}></i>`,
              )}
            </span>
          </div>`
        : nothing}
      <div class="platformclaw-easter-egg__score" aria-live="polite">
        <span>안타 ${params.hits}</span><span>홈런 ${params.homeRuns}</span>
      </div>
      <div class="platformclaw-easter-egg__hud" aria-live="polite">
        <span>연속 홈런 ${params.streak}</span
        ><span>최고 ${params.progress?.bestDistanceM ?? 0}m</span>
        <span>골드 ${params.progress?.gold ?? 0}</span>
        ${params.awardedGold === null
          ? nothing
          : html`<span
              >${t("platformClaw.baseball.reward", { gold: String(params.awardedGold) })}</span
            >`}
        ${params.revealedPitch
          ? html`<span class="platformclaw-easter-egg__pitch-info"
              >${BASEBALL_PITCH_NAMES[params.revealedPitch.kind]}
              ${Math.round(params.revealedPitch.speedKph)}km/h</span
            >`
          : nothing}
      </div>
      <div
        class="platformclaw-easter-egg__result platformclaw-easter-egg__feedback ${params.feedbackVisible
          ? ""
          : "platformclaw-easter-egg__feedback--faded"}"
        aria-live="assertive"
      >
        ${params.result}
      </div>
      ${params.lastDistance === null
        ? nothing
        : html`<div
            class="platformclaw-easter-egg__distance platformclaw-easter-egg__feedback ${params.feedbackVisible
              ? ""
              : "platformclaw-easter-egg__feedback--faded"}"
          >
            ${params.lastDistance}m
          </div>`}
      <div class="platformclaw-easter-egg__arena">
        <div class="platformclaw-easter-egg__trail" aria-hidden="true">
          ${Array.from(
            { length: BASEBALL_TRAIL_POINTS },
            (_, index) => html`<span
              class="platformclaw-easter-egg__trail-dot"
              data-trail-index=${index}
            ></span>`,
          )}
        </div>
        <div
          class="platformclaw-easter-egg__player platformclaw-easter-egg__player--${params.playerState}"
          aria-hidden="true"
        >
          ${renderBaseballStickman("batter", team.capMark)}<span
            class="platformclaw-easter-egg__bat"
          ></span
          ><span class="platformclaw-easter-egg__figure-label"
            >${team.id === "neutral" ? "타자" : team.name}</span
          >
        </div>
        <div
          class="platformclaw-easter-egg__target platformclaw-easter-egg__target--${params.pitcherState}"
          aria-hidden="true"
        >
          ${renderBaseballStickman("pitcher", "", params.pitcherState.startsWith("underhand"))}<span
            class="platformclaw-easter-egg__figure-label"
            >투수</span
          >
        </div>
        <div class="platformclaw-easter-egg__outfielder" aria-hidden="true">
          ${renderBaseballStickman("outfielder")}
        </div>
        <div class="platformclaw-easter-egg__fence" aria-hidden="true"></div>
        <span class="platformclaw-easter-egg__projectile" aria-hidden="true"></span>
      </div>
    </div>
    ${renderBaseballLeaderboards(
      params.leaderboard,
      params.leaderboardStatus,
      equippedName,
      params.onOpenShop,
    )}
    ${params.shopOpen
      ? renderBaseballShop({
          settings: params.settings,
          settingsStatus: params.settingsStatus,
          saveStatus,
          onSelectTeam: params.onSelectTeam,
          onOpacity: params.onOpacity,
          progress: params.progress,
          busy: params.persistenceBusy,
          pending: Boolean(params.pendingMutationMethod),
          onClose: params.onCloseShop,
          onStopEvent: params.onStopEvent,
          notice: params.workshopNotice,
          effect: params.workshopEffect,
          onEnhance: params.onEnhance,
          onRecover: params.onRecover,
        })
      : nothing}
  </div>`;
}

function renderBaseballLeaderboards(
  leaderboard: BaseballLeaderboard | null,
  status: string,
  equippedName: string,
  onOpenShop: (event: Event) => void,
) {
  return html`<div class="platformclaw-easter-egg__leaderboards" aria-label="야구 랭킹">
    <button class="platformclaw-easter-egg__shop-trigger" type="button" @click=${onOpenShop}>
      ${equippedName} 배트 · ${t("platformClaw.baseball.settingsTitle")}
    </button>
    ${status
      ? html`<span class="platformclaw-easter-egg__leaderboard-status" role="status"
          >${status}</span
        >`
      : nothing}
    ${leaderboard
      ? html`<section>
            <strong>비거리 TOP 5</strong>
            ${renderBaseballLeaderboardRows(leaderboard.distance, "m")}
          </section>
          <section>
            <strong>연속 홈런 TOP 5</strong>
            ${renderBaseballLeaderboardRows(leaderboard.homeRunStreak, "")}
          </section>`
      : nothing}
  </div>`;
}

function renderBaseballLeaderboardRows(entries: BaseballLeaderboardEntry[], suffix: string) {
  if (entries.length === 0) {
    return html`<span class="platformclaw-easter-egg__leaderboard-empty">기록 없음</span>`;
  }
  return html`<ol>
    ${entries.map(
      (entry, index) => html`<li
        class=${entry.isCurrentUser ? "platformclaw-easter-egg__leaderboard-current" : ""}
      >
        <span>${index + 1}. ${entry.displayName}${entry.isCurrentUser ? " (나)" : ""}</span>
        <strong>${entry.value}${suffix}</strong>
      </li>`,
    )}
  </ol>`;
}

function renderBaseballStickman(
  role: "batter" | "pitcher" | "outfielder",
  capMark = "",
  underhand = false,
) {
  const frontArm = underhand
    ? "M24 23 16 34 25 46"
    : role === "batter"
      ? "M24 23 39 29"
      : "M24 23 12 30";
  const backArm =
    role === "pitcher" ? (underhand ? "M24 23 36 32" : "M24 23 38 17") : "M24 23 36 30";
  const frontLeg = role === "pitcher" ? "M24 37 13 48 25 49" : "M24 37 13 54";
  return html`<svg
    class="platformclaw-easter-egg__figure platformclaw-easter-egg__figure--${role}"
    data-player-role=${role}
    viewBox="8 0 34 56"
    role="presentation"
    focusable="false"
  >
    <circle class="platformclaw-easter-egg__figure-head" cx="24" cy="10" r="6" />
    ${capMark
      ? svg`<g class="platformclaw-easter-egg__cap" transform="translate(15 -2)">
          <path class="platformclaw-easter-egg__cap-crown" d="M1 10V7a8 7 0 0 1 16 0v3Z" />
          <path class="platformclaw-easter-egg__cap-brim" d="M1 10h20" />
          <text class="platformclaw-easter-egg__cap-mark" x="9" y="8.5" text-anchor="middle">${capMark}</text>
        </g>`
      : nothing}
    <path class="platformclaw-easter-egg__figure-torso" d="M24 17v20" />
    <path class="platformclaw-easter-egg__figure-arm-back" d=${backArm} />
    <path class="platformclaw-easter-egg__figure-arm-front" d=${frontArm} />
    <path class="platformclaw-easter-egg__figure-leg-back" d="M24 37 38 51" />
    <path class="platformclaw-easter-egg__figure-leg-front" d=${frontLeg} />
  </svg>`;
}

function renderBaseballShop(params: {
  settings: BaseballSettings;
  settingsStatus: string;
  saveStatus: unknown;
  onSelectTeam: (teamId: string) => void;
  onOpacity: (opacity: number) => void;
  progress: BaseballProgress | null;
  busy: boolean;
  pending: boolean;
  onClose: (event: Event) => void;
  onStopEvent: (event: Event) => void;
  notice: BaseballWorkshopNotice | null;
  effect: string;
  onEnhance: () => void;
  onRecover: (action: "restore" | "restart") => void;
}) {
  const teamCost = params.progress?.teamId ? BASEBALL_TEAM_CHANGE_COST : 0;
  return html`<div
    class="platformclaw-easter-egg__shop-scrim"
    role="presentation"
    @pointerdown=${params.onStopEvent}
    @pointerup=${params.onStopEvent}
    @click=${params.onStopEvent}
  >
    <section
      class="platformclaw-easter-egg__shop"
      role="dialog"
      aria-modal="true"
      aria-label="배트 강화·설정"
    >
      <header>
        <strong>배트 강화 · ${t("platformClaw.baseball.settingsTitle")}</strong
        ><button type="button" @click=${params.onClose}>닫기</button>
      </header>
      ${params.saveStatus}
      ${renderBaseballForge({
        progress: params.progress,
        busy: params.busy,
        pending: params.pending,
        notice: params.notice,
        effect: params.effect,
        onEnhance: params.onEnhance,
        onRecover: params.onRecover,
      })}
      <div class="platformclaw-easter-egg__settings">
        <label for="baseball-team"
          >${t("platformClaw.baseball.team")} ·
          ${teamCost ? `변경 ${teamCost.toLocaleString("ko-KR")}G` : "첫 선택 무료"}</label
        >
        <select
          id="baseball-team"
          .value=${params.progress?.teamId ?? ""}
          ?disabled=${params.busy || params.pending || !params.progress}
          @change=${(event: Event) =>
            params.onSelectTeam((event.target as HTMLSelectElement).value)}
        >
          <option value="" disabled ?selected=${!params.progress?.teamId}>팀 선택</option>
          ${BASEBALL_TEAMS.filter((team) => team.id !== "neutral").map(
            (team) =>
              html`<option value=${team.id} ?selected=${team.id === params.progress?.teamId}>
                ${team.name}
              </option>`,
          )}
        </select>
        <small
          >첫 KBO 팀 선택은 무료이며, 이후 다른 팀으로 변경할 때 2,000G를 사용합니다. 팀은 성능에
          영향을 주지 않습니다.</small
        >
        <label for="baseball-opacity"
          >${t("platformClaw.baseball.opacity", { value: String(params.settings.opacity) })}</label
        >
        <input
          id="baseball-opacity"
          type="range"
          min="30"
          max="100"
          step="5"
          .value=${String(params.settings.opacity)}
          aria-valuetext=${`${params.settings.opacity}%`}
          @input=${(event: Event) =>
            params.onOpacity(Number((event.target as HTMLInputElement).value))}
        />
        <button type="button" @click=${() => params.onOpacity(100)}>
          ${t("platformClaw.baseball.restore")}
        </button>
        <small>${t("platformClaw.baseball.opacityHelp")}</small
        ><span role="status">${params.settingsStatus}</span>
      </div>
      <p>${t("platformClaw.baseball.rules")}</p>
      <p>${t("platformClaw.baseball.streakRule")}</p>
      <p>
        ${t("platformClaw.baseball.nextBonus", {
          count: String(5 - ((params.progress?.totalHomers ?? 0) % 5)),
        })}
      </p>
    </section>
  </div>`;
}
