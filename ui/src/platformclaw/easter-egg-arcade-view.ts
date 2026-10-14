import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { platformClawT as t } from "./i18n.ts";
import "./horse-racing-game.ts";

export function renderArcade(view: {
  screen: "closed" | "selector" | "baseball" | "racing";
  client: GatewayBrowserClient | null;
  preferenceScope: string | null;
  onBaseball: () => void;
  onRacing: () => void;
  onGames: () => void;
  onClose: () => void;
  baseball: () => TemplateResult | typeof nothing;
}) {
  if (view.screen === "closed") {
    return nothing;
  }
  if (view.screen === "racing") {
    return html`<platformclaw-horse-racing
      .client=${view.client}
      .preferenceScope=${view.preferenceScope}
      @racing-exit=${(event: CustomEvent<string>) => {
        if (event.detail === "baseball") {
          view.onBaseball();
        } else if (event.detail === "games") {
          view.onGames();
        } else {
          view.onClose();
        }
      }}
    ></platformclaw-horse-racing>`;
  }
  if (view.screen === "selector") {
    return html`<div class="platformclaw-games-scrim">
      <section
        class="platformclaw-games"
        role="dialog"
        aria-modal="true"
        aria-labelledby="platformclaw-games-title"
      >
        <button
          class="platformclaw-games__close"
          @click=${view.onClose}
          aria-label=${t("platformClaw.racing.close")}
        >
          ×
        </button>
        <p class="platformclaw-racing__eyebrow">PLATFORMCLAW ARCADE</p>
        <h2 id="platformclaw-games-title">${t("platformClaw.racing.games")}</h2>
        <p>${t("platformClaw.racing.sharedGold")}</p>
        <div class="platformclaw-games__choices">
          <button data-game-choice="baseball" @click=${view.onBaseball}>
            <span aria-hidden="true">⚾</span><strong>${t("platformClaw.racing.baseball")}</strong
            ><small>${t("platformClaw.racing.baseballHelp")}</small>
          </button>
          <button data-game-choice="racing" @click=${view.onRacing}>
            <span aria-hidden="true">🏇</span><strong>${t("platformClaw.racing.title")}</strong
            ><small>${t("platformClaw.racing.schedule")}</small>
          </button>
        </div>
      </section>
    </div>`;
  }
  return html`<nav class="platformclaw-games-nav" aria-label=${t("platformClaw.racing.games")}>
      <button @click=${view.onGames}>${t("platformClaw.racing.games")}</button>
      <button @click=${view.onRacing}>${t("platformClaw.racing.title")}</button>
      <button @click=${view.onClose} aria-label=${t("platformClaw.racing.close")}>×</button>
    </nav>
    ${view.baseball()}`;
}
