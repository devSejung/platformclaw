import { html, nothing } from "lit";
import type { HorseRaceSnapshot } from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import { i18n } from "../i18n/index.ts";
import { renderRacingBetting } from "./horse-racing-bet-view.ts";
import { horseLabel, horseRaceOrder } from "./horse-racing-presentation.ts";
import type { HorseRacingView } from "./horse-racing-view-contract.ts";
import { platformClawT as t } from "./i18n.ts";

function raceTime(timestamp: number): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function countdown(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((timestamp - now) / 1_000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function renderTrack(view: HorseRacingView, race: HorseRaceSnapshot) {
  const order = horseRaceOrder(race);
  return html`<section class="platformclaw-racing__track">
    <h3>${t(race.finishOrder ? "platformClaw.racing.result" : "platformClaw.racing.order")}</h3>
    ${race.finishOrder
      ? html`<div class="platformclaw-racing__podium">
          ${order
            .slice(0, 3)
            .map((id, index) => html`<strong><b>${index + 1}</b>${horseLabel(race, id)}</strong>`)}
        </div>`
      : nothing}
    <ol class="platformclaw-racing__ranking" aria-label=${t("platformClaw.racing.order")}>
      ${order.map((id, index) => {
        const horse = race.horses.find((entry) => entry.id === id)!;
        const progress = race.positions.find((entry) => entry.horseId === id)?.position ?? 0;
        return html`<li data-racing-rank=${id} style=${`--horse-color:${horse.color}`}>
          <b>${index + 1}</b><strong>${horseLabel(race, id)}</strong
          ><progress max="100" value=${progress} aria-label=${horse.name}></progress>
        </li>`;
      })}
    </ol>
    <p class="platformclaw-racing__perimeter-help">
      ${t(
        race.status === "racing"
          ? "platformClaw.racing.perimeterHelp"
          : "platformClaw.racing.trackWaiting",
      )}
    </p>
    ${view.stale
      ? html`<p class="platformclaw-racing__warning">${t("platformClaw.racing.paused")}</p>`
      : nothing}
  </section>`;
}

function renderReaction(view: HorseRacingView) {
  return view.reaction
    ? html`<div
        data-racing-win
        class="platformclaw-racing__win ${view.reducedMotion
          ? "platformclaw-racing__win--static"
          : ""} ${view.presentation === "collapsed" ? "platformclaw-racing__win--minimized" : ""}"
        role="status"
        aria-live="polite"
      >
        <strong>${t("platformClaw.racing.youWon")}</strong
        ><span
          >${t("platformClaw.racing.payout", {
            amount: String(view.reaction.payout),
            profit: `${view.reaction.profit > 0 ? "+" : ""}${view.reaction.profit}`,
          })}</span
        >
      </div>`
    : nothing;
}

function renderReceipts(view: HorseRacingView, race: HorseRaceSnapshot) {
  return html`<section class="platformclaw-racing__card">
    <h3>${t("platformClaw.racing.myBets")}</h3>
    ${race.myBets.length === 0
      ? html`<p class="platformclaw-racing__muted">${t("platformClaw.racing.noBets")}</p>`
      : html`<ul class="platformclaw-racing__receipts">
          ${race.myBets.map((bet) => {
            const profit = bet.payout === null ? null : bet.payout - bet.amount;
            return html`<li
              class=${bet.refunded
                ? ""
                : profit !== null && profit > 0
                  ? "platformclaw-racing__receipt--win"
                  : ""}
            >
              <div>
                <strong
                  >${t(`platformClaw.racing.${bet.market}`)}
                  ${bet.selection.map((id) => horseLabel(race, id)).join(" + ")}</strong
                ><span>${bet.amount}G</span>
              </div>
              <p>
                ${bet.cancelledAt !== null
                  ? t("platformClaw.racing.betCancelled", { amount: String(bet.amount) })
                  : bet.refunded
                    ? t("platformClaw.racing.refunded", {
                        amount: String(bet.payout ?? bet.amount),
                      })
                    : bet.payout === null
                      ? t("platformClaw.racing.awaiting")
                      : t("platformClaw.racing.payout", {
                          amount: String(bet.payout),
                          profit: `${profit !== null && profit > 0 ? "+" : ""}${profit}`,
                        })}
              </p>
              ${bet.quotedOdds !== null && bet.potentialPayout !== null
                ? html`<small
                    >${t("platformClaw.racing.receiptQuote", {
                      odds: bet.quotedOdds.toFixed(4),
                      amount: String(bet.potentialPayout),
                    })}</small
                  >`
                : nothing}
              ${view.pendingCancelId === bet.id ||
              (race.status === "betting" &&
                view.now < race.closesAt &&
                bet.cancelledAt === null &&
                bet.payout === null)
                ? html`<button
                    data-cancel-bet=${bet.id}
                    ?disabled=${view.busy ||
                    view.pending ||
                    view.stale ||
                    (view.pendingCancelId !== null && view.pendingCancelId !== bet.id)}
                    @click=${() => view.onCancel(bet.id)}
                  >
                    ${t(
                      view.pendingCancelId === bet.id
                        ? "platformClaw.racing.retryCancel"
                        : "platformClaw.racing.cancelBet",
                    )}
                  </button>`
                : nothing}
            </li>`;
          })}
        </ul>`}
  </section>`;
}

function renderLiveBets(race: HorseRaceSnapshot, minimized = false) {
  return html`<section
    class="platformclaw-racing__live-feed"
    aria-label=${t("platformClaw.racing.liveBets")}
  >
    <h3>${t("platformClaw.racing.liveBets")} <span>${race.liveBetCount}</span></h3>
    ${race.liveBets.length
      ? html`<ol>
          ${race.liveBets
            .slice(0, minimized ? 5 : 30)
            .map(
              (bet) =>
                html`<li>
                  <strong title=${bet.displayName}>${bet.displayName}</strong
                  ><span
                    >${t(`platformClaw.racing.${bet.market}`)}
                    ${bet.selection.map((id) => horseLabel(race, id)).join(" + ")} ·
                    ${bet.amount}G</span
                  >
                </li>`,
            )}
        </ol>`
      : html`<p>${t("platformClaw.racing.noLiveBets")}</p>`}
  </section>`;
}

export function renderHorseRacing(view: HorseRacingView) {
  const { snapshot, now } = view;
  const race = snapshot?.race;
  const locked = view.busy || view.pending || view.pendingCancelId !== null || view.stale;
  const open = Boolean(
    race &&
    race.status === "betting" &&
    now >= race.opensAt &&
    now < race.closesAt &&
    !view.historical,
  );
  const deadline = race
    ? race.status === "scheduled"
      ? race.opensAt
      : race.status === "betting"
        ? race.closesAt
        : race.status === "locked"
          ? race.startsAt
          : race.status === "racing"
            ? race.endsAt
            : snapshot?.nextStartsAt
    : snapshot?.nextStartsAt;
  const deadlineLabel =
    race?.status === "scheduled"
      ? "opensIn"
      : race?.status === "betting"
        ? "closesIn"
        : race?.status === "racing"
          ? "finishesIn"
          : "startsIn";
  if (view.presentation === "collapsed") {
    return html`${renderReaction(view)}${race
        ? html`<div class="platformclaw-racing-minimized-feed">
            ${race.status === "racing" || race.finishOrder
              ? renderTrack(view, race)
              : nothing}${renderLiveBets(race, true)}
          </div>`
        : nothing}
      <div class="platformclaw-racing-pill">
        <button data-racing-restore @click=${() => view.onPresentation("compact")}>
          ${t("platformClaw.racing.title")}</button
        ><button
          data-racing-close
          @click=${() => view.onExit("close")}
          aria-label=${t("platformClaw.racing.close")}
        >
          ×
        </button>
      </div>`;
  }
  return html`${renderReaction(view)}
    <div
      class="platformclaw-racing-dock ${view.presentation === "expanded"
        ? "platformclaw-racing-dock--expanded"
        : ""}"
    >
      <section
        class="platformclaw-racing ${view.reducedMotion ? "platformclaw-racing--reduced" : ""}"
        role="region"
        aria-labelledby="platformclaw-racing-title"
      >
        <header class="platformclaw-racing__header">
          <div>
            <h2 id="platformclaw-racing-title">${t("platformClaw.racing.title")}</h2>
          </div>
          <div class="platformclaw-racing__header-actions">
            <strong class="platformclaw-racing__wallet"
              >${snapshot ? `${snapshot.gold.toLocaleString()} G` : "— G"}</strong
            >
            <button
              data-racing-expand
              @click=${() =>
                view.onPresentation(view.presentation === "expanded" ? "compact" : "expanded")}
              aria-label=${t(
                view.presentation === "expanded"
                  ? "platformClaw.racing.compact"
                  : "platformClaw.racing.expand",
              )}
            >
              ${view.presentation === "expanded" ? "↙" : "↗"}
            </button>
            <button
              data-racing-collapse
              @click=${() => view.onPresentation("collapsed")}
              aria-label=${t("platformClaw.racing.collapse")}
            >
              −
            </button>
            <button
              data-racing-close
              @click=${() => view.onExit("close")}
              aria-label=${t("platformClaw.racing.close")}
            >
              ×
            </button>
          </div>
        </header>
        <div class="platformclaw-racing__ribbon">
          <span>${race ? raceTime(race.startsAt) : t("platformClaw.racing.waiting")}</span>
          <strong
            >${race
              ? t(`platformClaw.racing.status.${race.status}`)
              : t("platformClaw.racing.nextRace")}</strong
          >
          ${deadline
            ? html`<span
                >${t(`platformClaw.racing.${deadlineLabel}`)}
                <b>${countdown(deadline, now)}</b></span
              >`
            : nothing}
        </div>
        <div class="platformclaw-racing__layout">
          <main>
            ${race
              ? html`${race.status === "racing" || race.finishOrder
                  ? renderTrack(view, race)
                  : nothing}${race.status !== "racing" || view.pending || view.pendingCancelId
                  ? renderRacingBetting(view, race, open, locked)
                  : nothing}`
              : html`<div class="platformclaw-racing__empty">
                  <h3>${t("platformClaw.racing.waiting")}</h3>
                  <p>
                    ${snapshot
                      ? `${t("platformClaw.racing.nextRace")} · ${raceTime(snapshot.nextStartsAt)} KST`
                      : view.message}
                  </p>
                </div>`}
            ${race
              ? html`${renderLiveBets(race)}
                  <div class="platformclaw-racing__pool-summary">
                    <span
                      >${t("platformClaw.racing.totalStake")}
                      <strong>${race.totalStake.toLocaleString()}G</strong></span
                    ><span
                      >${t("platformClaw.racing.participants")}
                      <strong>${race.participants}</strong></span
                    ><span
                      >${t("platformClaw.racing.fee", {
                        percent: race.pricingVersion === "probability-net-3pct-v2" ? "3" : "0",
                      })}</span
                    >
                  </div>
                  ${race.status === "cancelled"
                    ? html`<p class="platformclaw-racing__warning">
                        ${t(
                          race.cancellationReason === "engine_changed"
                            ? "platformClaw.racing.engineChanged"
                            : "platformClaw.racing.cancelled",
                        )}
                      </p>`
                    : nothing}
                  ${renderReceipts(view, race)}
                  <details class="platformclaw-racing__fairness">
                    <summary>${t("platformClaw.racing.fairness")}</summary>
                    <p>${t("platformClaw.racing.fairnessHelp")}</p>
                    <code>${race.id} · ${race.algorithmVersion}</code
                    ><label
                      >${t("platformClaw.racing.commitment")}<code>${race.commitment}</code></label
                    >${race.revealedSeed
                      ? html`<label
                            >${t("platformClaw.racing.seed")}<code
                              >${race.revealedSeed}</code
                            ></label
                          >${race.finishOrder
                            ? html`<button @click=${view.onVerify}>
                                  ${t("platformClaw.racing.verify")}
                                </button>
                                <p role="status">${view.verification}</p>`
                            : nothing}`
                      : html`<p>${t("platformClaw.racing.seedHidden")}</p>`}
                  </details> `
              : nothing}
          </main>
          <aside>
            <section class="platformclaw-racing__card">
              <h3>${t("platformClaw.racing.recent")}</h3>
              <button
                ?disabled=${view.busy || view.pending || view.pendingCancelId !== null}
                @click=${() => view.onHistory(null)}
              >
                ${t("platformClaw.racing.live")}
              </button>
              <ul class="platformclaw-racing__history">
                ${snapshot?.recentRaces.map(
                  (entry) =>
                    html`<li>
                      <button
                        ?disabled=${view.busy || view.pending || view.pendingCancelId !== null}
                        @click=${() => view.onHistory(entry.id)}
                      >
                        <span>${raceTime(entry.startsAt)}</span
                        ><strong
                          >${entry.winnerName ??
                          t(`platformClaw.racing.status.${entry.status}`)}</strong
                        >
                      </button>
                    </li>`,
                )}
              </ul>
            </section>
            <section class="platformclaw-racing__card platformclaw-racing__settings">
              <div class="platformclaw-racing__opacity">
                <label for="racing-opacity"
                  >${t("platformClaw.racing.opacity", { value: String(view.opacity) })}</label
                >
                <input
                  id="racing-opacity"
                  type="range"
                  min="30"
                  max="100"
                  step="5"
                  .value=${String(view.opacity)}
                  aria-valuetext=${`${view.opacity}%`}
                  @input=${(event: Event) =>
                    view.onOpacity(Number((event.target as HTMLInputElement).value))}
                />
                <button type="button" data-racing-opacity-reset @click=${() => view.onOpacity(100)}>
                  ${t("platformClaw.racing.restoreOpacity")}
                </button>
                <small>${t("platformClaw.racing.opacityHelp")}</small>
                <span role="status">${view.settingsStatus}</span>
              </div>
              <button @click=${() => view.onExit("baseball")}>
                ${t("platformClaw.racing.baseball")}
              </button>
              <button @click=${() => view.onExit("games")}>
                ${t("platformClaw.racing.games")}
              </button>
              <button aria-pressed=${!view.muted} @click=${view.onMute}>
                ${t(view.muted ? "platformClaw.racing.soundOff" : "platformClaw.racing.soundOn")}</button
              ><button aria-pressed=${view.reducedMotion} @click=${view.onMotion}>
                ${t("platformClaw.racing.reduceMotion")}
              </button>
            </section>
            <p class="platformclaw-racing__rules">${t("platformClaw.racing.rules")}</p>
            <p class="platformclaw-racing__schedule">${t("platformClaw.racing.schedule")}</p>
          </aside>
        </div>
      </section>
    </div>`;
}
