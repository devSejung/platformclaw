import type { Driver, PopoverDOM } from "driver.js";
import { css, html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../components/icons.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import "./execution-settings.ts";
import "./voc-dialog.ts";

export const PLATFORMCLAW_PRODUCT_TOUR_STORAGE_KEY = "platformclaw.product-tour.v1.completed";

type TourLaunch = "automatic" | "manual";

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

  private activeTour: Driver | null = null;
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
    `,
  ];

  override disconnectedCallback(): void {
    this.activeTour?.destroy();
    this.activeTour = null;
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

  private addNeverShowAgain(popover: PopoverDOM, tour: Driver): void {
    const existing = popover.footer.querySelector<HTMLButtonElement>(".platformclaw-tour-never");
    if (existing) {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "platformclaw-tour-never";
    button.textContent = t("platformClaw.guide.neverShowAgain");
    button.addEventListener("click", () => {
      this.completeTour();
      tour.destroy();
    });
    popover.footer.prepend(button);
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
      this.requestUpdate();
      const [{ driver }] = await Promise.all([
        import("driver.js"),
        import("driver.js/dist/driver.css"),
        import("./product-tour.css"),
      ]);
      this.activeTour?.destroy();
      let tour: Driver;
      tour = driver({
        animate: !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
        allowClose: true,
        allowScroll: true,
        disableActiveInteraction: true,
        overlayColor: "#05070a",
        overlayOpacity: 0.76,
        stagePadding: 7,
        stageRadius: 10,
        popoverClass: "platformclaw-product-tour",
        showProgress: true,
        progressText: t("platformClaw.guide.progress"),
        nextBtnText: t("platformClaw.guide.next"),
        prevBtnText: t("platformClaw.guide.previous"),
        doneBtnText: t("platformClaw.guide.done"),
        skipMissingElement: true,
        onPopoverRender: (popover) => this.addNeverShowAgain(popover, tour),
        onDoneClick: () => {
          this.completeTour();
          tour.destroy();
        },
        onDestroyed: () => {
          if (this.activeTour === tour) {
            this.activeTour = null;
          }
        },
        steps: [
          {
            popover: {
              title: t("platformClaw.guide.welcomeTitle"),
              description: t("platformClaw.guide.welcomeBody"),
            },
          },
          {
            element: findSidebarHome,
            popover: {
              title: t("platformClaw.guide.chatTitle"),
              description: t("platformClaw.guide.chatBody"),
              side: "right",
            },
          },
          {
            element: () => findSidebarRoute("sessions"),
            popover: {
              title: t("platformClaw.guide.sessionsTitle"),
              description: t("platformClaw.guide.sessionsBody"),
              side: "right",
            },
          },
          {
            element: () => findSidebarRoute("tasks"),
            popover: {
              title: t("platformClaw.guide.tasksTitle"),
              description: t("platformClaw.guide.tasksBody"),
              side: "right",
            },
          },
          {
            element: () =>
              this.tourElement("platformclaw-execution-settings", '[data-action="open"]'),
            popover: {
              title: t("platformClaw.guide.workLocationTitle"),
              description: t("platformClaw.guide.workLocationBody"),
              side: "right",
            },
          },
          {
            element: () => findSidebarRoute("skills"),
            popover: {
              title: t("platformClaw.guide.skillsTitle"),
              description: t("platformClaw.guide.skillsBody"),
              side: "right",
            },
          },
          {
            element: () => this.tourElement('[data-tour="guide"]'),
            popover: {
              title: t("platformClaw.guide.reopenTitle"),
              description: t("platformClaw.guide.reopenBody"),
              side: "right",
            },
          },
        ],
      });
      this.activeTour = tour;
      tour.drive();
    } catch {
      this.guideError = t("platformClaw.guide.unavailable");
    } finally {
      this.guideLoading = false;
    }
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
    `;
  }
}

if (!customElements.get("platformclaw-quick-actions")) {
  customElements.define("platformclaw-quick-actions", PlatformClawQuickActionsElement);
}
