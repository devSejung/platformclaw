import { html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import {
  HORSE_RACING_MIN_BET_GOLD,
  HORSE_RACING_MAX_BET_GOLD,
  HORSE_RACING_FEE_PERCENT,
  type HorseRaceSnapshot,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import { quoteHorsePayout } from "../../../packages/platformclaw-control-plane/src/horse-racing-pricing.ts";
import { horseLabel } from "./horse-racing-presentation.ts";
import type { HorseRacingView } from "./horse-racing-view-contract.ts";
import { platformClawT as t } from "./i18n.ts";

export function renderRacingBetting(
  view: HorseRacingView,
  race: HorseRaceSnapshot,
  open: boolean,
  locked: boolean,
) {
  const quote = race.quotes.find(
    (entry) =>
      entry.market === view.market &&
      entry.selection.length === view.selection.length &&
      entry.selection.every((id) => view.selection.includes(id)),
  );
  const validAmount =
    Number.isSafeInteger(view.amount) &&
    view.amount >= HORSE_RACING_MIN_BET_GOLD &&
    view.amount <= HORSE_RACING_MAX_BET_GOLD;
  let payout: number | null = null;
  let quoteError = "";
  if (quote && validAmount && race.pricingVersion !== "pool-v1") {
    try {
      payout = quoteHorsePayout(quote, view.amount);
    } catch {
      quoteError = t("platformClaw.racing.invalidQuote");
    }
  }
  const valid =
    open &&
    !locked &&
    validAmount &&
    view.amount <= (view.snapshot?.gold ?? 0) &&
    view.selection.length === (view.market === "win" ? 1 : 2) &&
    payout !== null;
  return html`<section class="platformclaw-racing__bet-flow">
    <h3>${t("platformClaw.racing.betSlip")}</h3>
    <div class="platformclaw-racing__markets">
      ${(["win", "quinella", "quinella-place"] as const).map(
        (market) =>
          html`<button
            data-racing-market=${market}
            aria-pressed=${view.market === market}
            ?disabled=${locked || !open}
            @click=${() => view.onMarket(market)}
          >
            ${t(`platformClaw.racing.${market}`)}
          </button>`,
      )}
    </div>
    <p class="platformclaw-racing__muted">${t(`platformClaw.racing.${view.market}Help`)}</p>
    <div class="platformclaw-racing__horses">
      ${race.horses.map((horse, index) => {
        const winQuote = race.quotes.find(
          (entry) => entry.market === "win" && entry.selection[0] === horse.id,
        );
        return html`<button
          class="platformclaw-racing__horse-card"
          style=${styleMap({ "--horse-color": horse.color })}
          ?disabled=${locked || !open}
          aria-pressed=${view.selection.includes(horse.id)}
          @click=${() => view.onSelect(horse.id)}
          data-horse-id=${horse.id}
        >
          <span class="platformclaw-racing__number">${index + 1}</span
          ><strong>${horse.name}</strong>
          <span class="platformclaw-racing__horse-odds"
            >${t("platformClaw.racing.win")}
            ${winQuote ? `${winQuote.odds.toFixed(4)}×` : "—"}</span
          >
          ${(["speed", "stamina"] as const).map((stat) => {
            const approximate = Math.round(horse[stat] / 10) * 10;
            const grade = approximate >= 80 ? "high" : approximate >= 60 ? "medium" : "low";
            return html`<span
              class="platformclaw-racing__gauge"
              aria-label=${`${t(`platformClaw.racing.${stat}`)} · ${t(`platformClaw.racing.${grade}`)}`}
              ><span>${t(`platformClaw.racing.${stat}`)}</span
              ><i aria-hidden="true"><b style=${styleMap({ width: `${approximate}%` })}></b></i
            ></span>`;
          })}
          <span class="platformclaw-racing__rumor" title=${horse.rumor}
            ><em>${t("platformClaw.racing.rumor")}</em>${horse.rumor}</span
          >
        </button>`;
      })}
    </div>
    <div class="platformclaw-racing__bet-action">
      <div class="platformclaw-racing__selection" data-racing-selection>
        ${view.selection.length
          ? view.selection.map((id) => html`<strong>${horseLabel(race, id)}</strong>`)
          : t("platformClaw.racing.choose")}
      </div>
      <label class="platformclaw-racing__amount"
        >${t("platformClaw.racing.amount")}<input
          type="number"
          min=${HORSE_RACING_MIN_BET_GOLD}
          max=${Math.min(HORSE_RACING_MAX_BET_GOLD, view.snapshot?.gold ?? 0)}
          step="1"
          .value=${String(view.amount)}
          ?disabled=${locked || !open}
          @input=${(event: Event) =>
            view.onAmount((event.target as HTMLInputElement).valueAsNumber)}
      /></label>
      <div class="platformclaw-racing__quick-amounts">
        ${[50, 100, 250, 500, 1000].map(
          (amount) =>
            html`<button
              data-racing-amount=${amount}
              aria-pressed=${view.amount === amount}
              ?disabled=${locked || !open || amount > (view.snapshot?.gold ?? 0)}
              @click=${() => view.onAmount(amount)}
            >
              ${amount}G
            </button>`,
        )}
      </div>
      <dl class="platformclaw-racing__dividend">
        <div>
          <dt>
            ${t(
              race.pricingVersion === "pool-v1"
                ? "platformClaw.racing.historicalOdds"
                : "platformClaw.racing.fixedOdds",
            )}
          </dt>
          <dd>${quote ? `${quote.odds.toFixed(4)}×` : "—"}</dd>
        </div>
        <div>
          <dt>${t("platformClaw.racing.potentialPayout")}</dt>
          <dd data-potential-payout>${payout === null ? "—" : `${payout.toLocaleString()}G`}</dd>
        </div>
      </dl>
      <small
        >${t("platformClaw.racing.betBounds", {
          min: String(HORSE_RACING_MIN_BET_GOLD),
          max: String(HORSE_RACING_MAX_BET_GOLD),
          percent:
            race.pricingVersion === "probability-net-3pct-v2"
              ? String(HORSE_RACING_FEE_PERCENT)
              : "0",
        })}</small
      >
      <button
        class="platformclaw-racing__submit"
        ?disabled=${view.pendingCancelId !== null ||
        (view.pending ? view.busy || view.stale : !valid)}
        @click=${view.onBet}
      >
        ${t(
          view.busy
            ? "platformClaw.racing.sending"
            : view.pending
              ? "platformClaw.racing.retryBet"
              : "platformClaw.racing.placeBet",
        )}
      </button>
      <p class="platformclaw-racing__message" role="status">${view.message}</p>
      ${quoteError ? html`<p role="status">${quoteError}</p>` : nothing}
      ${!open
        ? html`<p class="platformclaw-racing__muted">${t("platformClaw.racing.betClosed")}</p>`
        : nothing}
      ${view.stale
        ? html`<button @click=${view.onRefresh}>${t("platformClaw.racing.refresh")}</button>`
        : nothing}
    </div>
    <details>
      <summary>${t("platformClaw.racing.dividendDetails")}</summary>
      <p class="platformclaw-racing__muted">${t("platformClaw.racing.dividendHelp")}</p>
    </details>
  </section>`;
}
