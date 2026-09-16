import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { subtitleForRoute, titleForRoute } from "../app-navigation.ts";
import { INTERNAL_MEMORY_PATH_PARAM, type RouteId } from "../app-route-paths.ts";
import { icons } from "../components/icons.ts";
import "../components/modal-dialog.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { platformClawGuideT as guideT, platformClawT as t } from "./i18n.ts";

type PageHelp = {
  title: string;
  body: string;
  details: string[];
};

const GUIDE_ROUTES: Partial<Record<RouteId, string>> = {
  activity: "activity",
  automation: "automations",
  chat: "chat",
  cron: "automations",
  dashboard: "chat",
  "new-session": "chat",
  organization: "organizationNav",
  sessions: "sessions",
  skills: "skills",
  "skill-hub": "skillHub",
  "skill-workshop": "workshop",
  tasks: "tasks",
  usage: "usage",
};

function memoryGuide(pathname: string, search: string): string {
  const routedPath = new URLSearchParams(search).get(INTERNAL_MEMORY_PATH_PARAM) ?? pathname;
  if (/\/memories\/?$/.test(routedPath)) {
    return "personalMemory";
  }
  if (/\/wiki\/?$/.test(routedPath)) {
    return "personalWiki";
  }
  if (/\/organization\/?$/.test(routedPath)) {
    return "organizationMemory";
  }
  if (/\/dreams\/?$/.test(routedPath)) {
    return "dreaming";
  }
  return "memoryOverview";
}

function pluginGuide(pathname: string): string {
  return /\/discover\/?$/.test(pathname) ? "discoverPlugins" : "installedPlugins";
}

export function pageHelpForRoute(routeId: RouteId, pathname = "", search = ""): PageHelp {
  const guide =
    routeId === "memory"
      ? memoryGuide(pathname, search)
      : routeId === "plugins"
        ? pluginGuide(pathname)
        : GUIDE_ROUTES[routeId];
  if (!guide) {
    return {
      title: titleForRoute(routeId),
      body: subtitleForRoute(routeId),
      details: [],
    };
  }
  return {
    title: guideT(`platformClaw.guide.${guide}Title`),
    body: guideT(`platformClaw.guide.${guide}Body`),
    details: guideT(`platformClaw.guide.${guide}Details`).split("|").filter(Boolean),
  };
}

export class PlatformClawPageHelpElement extends OpenClawLitElement {
  @property() routeId: RouteId = "chat";
  @property() pathname = "";
  @property() search = "";
  @state() private open = false;

  static override styles = css`
    :host {
      position: fixed;
      z-index: 20;
      top: max(12px, env(safe-area-inset-top));
      right: max(14px, env(safe-area-inset-right));
      display: block;
    }
    .help-trigger {
      display: grid;
      width: 26px;
      height: 26px;
      padding: 0;
      place-items: center;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-full);
      background: var(--bg-elevated);
      color: var(--muted-strong);
      cursor: pointer;
    }
    .help-trigger:hover,
    .help-trigger:focus-visible {
      border-color: var(--accent);
      color: var(--accent);
      outline: none;
    }
    .help-trigger svg {
      width: 16px;
      height: 16px;
    }
    .help-panel {
      display: grid;
      gap: 12px;
      padding: 22px;
      background: var(--bg-elevated);
      color: var(--text);
    }
    .help-panel h2,
    .help-panel p,
    .help-panel ul {
      margin: 0;
    }
    .help-panel h2 {
      padding-right: 36px;
      font-size: 19px;
    }
    .help-panel p,
    .help-panel li {
      font-size: 14px;
      line-height: 1.55;
    }
    .help-panel p {
      color: var(--muted-strong);
    }
    .help-panel ul {
      display: grid;
      gap: 7px;
      padding-left: 20px;
    }
    .help-close {
      position: absolute;
      top: 10px;
      right: 10px;
      border: 0;
      padding: 4px 8px;
      background: transparent;
      color: var(--muted-strong);
      font-size: 22px;
      cursor: pointer;
    }
  `;

  override render() {
    const help = pageHelpForRoute(this.routeId, this.pathname, this.search);
    return html`
      <button
        class="help-trigger"
        type="button"
        aria-label=${guideT("platformClaw.guide.openHelp", { title: help.title })}
        title=${guideT("platformClaw.guide.openHelp", { title: help.title })}
        @click=${() => (this.open = true)}
      >
        ${icons.circleQuestionMark}
      </button>
      ${this.open
        ? html`<openclaw-modal-dialog
            .open=${this.open}
            .label=${help.title}
            @modal-cancel=${() => (this.open = false)}
          >
            <section class="help-panel">
              <button
                class="help-close"
                type="button"
                aria-label=${t("platformClaw.voc.close")}
                @click=${() => (this.open = false)}
              >
                ×
              </button>
              <h2>${help.title}</h2>
              <p>${help.body}</p>
              ${help.details.length
                ? html`<ul>
                    ${help.details.map((detail) => html`<li>${detail}</li>`)}
                  </ul>`
                : nothing}
            </section>
          </openclaw-modal-dialog>`
        : nothing}
    `;
  }
}

if (!customElements.get("platformclaw-page-help")) {
  customElements.define("platformclaw-page-help", PlatformClawPageHelpElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "platformclaw-page-help": PlatformClawPageHelpElement;
  }
}
