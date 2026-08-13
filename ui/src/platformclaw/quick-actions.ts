import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../components/icons.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import "./execution-settings.ts";
import "./voc-dialog.ts";

export const PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY = "platformclaw.product-tour.v1.completed";

type TourLaunch = "automatic" | "manual";
type TourStep = {
  title: string;
  body: string;
  element?: () => Element | null;
};

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function findSidebarRoute(route: string): Element {
  const sidebar = document.querySelector("openclaw-app-sidebar");
  const roots = [sidebar, sidebar?.shadowRoot].filter(Boolean) as ParentNode[];
  for (const root of roots) {
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      try {
        if (new URL(anchor.href, globalThis.location.href).pathname.endsWith(`/${route}`)) {
          return anchor;
        }
      } catch {
        // Ignore malformed non-navigation links from optional product content.
      }
    }
  }
  return undefined as unknown as Element;
}

function findSidebarHome(): Element {
  const sidebar = document.querySelector("openclaw-app-sidebar");
  return (sidebar?.shadowRoot?.querySelector(".nav-item--home") ??
    sidebar?.querySelector(".nav-item--home")) as Element;
}

export class PlatformClawQuickActionsElement extends OpenClawLitElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => undefined;
  @property({ type: Boolean }) admin = false;
  @property({ type: Boolean }) vocEnabled = false;
  @state() private guideError = "";
  @state() private guideLoading = false;
  @state() private vocOpen = false;
  @state() private tourIndex: number | null = null;
  @state() private tourHighlightStyle = "";
  @state() private tourPopoverStyle = "";

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
      .tour-backdrop {
        position: absolute;
        inset: 0;
        background: rgb(5 7 10 / 76%);
        pointer-events: auto;
      }
      .tour-highlight {
        position: fixed;
        border: 2px solid var(--accent);
        border-radius: 10px;
        box-shadow: 0 0 0 9999px rgb(5 7 10 / 76%);
        pointer-events: none;
        transition: all 180ms ease;
      }
      .tour-popover {
        position: fixed;
        box-sizing: border-box;
        width: min(360px, calc(100vw - 32px));
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
    return [
      {
        title: t("platformClaw.guide.welcomeTitle"),
        body: t("platformClaw.guide.welcomeBody"),
      },
      {
        title: t("platformClaw.guide.chatTitle"),
        body: t("platformClaw.guide.chatBody"),
        element: findSidebarHome,
      },
      {
        title: t("platformClaw.guide.sessionsTitle"),
        body: t("platformClaw.guide.sessionsBody"),
        element: () => findSidebarRoute("sessions"),
      },
      {
        title: t("platformClaw.guide.tasksTitle"),
        body: t("platformClaw.guide.tasksBody"),
        element: () => findSidebarRoute("tasks"),
      },
      {
        title: t("platformClaw.guide.workLocationTitle"),
        body: t("platformClaw.guide.workLocationBody"),
        element: () => this.tourElement("platformclaw-execution-settings", '[data-action="open"]'),
      },
      {
        title: t("platformClaw.guide.skillsTitle"),
        body: t("platformClaw.guide.skillsBody"),
        element: () => findSidebarRoute("skills"),
      },
      {
        title: t("platformClaw.guide.reopenTitle"),
        body: t("platformClaw.guide.reopenBody"),
        element: () => this.tourElement('[data-tour="guide"]'),
      },
    ];
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
      this.guideError = t("platformClaw.guide.unavailable");
    } finally {
      this.guideLoading = false;
    }
  }

  private readonly updateTourPosition = (): void => {
    if (this.tourIndex === null) {
      return;
    }
    const target = this.tourSteps()[this.tourIndex]?.element?.();
    const rect = target?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      this.tourHighlightStyle = "display:none";
      this.tourPopoverStyle = "left:50%;top:50%;transform:translate(-50%,-50%)";
      return;
    }
    const padding = 7;
    const left = Math.max(8, rect.left - padding);
    const top = Math.max(8, rect.top - padding);
    this.tourHighlightStyle = `left:${left}px;top:${top}px;width:${rect.width + padding * 2}px;height:${rect.height + padding * 2}px`;
    const popoverWidth = Math.min(360, globalThis.innerWidth - 32);
    const beside = rect.right + 16 + popoverWidth <= globalThis.innerWidth;
    const popoverLeft = beside
      ? rect.right + 16
      : Math.max(16, Math.min(rect.left, globalThis.innerWidth - popoverWidth - 16));
    const popoverTop = Math.max(16, Math.min(rect.top, globalThis.innerHeight - 260));
    this.tourPopoverStyle = `left:${popoverLeft}px;top:${popoverTop}px`;
  };

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

  private moveTour(direction: -1 | 1): void {
    if (this.tourIndex === null) {
      return;
    }
    const next = this.tourIndex + direction;
    if (next >= this.tourSteps().length) {
      this.completeTour();
      this.closeTour();
      return;
    }
    this.tourIndex = Math.max(0, next);
    void this.updateComplete.then(this.updateTourPosition);
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
      <div class="tour-backdrop" @click=${() => this.closeTour()}></div>
      <div class="tour-highlight" style=${this.tourHighlightStyle}></div>
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
        <div class="tour-progress">
          ${t("platformClaw.guide.progress", {
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
            ${t("platformClaw.guide.neverShowAgain")}
          </button>
          ${this.tourIndex > 0
            ? html`<button type="button" @click=${() => this.moveTour(-1)}>
                ${t("platformClaw.guide.previous")}
              </button>`
            : null}
          <button class="tour-next" type="button" @click=${() => this.moveTour(1)}>
            ${t(finalStep ? "platformClaw.guide.done" : "platformClaw.guide.next")}
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
