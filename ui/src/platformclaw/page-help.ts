import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { subtitleForRoute, titleForRoute } from "../app-navigation.ts";
import { INTERNAL_MEMORY_PATH_PARAM, type RouteId } from "../app-route-paths.ts";
import { icons } from "../components/icons.ts";
import "../components/modal-dialog.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import {
  loadPlatformClawLocale,
  platformClawGuideT as guideT,
  platformClawT as t,
} from "./i18n.ts";

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

class PlatformClawPageHelpTriggerElement extends OpenClawLitElement {
  @property() label = "";

  static override styles = css`
    :host {
      display: inline-flex;
      margin-left: 8px;
      vertical-align: 2px;
    }
    button {
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
    button:hover,
    button:focus-visible {
      border-color: var(--accent);
      color: var(--accent);
      outline: none;
    }
    svg {
      width: 16px;
      height: 16px;
    }
  `;

  override render() {
    return html`<button
      type="button"
      aria-label=${this.label}
      title=${this.label}
      @click=${() =>
        this.dispatchEvent(
          new CustomEvent("platformclaw-page-help-open", { bubbles: true, composed: true }),
        )}
    >
      ${icons.circleQuestionMark}
    </button>`;
  }
}

export class PlatformClawPageHelpElement extends OpenClawLitElement {
  @property() routeId: RouteId = "chat";
  @property() pathname = "";
  @property() search = "";
  @state() private open = false;
  private trigger: PlatformClawPageHelpTriggerElement | null = null;
  private triggerAnchor: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private readonly openHelp = () => {
    this.open = true;
  };

  static override styles = css`
    :host {
      display: contents;
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

  override connectedCallback(): void {
    super.connectedCallback();
    this.observer = new MutationObserver(() => this.syncTrigger());
    this.observer.observe(this.parentElement ?? document.body, { childList: true, subtree: true });
    void loadPlatformClawLocale().then(() => this.requestUpdate());
    queueMicrotask(() => this.syncTrigger());
  }

  override disconnectedCallback(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.trigger?.remove();
    this.trigger = null;
    this.clearTriggerAnchor();
    super.disconnectedCallback();
  }

  protected override updated(): void {
    this.syncTrigger();
  }

  private syncTrigger(): void {
    const root = this.closest("#control-ui-main") ?? document;
    const selectors = [".page-title"];
    if (this.routeId === "chat" || this.routeId === "dashboard" || this.routeId === "new-session") {
      selectors.unshift(".chat-pane__session-title");
    }
    const anchor = selectors
      .flatMap((selector) => Array.from(root.querySelectorAll<HTMLElement>(selector)))
      .find((candidate) => this.isVisible(candidate));
    if (!anchor) {
      this.trigger?.remove();
      this.clearTriggerAnchor();
      return;
    }
    if (!this.trigger) {
      this.trigger = document.createElement(
        "platformclaw-page-help-trigger",
      ) as PlatformClawPageHelpTriggerElement;
      this.trigger.addEventListener("platformclaw-page-help-open", this.openHelp);
    }
    const help = pageHelpForRoute(this.routeId, this.pathname, this.search);
    this.trigger.label = guideT("platformClaw.guide.openHelp", { title: help.title });
    if (this.triggerAnchor !== anchor) {
      this.clearTriggerAnchor();
      this.triggerAnchor = anchor;
      anchor.classList.add("platformclaw-page-help-anchor");
    }
    if (anchor.nextElementSibling !== this.trigger) {
      // Keep the control next to, rather than inside, the title. Heading names
      // must remain stable for assistive technology and exact-name automation.
      anchor.after(this.trigger);
    }
  }

  private clearTriggerAnchor(): void {
    this.triggerAnchor?.classList.remove("platformclaw-page-help-anchor");
    this.triggerAnchor = null;
  }

  private isVisible(candidate: HTMLElement): boolean {
    for (let element: HTMLElement | null = candidate; element; element = element.parentElement) {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
    }
    return true;
  }

  override render() {
    const help = pageHelpForRoute(this.routeId, this.pathname, this.search);
    if (!this.open) {
      return nothing;
    }
    return html`
      <openclaw-modal-dialog
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
            : null}
        </section>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("platformclaw-page-help")) {
  customElements.define("platformclaw-page-help", PlatformClawPageHelpElement);
}
if (!customElements.get("platformclaw-page-help-trigger")) {
  customElements.define("platformclaw-page-help-trigger", PlatformClawPageHelpTriggerElement);
}

declare global {
  interface HTMLElementTagNameMap {
    "platformclaw-page-help": PlatformClawPageHelpElement;
    "platformclaw-page-help-trigger": PlatformClawPageHelpTriggerElement;
  }
}
