import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../components/icons.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import "./execution-settings.ts";
import {
  loadPlatformClawLocale,
  platformClawGuideT as guideT,
  platformClawT as t,
} from "./i18n.ts";
import {
  buildPlatformClawTourSteps,
  findChatTerminal,
  findPluginHubElement,
  findSettingsElement,
  findSidebarHome,
  findSidebarRoute,
  findSidebarSettings,
  type TourStep,
} from "./quick-actions-tour.ts";
import "./voc-dialog.ts";

export const PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY = "platformclaw.product-tour.v1.completed";
let activeTourStepId: string | null = null;

type TourLaunch = "automatic" | "manual";
function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isChatRoute(): boolean {
  return /\/chat(?:\/|$)/.test(globalThis.location.pathname);
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

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) {
      this.tourIndex = null;
      globalThis.requestAnimationFrame(() => void this.restoreActiveTourStep());
    }
  }

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
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
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
        position: sticky;
        z-index: 1;
        bottom: -18px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin: 0 -18px -18px;
        padding: 14px 18px 18px;
        background: var(--bg-elevated);
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
    if (await this.restoreActiveTourStep()) {
      return;
    }
    this.requestUpdate();
    await this.launchTour("automatic");
  }

  private async restoreActiveTourStep(): Promise<boolean> {
    const stepId = activeTourStepId;
    if (!this.isConnected || stepId === null) {
      return false;
    }
    await loadPlatformClawLocale();
    const stepIndex = this.tourSteps().findIndex((step) => step.id === stepId);
    if (stepIndex < 0) {
      return false;
    }
    const step = this.tourSteps()[stepIndex];
    if (step?.element && !(await this.waitForElement(() => step.element?.() ?? null))) {
      this.tourIndex = null;
      return true;
    }
    this.tourIndex = stepIndex;
    await this.updateComplete;
    this.addTourListeners();
    this.updateTourPosition();
    return true;
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
    return buildPlatformClawTourSteps({
      tourElement: (selector, shadowSelector) => this.tourElement(selector, shadowSelector),
      findSettingsRoute: (route) => this.findSettingsRoute(route),
      openHomeToTerminal: () => this.openHomeToTerminal(),
      openPluginsHub: () => this.openPluginsHub(),
      activatePluginHubTab: (tab) => this.activatePluginHubTab(tab),
      openSettings: () => this.openSettings(),
      openMemory: () => this.openMemory(),
      activateMemoryTab: (tab) => this.activateMemoryTab(tab),
      openHome: () => this.openHome(),
    });
  }

  private async waitForElement(find: () => Element | null): Promise<Element | null> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const element = find();
      if (element) {
        return element;
      }
      await new Promise<void>((resolve) => {
        globalThis.requestAnimationFrame(() => resolve());
      });
    }
    return null;
  }

  private async waitForTourElement(selector: string): Promise<Element | null> {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const element = findPluginHubElement(selector);
      const rect = element?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        return element;
      }
      await new Promise<void>((resolve) => {
        globalThis.requestAnimationFrame(() => {
          resolve();
        });
      });
    }
    return null;
  }

  private async openPluginsHub(): Promise<void> {
    const link = findSidebarRoute("skills");
    if (!(link instanceof HTMLElement)) {
      return;
    }
    link.click();
    await this.waitForElement(() =>
      globalThis.location.pathname.endsWith("/skills")
        ? findPluginHubElement(".plugins-content-header")
        : null,
    );
  }

  private findSettingsRoute(route: string): Element | null {
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
      ".settings-sidebar__item[href]",
    )) {
      if (new URL(anchor.href, globalThis.location.href).pathname.endsWith(`/${route}`)) {
        return anchor;
      }
    }
    return null;
  }

  private async openSettings(): Promise<void> {
    const button = findSidebarSettings();
    if (!(button instanceof HTMLElement)) {
      return;
    }
    button.click();
    await this.waitForTourElement(".settings-sidebar");
  }

  private async openMemory(): Promise<void> {
    const link = this.findSettingsRoute("settings/memory");
    if (!(link instanceof HTMLElement)) {
      return;
    }
    link.click();
    await this.waitForTourElement(".platformclaw-memory-page__tabs");
  }

  private async openHome(): Promise<void> {
    const settingsBack = document.querySelector<HTMLElement>(".settings-sidebar__back");
    if (!settingsBack && !findSidebarHome()) {
      return;
    }
    settingsBack?.click();
    const home = await this.waitForElement(findSidebarHome);
    if (home instanceof HTMLElement) {
      home.click();
    }
  }

  private async openHomeToTerminal(): Promise<void> {
    await this.openHome();
    await this.waitForElement(findChatTerminal);
  }

  private async activateMemoryTab(tab: string): Promise<void> {
    const selector = `#platformclaw-memory-tab-${tab}`;
    let target = findSettingsElement(selector);
    if (!target) {
      await this.openMemory();
      target = findSettingsElement(selector);
    }
    if (!target) {
      return;
    }
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    await this.waitForTourElement(selector);
  }

  private async activatePluginHubTab(tab: string): Promise<void> {
    const standaloneRoute =
      tab === "skills" ? "skills" : tab === "workshop" ? "skills/workshop" : "skills/hub";
    if (tab === "skills" || tab === "workshop" || tab === "skill-hub") {
      const link = findSidebarRoute(standaloneRoute);
      if (!(link instanceof HTMLElement)) {
        return;
      }
      link.click();
      const expectedPath =
        tab === "skills" ? "/skills" : tab === "workshop" ? "/skills/workshop" : "/skills/hub";
      await this.waitForElement(() =>
        globalThis.location.pathname.endsWith(expectedPath)
          ? findPluginHubElement(".plugins-content-header")
          : null,
      );
      return;
    }
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
      if (!isChatRoute()) {
        return;
      }
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
      activeTourStepId = this.tourSteps()[0]?.id ?? null;
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
    activeTourStepId = null;
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
      this.tourIndex = nextIndex;
      activeTourStepId = nextStep?.id ?? null;
      await this.updateComplete;
      await nextStep?.activate?.();
      if (!this.isConnected) {
        return;
      }
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
