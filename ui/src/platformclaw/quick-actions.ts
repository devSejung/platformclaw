import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../components/icons.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import {
  loadPlatformClawLocale,
  platformClawGuideT as guideT,
  platformClawT as t,
} from "./i18n.ts";
import "./execution-settings.ts";
import "./voc-dialog.ts";

export const PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY = "platformclaw.product-tour.v1.completed";

type TourLaunch = "automatic" | "manual";
type TourStep = {
  title: string;
  body: string;
  details?: string[];
  element?: () => Element | null;
  activate?: () => void | Promise<void>;
};

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function findSidebarRoute(...routes: string[]): Element | null {
  const sidebar = document.querySelector("openclaw-app-sidebar");
  const roots = [sidebar, sidebar?.shadowRoot].filter(Boolean) as ParentNode[];
  for (const root of roots) {
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a.nav-item[href]")) {
      try {
        const pathname = new URL(anchor.href, globalThis.location.href).pathname;
        if (routes.some((route) => pathname.endsWith(`/${route}`))) {
          return anchor;
        }
      } catch {
        // Ignore malformed non-navigation links from optional product content.
      }
    }
  }
  return null;
}

function findSidebarHome(): Element | null {
  const sidebar = document.querySelector("openclaw-app-sidebar");
  return (sidebar?.shadowRoot?.querySelector(".nav-item--home") ??
    sidebar?.querySelector(".nav-item--home")) as Element | null;
}

function findPluginHubElement(selector: string): Element | null {
  return document.querySelector(selector);
}

export class PlatformClawQuickActionsElement extends OpenClawLitElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => undefined;
  @property({ type: Boolean }) admin = false;
  @property({ type: Boolean }) vocEnabled = false;
  @state() private guideError = "";
  @state() private guideLoading = false;
  @state() private guideMoving = false;
  @state() private vocOpen = false;
  @state() private tourIndex: number | null = null;
  @state() private tourHighlightStyle = "";
  @state() private tourPopoverStyle = "";
  @state() private tourShadeStyles: string[] = [];

  private automaticLaunchAttempted = false;

  static override styles = [
    css`
      :host {
        display: grid;
        min-width: 0;
        gap: 4px;
      }
      .grid {
        display: grid;
        min-width: 0;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 4px;
      }
      platformclaw-execution-settings,
      platformclaw-vm-administration,
      .action {
        min-width: 0;
      }
      .action {
        box-sizing: border-box;
        display: flex;
        width: 100%;
        min-height: 34px;
        align-items: center;
        gap: 7px;
        overflow: hidden;
        border: 0;
        border-radius: var(--radius-md);
        padding: 7px 9px;
        background: transparent;
        color: var(--muted-strong);
        font: 13px/1.45 var(--font-sans, system-ui, sans-serif);
        text-align: left;
        text-decoration: none;
        cursor: pointer;
        transition:
          background var(--duration-fast) ease,
          color var(--duration-fast) ease;
      }
      .action:hover,
      .action:focus-visible {
        background: var(--bg-hover);
        color: var(--text);
        outline: none;
      }
      .action:disabled {
        cursor: wait;
        opacity: 0.65;
      }
      .action svg {
        width: 16px;
        height: 16px;
        flex: none;
      }
      .label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .span-two {
        grid-column: 1 / -1;
      }
      .error {
        margin: 0;
        padding: 2px 9px 0;
        color: var(--danger);
        font: 12px/1.4 var(--font-sans, system-ui, sans-serif);
      }
      .tour-layer {
        position: fixed;
        z-index: 10000;
        inset: 0;
        pointer-events: none;
      }
      .tour-dismiss-layer {
        position: absolute;
        inset: 0;
        pointer-events: auto;
      }
      .tour-shade {
        position: fixed;
        background: rgb(5 7 10 / 48%);
        pointer-events: none;
      }
      .tour-highlight {
        position: fixed;
        box-sizing: border-box;
        border: 3px solid var(--accent);
        border-radius: 12px;
        box-shadow: 0 0 0 3px var(--accent);
        pointer-events: none;
        transition: all 180ms ease;
      }
      .tour-target-label {
        position: absolute;
        right: 6px;
        bottom: calc(100% + 7px);
        border-radius: 999px;
        padding: 5px 9px;
        background: var(--accent);
        color: var(--accent-foreground);
        box-shadow: var(--shadow-md);
        font: 700 11px/1.2 var(--font-sans, system-ui, sans-serif);
        white-space: nowrap;
      }
      .tour-popover {
        position: fixed;
        box-sizing: border-box;
        width: min(360px, calc(100vw - 32px));
        max-height: calc(100vh - 32px);
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-xl);
        padding: 18px;
        background: var(--bg-elevated);
        color: var(--text);
        box-shadow: var(--shadow-xl);
        pointer-events: auto;
      }
      .tour-close {
        position: absolute;
        top: 8px;
        right: 8px;
        border: 0;
        padding: 4px 8px;
        background: transparent;
        color: var(--muted-strong);
        font-size: 22px;
        cursor: pointer;
      }
      .tour-popover h2 {
        margin: 0 28px 8px 0;
        font-size: 17px;
      }
      .tour-popover p {
        margin: 0;
        color: var(--muted-strong);
        font-size: 14px;
        line-height: 1.55;
      }
      .tour-popover ul {
        display: grid;
        gap: 7px;
        margin: 12px 0 0;
        padding-left: 19px;
        color: var(--text);
        font-size: 13px;
        line-height: 1.5;
      }
      .tour-progress {
        padding-top: 14px;
        font-size: 12px;
        color: var(--muted);
      }
      .tour-footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding-top: 14px;
      }
      .tour-footer button {
        min-height: 32px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        padding: 6px 11px;
        background: var(--bg);
        color: var(--text);
        font: 600 12px/1.4 var(--font-sans, system-ui, sans-serif);
        cursor: pointer;
      }
      .tour-footer .tour-never {
        margin-right: auto;
        border: 0;
        padding-inline: 0;
        background: transparent;
        color: var(--muted);
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .tour-footer .tour-next {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--accent-foreground);
      }
      @media (prefers-reduced-motion: reduce) {
        .tour-highlight {
          transition: none;
        }
      }
    `,
  ];

  override disconnectedCallback(): void {
    this.removeTourListeners();
    super.disconnectedCallback();
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    globalThis.requestAnimationFrame(() => void this.initialize());
  }

  private async initialize(): Promise<void> {
    await loadPlatformClawLocale();
    if (!this.isConnected) {
      return;
    }
    this.requestUpdate();
    await this.launchTour("automatic");
  }

  private completeTour(): void {
    try {
      browserStorage()?.setItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY, "true");
    } catch {
      // Completion is browser-local convenience state; storage denial must not trap the tour.
    }
  }

  private tourElement(selector: string, shadowSelector?: string): Element {
    const element = this.renderRoot.querySelector(selector);
    if (!shadowSelector) {
      return element as Element;
    }
    return (element?.shadowRoot?.querySelector(shadowSelector) ?? element) as Element;
  }

  private tourSteps(): TourStep[] {
    const catalogTabsAvailable = Boolean(findSidebarRoute("settings/plugins"));
    const pluginCatalogSteps: TourStep[] = catalogTabsAvailable
      ? [
          {
            title: guideT("platformClaw.guide.installedPluginsTitle"),
            body: guideT("platformClaw.guide.installedPluginsBody"),
            details: guideT("platformClaw.guide.installedPluginsDetails").split("|"),
            element: () => findPluginHubElement("#plugins-tab-installed"),
            activate: () => this.activatePluginHubTab("installed"),
          },
          {
            title: guideT("platformClaw.guide.discoverPluginsTitle"),
            body: guideT("platformClaw.guide.discoverPluginsBody"),
            details: guideT("platformClaw.guide.discoverPluginsDetails").split("|"),
            element: () => findPluginHubElement("#plugins-tab-discover"),
            activate: () => this.activatePluginHubTab("discover"),
          },
        ]
      : [];
    return [
      {
        title: guideT("platformClaw.guide.welcomeTitle"),
        body: guideT("platformClaw.guide.welcomeBody"),
      },
      {
        title: guideT("platformClaw.guide.chatTitle"),
        body: guideT("platformClaw.guide.chatBody"),
        details: guideT("platformClaw.guide.chatDetails").split("|"),
        element: findSidebarHome,
      },
      {
        title: guideT("platformClaw.guide.usageTitle"),
        body: guideT("platformClaw.guide.usageBody"),
        details: guideT("platformClaw.guide.usageDetails").split("|"),
        element: () => findSidebarRoute("usage"),
      },
      {
        title: guideT("platformClaw.guide.tasksTitle"),
        body: guideT("platformClaw.guide.tasksBody"),
        details: guideT("platformClaw.guide.tasksDetails").split("|"),
        element: () => findSidebarRoute("tasks"),
      },
      {
        title: guideT("platformClaw.guide.sessionsTitle"),
        body: guideT("platformClaw.guide.sessionsBody"),
        details: guideT("platformClaw.guide.sessionsDetails").split("|"),
        element: () => findSidebarRoute("sessions"),
      },
      {
        title: guideT("platformClaw.guide.activityTitle"),
        body: guideT("platformClaw.guide.activityBody"),
        details: guideT("platformClaw.guide.activityDetails").split("|"),
        element: () => findSidebarRoute("activity"),
      },
      {
        title: guideT("platformClaw.guide.automationsTitle"),
        body: guideT("platformClaw.guide.automationsBody"),
        details: guideT("platformClaw.guide.automationsDetails").split("|"),
        element: () => findSidebarRoute("automations", "cron"),
      },
      {
        title: guideT("platformClaw.guide.pluginsNavTitle"),
        body: guideT("platformClaw.guide.pluginsNavBody"),
        details: guideT("platformClaw.guide.pluginsNavDetails").split("|"),
        element: () => findSidebarRoute("settings/plugins", "skills"),
      },
      {
        title: guideT("platformClaw.guide.workLocationTitle"),
        body: guideT("platformClaw.guide.workLocationBody"),
        element: () => this.tourElement("platformclaw-execution-settings", '[data-action="open"]'),
      },
      {
        title: guideT("platformClaw.guide.pluginsTitle"),
        body: guideT("platformClaw.guide.pluginsBody"),
        details: guideT("platformClaw.guide.pluginsDetails").split("|"),
        element: () => findPluginHubElement(".plugins-hub-tabs-row"),
        activate: () => this.openPluginsHub(),
      },
      ...pluginCatalogSteps,
      {
        title: guideT("platformClaw.guide.skillsTitle"),
        body: guideT("platformClaw.guide.skillsBody"),
        details: guideT("platformClaw.guide.skillsDetails").split("|"),
        element: () => findPluginHubElement("#plugins-tab-skills"),
        activate: () => this.activatePluginHubTab("skills"),
      },
      {
        title: guideT("platformClaw.guide.workshopTitle"),
        body: guideT("platformClaw.guide.workshopBody"),
        details: guideT("platformClaw.guide.workshopDetails").split("|"),
        element: () => findPluginHubElement("#plugins-tab-workshop"),
        activate: () => this.activatePluginHubTab("workshop"),
      },
      {
        title: guideT("platformClaw.guide.skillHubTitle"),
        body: guideT("platformClaw.guide.skillHubBody"),
        details: guideT("platformClaw.guide.skillHubDetails").split("|"),
        element: () => findPluginHubElement("#plugins-tab-skill-hub"),
        activate: () => this.activatePluginHubTab("skill-hub"),
      },
      {
        title: guideT("platformClaw.guide.reopenTitle"),
        body: guideT("platformClaw.guide.reopenBody"),
        element: () => this.tourElement('[data-tour="guide"]'),
      },
    ];
  }

  private async waitForTourElement(selector: string): Promise<Element | null> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const element = findPluginHubElement(selector);
      const rect = element?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        return element;
      }
      await new Promise<void>((resolve) =>
        globalThis.requestAnimationFrame(() => {
          resolve();
        }),
      );
    }
    return null;
  }

  private async openPluginsHub(): Promise<void> {
    const link = findSidebarRoute("settings/plugins", "skills", "skills/workshop", "skills/hub");
    if (!(link instanceof HTMLElement)) {
      return;
    }
    link.click();
    await this.waitForTourElement(".plugins-hub-tabs-row");
    await this.waitForTourElement("#plugins-tab-skills, #plugins-tab-installed");
  }

  private async activatePluginHubTab(tab: string): Promise<void> {
    let target = findPluginHubElement(`#plugins-tab-${tab}`);
    if (!target) {
      await this.openPluginsHub();
      target = findPluginHubElement(`#plugins-tab-${tab}`);
    }
    if (!target) {
      return;
    }
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    await this.waitForTourElement(`#plugins-tab-${tab}`);
  }

  private async launchTour(launch: TourLaunch): Promise<void> {
    if (launch === "automatic") {
      if (this.automaticLaunchAttempted) {
        return;
      }
      this.automaticLaunchAttempted = true;
      if (browserStorage()?.getItem(PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY) === "true") {
        return;
      }
    }
    if (this.guideLoading) {
      return;
    }
    this.guideLoading = true;
    this.guideError = "";
    try {
      await loadPlatformClawLocale();
      this.tourIndex = 0;
      await this.updateComplete;
      this.addTourListeners();
      this.updateTourPosition();
    } catch {
      this.guideError = guideT("platformClaw.guide.unavailable");
    } finally {
      this.guideLoading = false;
    }
  }

  private readonly updateTourPosition = (): void => {
    if (this.tourIndex === null) {
      return;
    }
    this.positionTourStep(this.tourSteps()[this.tourIndex]);
  };

  private positionTourStep(step: TourStep | undefined): void {
    const target = step?.element?.();
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      this.tourHighlightStyle = "display:none";
      this.tourShadeStyles = ["inset:0"];
      this.tourPopoverStyle = "left:50%;top:50%;transform:translate(-50%,-50%)";
      return;
    }
    const padding = 7;
    const left = Math.max(8, rect.left - padding);
    const top = Math.max(8, rect.top - padding);
    const right = Math.min(globalThis.innerWidth - 8, rect.right + padding);
    const bottom = Math.min(globalThis.innerHeight - 8, rect.bottom + padding);
    const width = right - left;
    const height = bottom - top;
    this.tourHighlightStyle = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
    this.tourShadeStyles = [
      `left:0;top:0;width:100vw;height:${top}px`,
      `left:0;top:${top}px;width:${left}px;height:${height}px`,
      `left:${right}px;top:${top}px;right:0;height:${height}px`,
      `left:0;top:${bottom}px;width:100vw;bottom:0`,
    ];
    const popoverWidth = Math.min(360, globalThis.innerWidth - 32);
    const popoverHeight =
      this.renderRoot.querySelector(".tour-popover")?.getBoundingClientRect().height ?? 260;
    const fitsRight = rect.right + 16 + popoverWidth <= globalThis.innerWidth;
    const fitsLeft = rect.left - 16 - popoverWidth >= 0;
    let popoverLeft: number;
    let popoverTop: number;
    if (fitsRight || fitsLeft) {
      popoverLeft = fitsRight ? rect.right + 16 : rect.left - popoverWidth - 16;
      popoverTop = Math.max(16, Math.min(rect.top, globalThis.innerHeight - popoverHeight - 16));
    } else {
      popoverLeft = Math.max(16, Math.min(rect.left, globalThis.innerWidth - popoverWidth - 16));
      popoverTop =
        rect.bottom + 16 + popoverHeight <= globalThis.innerHeight
          ? rect.bottom + 16
          : Math.max(16, rect.top - popoverHeight - 16);
    }
    this.tourPopoverStyle = `left:${popoverLeft}px;top:${popoverTop}px`;
  }

  private readonly onTourKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.closeTour();
    }
  };

  private addTourListeners(): void {
    globalThis.addEventListener("resize", this.updateTourPosition);
    globalThis.addEventListener("scroll", this.updateTourPosition, true);
    globalThis.addEventListener("keydown", this.onTourKeydown);
  }

  private removeTourListeners(): void {
    globalThis.removeEventListener("resize", this.updateTourPosition);
    globalThis.removeEventListener("scroll", this.updateTourPosition, true);
    globalThis.removeEventListener("keydown", this.onTourKeydown);
  }

  private closeTour(): void {
    this.tourIndex = null;
    this.removeTourListeners();
  }

  private async moveTour(direction: -1 | 1): Promise<void> {
    if (this.tourIndex === null || this.guideMoving) {
      return;
    }
    const next = this.tourIndex + direction;
    if (next >= this.tourSteps().length) {
      this.completeTour();
      this.closeTour();
      return;
    }
    const nextIndex = Math.max(0, next);
    this.guideMoving = true;
    try {
      const nextStep = this.tourSteps()[nextIndex];
      await nextStep?.activate?.();
      this.positionTourStep(nextStep);
      this.tourIndex = nextIndex;
      await this.updateComplete;
      this.positionTourStep(nextStep);
    } finally {
      this.guideMoving = false;
    }
  }

  private renderTour() {
    if (this.tourIndex === null) {
      return null;
    }
    const steps = this.tourSteps();
    const step = steps[this.tourIndex];
    if (!step) {
      return null;
    }
    const finalStep = this.tourIndex === steps.length - 1;
    return html`<div class="tour-layer">
      <div class="tour-dismiss-layer" @click=${() => this.closeTour()}></div>
      ${this.tourShadeStyles.map((style) => html`<div class="tour-shade" style=${style}></div>`)}
      <div class="tour-highlight" style=${this.tourHighlightStyle}>
        <span class="tour-target-label">${guideT("platformClaw.guide.clickTarget")}</span>
      </div>
      <section
        class="tour-popover"
        style=${this.tourPopoverStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="platformclaw-tour-title"
      >
        <button
          class="tour-close"
          type="button"
          aria-label=${t("platformClaw.voc.close")}
          @click=${() => this.closeTour()}
        >
          ×
        </button>
        <h2 id="platformclaw-tour-title">${step.title}</h2>
        <p>${step.body}</p>
        ${step.details?.length
          ? html`<ul>
              ${step.details.map((detail) => html`<li>${detail}</li>`)}
            </ul>`
          : null}
        <div class="tour-progress">
          ${guideT("platformClaw.guide.progress", {
            current: String(this.tourIndex + 1),
            total: String(steps.length),
          })}
        </div>
        <div class="tour-footer">
          <button
            class="tour-never"
            type="button"
            @click=${() => {
              this.completeTour();
              this.closeTour();
            }}
          >
            ${guideT("platformClaw.guide.neverShowAgain")}
          </button>
          ${this.tourIndex > 0
            ? html`<button
                type="button"
                ?disabled=${this.guideMoving}
                @click=${() => void this.moveTour(-1)}
              >
                ${guideT("platformClaw.guide.previous")}
              </button>`
            : null}
          <button
            class="tour-next"
            type="button"
            ?disabled=${this.guideMoving}
            @click=${() => void this.moveTour(1)}
          >
            ${guideT(finalStep ? "platformClaw.guide.done" : "platformClaw.guide.next")}
          </button>
        </div>
      </section>
    </div>`;
  }

  override render() {
    return html`
      <div class="grid" aria-label=${t("platformClaw.quickActions.label")}>
        ${this.vocEnabled
          ? html`<button
              class="action"
              type="button"
              data-tour="voc"
              @click=${() => (this.vocOpen = true)}
              aria-label=${t("platformClaw.quickActions.voc")}
            >
              ${icons.messageSquare}<span class="label">${t("platformClaw.quickActions.voc")}</span>
            </button>`
          : null}
        <button
          type="button"
          class="action ${this.vocEnabled ? "" : "span-two"}"
          data-tour="guide"
          ?disabled=${this.guideLoading}
          @click=${() => void this.launchTour("manual")}
          aria-label=${t("platformClaw.quickActions.guide")}
        >
          ${icons.book}<span class="label">${t("platformClaw.quickActions.guide")}</span>
        </button>
        <platformclaw-execution-settings
          class=${this.admin ? "" : "span-two"}
          data-tour="work-location"
          .compactLabelKey=${"platformClaw.quickActions.vmServer"}
          .fetchImpl=${this.fetchImpl}
          .onUnauthenticated=${this.onUnauthenticated}
        ></platformclaw-execution-settings>
        ${this.admin
          ? html`<platformclaw-vm-administration
              data-tour="vm-admin"
              .fetchImpl=${this.fetchImpl}
              .onUnauthenticated=${this.onUnauthenticated}
            ></platformclaw-vm-administration>`
          : null}
      </div>
      ${this.guideError ? html`<p class="error" role="status">${this.guideError}</p>` : null}
      ${this.vocOpen
        ? html`<platformclaw-voc-dialog
            .fetchImpl=${this.fetchImpl}
            .onUnauthenticated=${this.onUnauthenticated}
            @voc-close=${() => (this.vocOpen = false)}
          ></platformclaw-voc-dialog>`
        : null}
      ${this.renderTour()}
    `;
  }
}

if (!customElements.get("platformclaw-quick-actions")) {
  customElements.define("platformclaw-quick-actions", PlatformClawQuickActionsElement);
}
