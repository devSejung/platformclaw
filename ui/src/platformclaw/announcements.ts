import { consume } from "@lit/context";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import {
  ANNOUNCEMENTS_CHANGED,
  ANNOUNCEMENTS_PATH,
  type AnnouncementSnapshot,
  type WebAnnouncement,
} from "../../../packages/platformclaw-control-plane/src/announcement-contracts.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { hasOpenModalDialog, OpenClawModalDialog } from "../components/modal-dialog.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { AnnouncementState } from "./announcement-state.ts";
import { platformClawT as t } from "./i18n.ts";

export class PlatformClawAnnouncements extends OpenClawLitElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @property({ type: Boolean }) deferAutomatic = false;
  @consume({ context: applicationContext, subscribe: true }) private context?: ApplicationContext;
  private readonly notice = new AnnouncementState();
  @state() private popupRevision: number | null = null;
  @state() private error = false;
  private sequence = 0;
  private epoch = 0;
  private pending: Promise<void> | null = null;
  private invalidated = false;
  private claimedRevision = 0;
  private presentedRevision = 0;
  private pendingPopupRevision: number | null = null;
  private claimController?: AbortController;
  private refreshController?: AbortController;
  private returnFocus: HTMLElement | null = null;
  private gateway?: ApplicationGateway;
  private connected = false;
  private stopEvents?: () => void;
  private stopState?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private poll?: ReturnType<typeof setInterval>;

  static override styles = css`
    :host {
      display: block;
      min-width: 0;
    }
    aside,
    .panel {
      padding: 16px 20px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg-elevated, var(--bg));
      color: var(--text);
    }
    aside {
      margin: 0 0 12px;
      border-inline-start: 4px solid var(--accent, #4385ed);
    }
    aside[data-kind="maintenance"] {
      border-inline-start-color: var(--warn, #e0a83a);
    }
    h2,
    p {
      margin: 0 0 8px;
    }
    h2 {
      font-size: 18px;
    }
    .body {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 160px;
      overflow: auto;
    }
    .panel {
      max-height: 80dvh;
      overflow: auto;
    }
    .panel .body {
      max-height: 50dvh;
    }
    button {
      cursor: pointer;
      padding: 7px 12px;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      font: inherit;
    }
    button:focus-visible {
      outline: 2px solid var(--accent, #4385ed);
      outline-offset: 2px;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.timer = setInterval(() => {
      this.tryPresent();
      this.requestUpdate();
    }, 1_000);
    // Process-local events are an optimization. Poll the authoritative shared DB
    // after lost signals and across BFFs; independent DB replicas are unsupported.
    this.poll = setInterval(() => void this.refresh(), 15_000);
    window.addEventListener("online", this.resume);
    window.addEventListener("platformclaw-announcements-refresh", this.resume);
    document.addEventListener("visibilitychange", this.resume);
  }

  override disconnectedCallback() {
    this.epoch++;
    this.claimController?.abort();
    this.refreshController?.abort();
    clearInterval(this.timer);
    clearInterval(this.poll);
    this.stopEvents?.();
    this.stopState?.();
    this.stopEvents = undefined;
    this.stopState = undefined;
    this.gateway = undefined;
    window.removeEventListener("online", this.resume);
    window.removeEventListener("platformclaw-announcements-refresh", this.resume);
    document.removeEventListener("visibilitychange", this.resume);
    super.disconnectedCallback();
  }

  protected override updated(_changes: PropertyValues) {
    this.toggleAttribute("data-active", Boolean(this.notice.active(performance.now())));
    const gateway = this.context?.gateway;
    if (gateway && gateway !== this.gateway) {
      this.stopEvents?.();
      this.stopState?.();
      this.gateway = gateway;
      this.stopEvents = gateway.subscribeEvents((event) => {
        if (event.event === ANNOUNCEMENTS_CHANGED) {
          void this.refresh();
        }
      });
      const observe = () => {
        const connected = gateway.snapshot.phase === "connected";
        if (connected && !this.connected) {
          void this.refresh();
        }
        this.connected = connected;
      };
      this.stopState = gateway.subscribe(observe);
      observe();
    }
    if (_changes.has("deferAutomatic") && !this.deferAutomatic) {
      this.tryPresent();
    }
  }

  private resume = () => {
    if (document.visibilityState !== "hidden") {
      void this.refresh();
    }
  };

  refresh(): Promise<void> {
    if (this.pending) {
      this.invalidated = true;
      return this.pending;
    }
    const epoch = this.epoch;
    const sequence = ++this.sequence;
    const startedAt = performance.now();
    this.refreshController = new AbortController();
    const signal = AbortSignal.any([this.refreshController.signal, AbortSignal.timeout(10_000)]);
    this.pending = (async () => {
      try {
        const response = await this.fetchImpl(ANNOUNCEMENTS_PATH, {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        if (epoch !== this.epoch || !this.isConnected) {
          return;
        }
        if (response.status === 401) {
          this.popupRevision = null;
          this.onUnauthenticated();
          return;
        }
        if (!response.ok) {
          throw new Error("announcement unavailable");
        }
        const snapshot = (await response.json()) as AnnouncementSnapshot;
        if (epoch !== this.epoch || !this.isConnected) {
          return;
        }
        if (!this.notice.accept(snapshot, sequence, startedAt, performance.now())) {
          return;
        }
        this.error = false;
        this.requestUpdate();
        const active = this.notice.active(performance.now());
        if (this.popupRevision !== active?.revision) {
          this.popupRevision = null;
        }
        if (active?.revision !== this.pendingPopupRevision) {
          this.pendingPopupRevision = null;
        }
        this.tryPresent();
      } catch {
        if (epoch === this.epoch) {
          this.error = true;
        }
      }
    })().finally(() => {
      this.pending = null;
      if (this.invalidated && this.isConnected) {
        this.invalidated = false;
        void this.refresh();
      }
    });
    return this.pending;
  }

  private tryPresent() {
    const active = this.notice.active(performance.now());
    if (this.deferAutomatic || active?.kind !== "maintenance" || hasOpenModalDialog()) {
      return;
    }
    if (this.pendingPopupRevision === active.revision) {
      if (this.presentedRevision === active.revision) {
        this.pendingPopupRevision = null;
        return;
      }
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement) {
        focused = focused.shadowRoot.activeElement;
      }
      this.returnFocus = focused instanceof HTMLElement ? focused : null;
      this.popupRevision = active.revision;
      this.presentedRevision = active.revision;
      this.pendingPopupRevision = null;
    } else if (this.claimedRevision !== active.revision) {
      this.claimedRevision = active.revision;
      void this.claimPresentation(active);
    }
  }

  private async claimPresentation(active: WebAnnouncement) {
    const epoch = this.epoch;
    this.claimController?.abort();
    const controller = new AbortController();
    this.claimController = controller;
    try {
      // A delayed popup claim must never hold up content refresh/cancellation.
      const claim = await this.fetchImpl(`${ANNOUNCEMENTS_PATH}/seen`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        body: JSON.stringify({ id: active.id, revision: active.revision }),
      });
      if (!claim.ok) {
        throw new Error("presentation unavailable");
      }
      const result = (await claim.json()) as { show: boolean };
      if (
        epoch === this.epoch &&
        this.isConnected &&
        result.show &&
        this.presentedRevision !== active.revision &&
        this.notice.active(performance.now())?.revision === active.revision
      ) {
        this.pendingPopupRevision = active.revision;
        this.tryPresent();
      }
    } catch {
      if (this.claimedRevision === active.revision) {
        this.claimedRevision = 0;
      }
    }
  }

  private countdown(at: number): string {
    const remaining = Math.max(0, Math.ceil((at - this.notice.now(performance.now())) / 1_000));
    if (!remaining) {
      return t("platformClaw.announcements.scheduled");
    }
    const hours = Math.floor(remaining / 3_600);
    const minutes = Math.floor((remaining % 3_600) / 60);
    const seconds = remaining % 60;
    return `${t("platformClaw.announcements.countdown")} ${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  override render() {
    const active = this.notice.active(performance.now());
    return html`
      ${this.error
        ? html`<p class="status" role="status">
            ${t("platformClaw.announcements.refreshFailed")}
            <button @click=${() => void this.refresh()}>
              ${t("platformClaw.announcements.reload")}
            </button>
          </p>`
        : nothing}
      ${active
        ? html`<aside data-kind=${active.kind} aria-label=${t("platformClaw.announcements.notice")}>
            <strong>${active.title}</strong>
            <p class="body">${active.body}</p>
            ${active.maintenanceAt !== null
              ? html`<p class="countdown">
                    ${this.countdown(active.maintenanceAt)} ·
                    ${new Date(active.maintenanceAt).toLocaleString()}
                  </p>
                  <button
                    @click=${(event: Event) => {
                      this.returnFocus = event.currentTarget as HTMLElement;
                      this.presentedRevision = active.revision;
                      this.pendingPopupRevision = null;
                      this.popupRevision = active.revision;
                    }}
                  >
                    ${t("platformClaw.announcements.details")}
                  </button>`
              : nothing}
          </aside>`
        : nothing}
      ${active && this.popupRevision === active.revision
        ? html`<openclaw-modal-dialog
            ${ref((element) => {
              (element as OpenClawModalDialog | undefined)?.setReturnFocusTarget(this.returnFocus);
            })}
            .label=${active.title}
            @modal-cancel=${() => {
              this.popupRevision = null;
            }}
          >
            <section class="panel">
              <h2>${active.title}</h2>
              <p class="body">${active.body}</p>
              ${active.maintenanceAt !== null
                ? html`<p>
                    ${this.countdown(active.maintenanceAt)} ·
                    ${new Date(active.maintenanceAt).toLocaleString()}
                  </p>`
                : nothing}
              <button
                autofocus
                @click=${() => {
                  this.popupRevision = null;
                }}
              >
                ${t("platformClaw.announcements.close")}
              </button>
            </section>
          </openclaw-modal-dialog>`
        : nothing}
    `;
  }
}

if (!customElements.get("platformclaw-announcements")) {
  customElements.define("platformclaw-announcements", PlatformClawAnnouncements);
}
