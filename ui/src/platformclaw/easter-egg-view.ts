import { html, nothing, svg } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import {
  BASEBALL_BATS,
  BASEBALL_RPC,
  type BaseballBatId,
  type BaseballLeaderboard,
  type BaseballLeaderboardEntry,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { BASEBALL_CELEBRATION_MS } from "./easter-egg-celebration.ts";
import { BASEBALL_TEAMS, type BaseballSettings } from "./easter-egg-settings.ts";
import { platformClawT as t } from "./i18n.ts";

const BASEBALL_BAT_NAMES: Record<BaseballBatId, string> = {
  wood: "나무",
  silver: "실버",
  gold: "골드",
  platinum: "플래티넘",
  titanium: "티타늄",
  emerald: "에메랄드",
  diamond: "다이아몬드",
};

export const BASEBALL_TRAIL_POINTS = 9;

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
  pitcherState: string;
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
  pitchSpeedKph: number | null;
  onOpenShop: (event: Event) => void;
  onRetry: () => void;
  onCancel: () => void;
  onRetryLoad: () => void;
  onCloseShop: (event: Event) => void;
  onSelectBat: (batId: BaseballBatId, owned: boolean) => void;
  onSelectTeam: (teamId: string) => void;
  onOpacity: (opacity: number) => void;
  onStopEvent: (event: Event) => void;
}) {
  if (!params.active) {
    return nothing;
  }
  const equipped = params.progress?.equippedBatId ?? "wood";
  const team =
    BASEBALL_TEAMS.find((entry) => entry.id === params.settings.teamId) ?? BASEBALL_TEAMS[0];
  const saveStatus = html`${params.persistenceStatus
    ? html`<div class="platformclaw-easter-egg__save-status" role="status">
        <span>${params.persistenceStatus}</span>
        ${params.pendingMutationMethod
          ? html`<button type="button" @click=${params.onRetry}>재시도</button>
              ${params.pendingMutationMethod === BASEBALL_RPC.plateAppearance
                ? nothing
                : html`<button type="button" @click=${params.onCancel}>취소</button>`}`
          : (!params.progress || params.phase === "ready") && !params.persistenceBusy
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
    ${!params.shopOpen ? saveStatus : nothing}
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
        <span
          >${params.pitchSpeedKph === null ? "" : `${Math.round(params.pitchSpeedKph)}km/h`}</span
        >
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
          ${renderBaseballStickman("pitcher")}<span class="platformclaw-easter-egg__figure-label"
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
      equipped,
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
          onSelect: params.onSelectBat,
          onStopEvent: params.onStopEvent,
        })
      : nothing}
  </div>`;
}

function renderBaseballLeaderboards(
  leaderboard: BaseballLeaderboard | null,
  status: string,
  equipped: BaseballBatId,
  onOpenShop: (event: Event) => void,
) {
  return html`<div class="platformclaw-easter-egg__leaderboards" aria-label="야구 랭킹">
    <button class="platformclaw-easter-egg__shop-trigger" type="button" @click=${onOpenShop}>
      ${BASEBALL_BAT_NAMES[equipped]} 배트 · ${t("platformClaw.baseball.settingsTitle")}
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

function renderBaseballStickman(role: "batter" | "pitcher" | "outfielder", capMark = "") {
  const frontArm = role === "batter" ? "M24 23 39 29" : "M24 23 12 30";
  const backArm = role === "pitcher" ? "M24 23 38 17" : "M24 23 36 30";
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
  onSelect: (batId: BaseballBatId, owned: boolean) => void;
  onStopEvent: (event: Event) => void;
}) {
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
      aria-label="배트 상점"
    >
      <header>
        <strong>${t("platformClaw.baseball.settingsTitle")}</strong
        ><button type="button" @click=${params.onClose}>닫기</button>
      </header>
      ${params.saveStatus}
      <div class="platformclaw-easter-egg__settings">
        <label for="baseball-team">${t("platformClaw.baseball.team")}</label>
        <select
          id="baseball-team"
          .value=${params.settings.teamId}
          @change=${(event: Event) =>
            params.onSelectTeam((event.target as HTMLSelectElement).value)}
        >
          ${BASEBALL_TEAMS.map(
            (team) =>
              html`<option value=${team.id} ?selected=${team.id === params.settings.teamId}>
                ${team.name}
              </option>`,
          )}
        </select>
        <small>${t("platformClaw.baseball.cosmetic")}</small>
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
        <small>${t("platformClaw.baseball.opacityHelp")}</small>
        <span role="status">${params.settingsStatus}</span>
      </div>
      <p>${t("platformClaw.baseball.rules")}</p>
      <p>${t("platformClaw.baseball.streakRule")}</p>
      <p>
        ${t("platformClaw.baseball.nextBonus", {
          count: String(5 - ((params.progress?.totalHomers ?? 0) % 5)),
        })}
      </p>
      <p>골드 ${params.progress?.gold ?? 0} · 장착은 다음 타석부터 적용</p>
      <div class="platformclaw-easter-egg__shop-list">
        ${BASEBALL_BATS.map((bat) => {
          const owned = params.progress?.ownedBatIds.includes(bat.id) ?? bat.id === "wood";
          const equipped = params.progress?.equippedBatId === bat.id;
          const affordable = (params.progress?.gold ?? 0) >= bat.price;
          const label = equipped
            ? "장착 중"
            : owned
              ? "장착"
              : affordable
                ? `${bat.price}골드 구매`
                : `${bat.price}골드 부족`;
          return html`<button
            type="button"
            class="platformclaw-easter-egg__shop-item"
            data-shop-bat=${bat.id}
            ?disabled=${params.busy || params.pending || equipped || (!owned && !affordable)}
            @click=${() => params.onSelect(bat.id, owned)}
          >
            <span class="platformclaw-easter-egg__shop-bat" data-bat=${bat.id}></span>
            <span
              ><strong>${BASEBALL_BAT_NAMES[bat.id]}</strong
              ><small>파워 ×${bat.exitVelocityMultiplier.toFixed(2)}</small></span
            >
            <span>${label}</span>
          </button>`;
        })}
      </div>
    </section>
  </div>`;
}
