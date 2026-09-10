import { consume } from "@lit/context";
import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { mobileNavLayoutMediaQuery } from "../app/mobile-nav-layout.ts";
import { icons } from "../components/icons.ts";
import { isTerminalAvailable } from "../lib/terminal-availability.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "./execution-settings.ts";
import {
  loadPlatformClawLocale,
  platformClawGuideT as guideT,
  platformClawT as t,
} from "./i18n.ts";
import { quickActionsTourStyles } from "./quick-actions-tour-styles.ts";
import { renderPlatformClawTour } from "./quick-actions-tour-view.ts";
import {
  buildPlatformClawTourSteps,
  findChatTerminal,
  findPluginHubElement,
  findSettingsElement,
  findSettingsRoute,
  findSidebarHome,
  findSidebarRoute,
  findSidebarSettings,
  waitForElement,
  waitForTourTarget,
  type TourStep,
} from "./quick-actions-tour.ts";
import "./voc-dialog.ts";

export const PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY = "platformclaw.product-tour.v1.completed";
let activeTourStepId: string | null = null;
// Settings replaces the sidebar. Keep optional steps stable for the whole walkthrough.
let activeTourStepIds: string[] | null = null;

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
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => undefined;
  @property({ type: Boolean }) admin = false;
  @property({ type: Boolean }) vocEnabled = false;
  @state() private guideError = "";
  @state() private guideLoading = false;
  @state() private guideMoving = false;
  @state() private mobileNavLayout = false;
  @state() private vocOpen = false;
  @state() private tourIndex: number | null = null;
  @state() private tourHighlightStyle = "";
  @state() private tourPopoverStyle = "";
  @state() private tourShadeStyles: string[] = [];

  private automaticLaunchAttempted = false;
  private initialized = false;
  private mobileNavMediaQuery: MediaQueryList | null = null;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override connectedCallback(): void {
    super.connectedCallback();
    this.mobileNavMediaQuery?.removeEventListener("change", this.handleMobileNavViewportChange);
    this.mobileNavMediaQuery = globalThis.matchMedia?.(mobileNavLayoutMediaQuery()) ?? null;
    this.mobileNavLayout = this.mobileNavMediaQuery?.matches ?? false;
    this.mobileNavMediaQuery?.addEventListener("change", this.handleMobileNavViewportChange);
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
    `,
    quickActionsTourStyles,
  ];

  override disconnectedCallback(): void {
    this.subscriptions.clear();
    this.mobileNavMediaQuery?.removeEventListener("change", this.handleMobileNavViewportChange);
    this.mobileNavMediaQuery = null;
    this.removeTourListeners();
    super.disconnectedCallback();
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    globalThis.requestAnimationFrame(() => void this.initialize());
  }

  protected override updated(): void {
    if (this.initialized && !this.guideLoading && activeTourStepId === null) {
      void this.launchTour("automatic");
    }
  }

  private async initialize(): Promise<void> {
    await loadPlatformClawLocale();
    if (!this.isConnected) {
      return;
    }
    const restored = await this.restoreActiveTourStep();
    this.initialized = true;
    if (restored) {
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
    this.automaticLaunchAttempted = true;
    await loadPlatformClawLocale();
    const stepIndex = this.tourSteps().findIndex((step) => step.id === stepId);
    if (stepIndex < 0) {
      return false;
    }
    const step = this.tourSteps()[stepIndex];
    if (
      step?.element &&
      !(await waitForTourTarget(
        () => step.element?.() ?? null,
        stepId,
        (currentStepId) => this.isConnected && activeTourStepId === currentStepId,
      ))
    ) {
      this.tourIndex = null;
      return true;
    }
    if (!this.isConnected || activeTourStepId !== stepId) {
      return true;
    }
    this.tourIndex = stepIndex;
    await this.updateComplete;
    if (!this.isConnected || activeTourStepId !== stepId) {
      return true;
    }
    this.addTourListeners();
    this.updateTourPosition();
    this.focusTour();
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
    return buildPlatformClawTourSteps(
      {
        tourElement: (selector, shadowSelector) => this.tourElement(selector, shadowSelector),
        findSettingsRoute,
        openHomeToTerminal: () => this.openHomeToTerminal(),
        openSidebar: () => this.openSidebar(),
        activatePluginHubTab: (tab) => this.activatePluginHubTab(tab),
        openSettings: () => this.openSettings(),
        openMemory: () => this.openMemory(),
        activateMemoryTab: (tab) => this.activateMemoryTab(tab),
        openHome: () => this.openHome(),
      },
      activeTourStepIds,
      this.context
        ? isTerminalAvailable(
            this.context.gateway.snapshot,
            this.context.config.current.terminalEnabled,
          )
        : undefined,
    );
  }

  private async openSidebar(): Promise<boolean> {
    return document.querySelector(".settings-sidebar")
      ? this.openHome()
      : Boolean(findSidebarHome());
  }

  private async openSettings(): Promise<boolean> {
    if (document.querySelector(".settings-sidebar")) {
      return true;
    }
    const button = findSidebarSettings();
    if (!(button instanceof HTMLElement)) {
      return false;
    }
    button.click();
    return Boolean(await waitForElement(() => findSettingsElement(".settings-sidebar")));
  }

  private async openMemory(): Promise<boolean> {
    await this.openSettings();
    const link = findSettingsRoute("settings/memory");
    if (!(link instanceof HTMLElement)) {
      return false;
    }
    link.click();
    return Boolean(
      await waitForElement(() => findSettingsElement(".platformclaw-memory-page__tabs")),
    );
  }

  private async openHome(): Promise<boolean> {
    if (isChatRoute() && findSidebarHome()) {
      return true;
    }
    const settingsBack = document.querySelector<HTMLElement>(".settings-sidebar__back");
    if (!settingsBack && !findSidebarHome()) {
      return false;
    }
    settingsBack?.click();
    const home = await waitForElement(findSidebarHome);
    if (home instanceof HTMLElement) {
      home.click();
      return true;
    }
    return false;
  }

  private async openHomeToTerminal(): Promise<boolean> {
    await this.openHome();
    return Boolean(await waitForElement(findChatTerminal));
  }

  private async activateMemoryTab(tab: string): Promise<boolean> {
    const selector = `#platformclaw-memory-tab-${tab}`;
    let target = findSettingsElement(selector);
    if (!target) {
      await this.openMemory();
      target = findSettingsElement(selector);
    }
    if (!target) {
      return false;
    }
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    return Boolean(await waitForElement(() => findSettingsElement(selector)));
  }

  private async activatePluginHubTab(tab: string): Promise<boolean> {
    let target = findPluginHubElement(`#plugins-tab-${tab}`);
    if (!target) {
      await this.openSidebar();
      const link = findSidebarRoute("settings/plugins");
      if (!(link instanceof HTMLElement)) {
        return false;
      }
      link.click();
      target = await waitForElement(() => findPluginHubElement(`#plugins-tab-${tab}`));
    }
    if (!target) {
      return false;
    }
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    return Boolean(await waitForElement(() => findPluginHubElement(`#plugins-tab-${tab}`)));
  }

  private async launchTour(launch: TourLaunch): Promise<void> {
    if (launch === "automatic") {
      // Freeze optional steps only after hello supplies capabilities, not during cold startup.
      if (
        !this.isConnected ||
        !isChatRoute() ||
        this.mobileNavLayout ||
        (this.context && this.context.gateway.snapshot.phase !== "connected")
      ) {
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
    this.automaticLaunchAttempted = true;
    this.guideLoading = true;
    this.guideError = "";
    try {
      await loadPlatformClawLocale();
      activeTourStepIds = null;
      activeTourStepIds = this.tourSteps().map((step) => step.id);
      this.tourIndex = 0;
      activeTourStepId = this.tourSteps()[0]?.id ?? null;
      await this.updateComplete;
      if (!this.isConnected || activeTourStepId === null) {
        return;
      }
      this.addTourListeners();
      this.updateTourPosition();
      this.focusTour();
    } catch {
      this.guideError = guideT("platformClaw.guide.unavailable");
    } finally {
      this.guideLoading = false;
    }
  }

  private readonly handleMobileNavViewportChange = (event: MediaQueryListEvent): void => {
    this.mobileNavLayout = event.matches;
    if (event.matches && this.tourIndex !== null) {
      this.closeTour();
    }
  };

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
      event.preventDefault();
      event.stopImmediatePropagation();
      this.closeTour();
    } else if (event.key === "Tab") {
      const buttons = [
        ...this.renderRoot.querySelectorAll<HTMLButtonElement>(
          ".tour-popover button:not(:disabled)",
        ),
      ];
      const first = buttons[0];
      const last = buttons.at(-1);
      const focused = this.shadowRoot?.activeElement;
      if (
        !buttons.some((button) => button === focused) ||
        (event.shiftKey ? focused === first : focused === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
  };

  private focusTour(): void {
    (
      this.renderRoot.querySelector<HTMLElement>(".tour-next:not(:disabled)") ??
      this.renderRoot.querySelector<HTMLElement>(".tour-close")
    )?.focus({ preventScroll: true });
  }

  private addTourListeners(): void {
    globalThis.addEventListener("resize", this.updateTourPosition);
    globalThis.addEventListener("scroll", this.updateTourPosition, true);
    // Consume modal keys before the settings shell's document-level Escape shortcut.
    globalThis.addEventListener("keydown", this.onTourKeydown, true);
  }

  private removeTourListeners(): void {
    globalThis.removeEventListener("resize", this.updateTourPosition);
    globalThis.removeEventListener("scroll", this.updateTourPosition, true);
    globalThis.removeEventListener("keydown", this.onTourKeydown, true);
  }

  private closeTour(): void {
    this.tourIndex = null;
    activeTourStepId = null;
    activeTourStepIds = null;
    this.removeTourListeners();
    this.renderRoot
      .querySelector<HTMLElement>('[data-tour="guide"]')
      ?.focus({ preventScroll: true });
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
      // Hide the old target while routing, without flashing the popover through the center.
      this.tourHighlightStyle = "display:none";
      this.tourShadeStyles = ["inset:0"];
      this.tourIndex = nextIndex;
      activeTourStepId = nextStep?.id ?? null;
      await this.updateComplete;
      const popover = this.renderRoot.querySelector(".tour-popover");
      if (popover) {
        popover.scrollTop = 0;
      }
      const activated = await nextStep?.activate?.();
      if (!this.isConnected) {
        return;
      }
      if (
        nextStep?.element &&
        !(await waitForTourTarget(
          () => nextStep.element?.() ?? null,
          nextStep.id,
          (currentStepId) => this.isConnected && activeTourStepId === currentStepId,
          // Only a completed activation can replace route-owned layout across the full budget.
          nextStep.activate && activated !== false ? 90 : 1,
        ))
      ) {
        if (this.isConnected && activeTourStepId === nextStep.id) {
          this.positionTourStep(undefined);
        }
        return;
      }
      if (!this.isConnected || activeTourStepId !== nextStep?.id) {
        return;
      }
      this.positionTourStep(nextStep);
    } finally {
      this.guideMoving = false;
      await this.updateComplete;
      if (this.isConnected && this.tourIndex !== null) {
        this.focusTour();
      }
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
    return renderPlatformClawTour({
      step,
      index: this.tourIndex,
      total: steps.length,
      moving: this.guideMoving,
      highlightStyle: this.tourHighlightStyle,
      popoverStyle: this.tourPopoverStyle,
      shadeStyles: this.tourShadeStyles,
      onClose: () => this.closeTour(),
      onComplete: () => {
        this.completeTour();
        this.closeTour();
      },
      onMove: (direction) => void this.moveTour(direction),
    });
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
        ${this.mobileNavLayout
          ? null
          : html`<button
              type="button"
              class="action ${this.vocEnabled ? "" : "span-two"}"
              data-tour="guide"
              ?disabled=${this.guideLoading}
              @click=${() => void this.launchTour("manual")}
              aria-label=${t("platformClaw.quickActions.guide")}
            >
              ${icons.book}<span class="label">${t("platformClaw.quickActions.guide")}</span>
            </button>`}
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
