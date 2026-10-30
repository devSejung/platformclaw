import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  ANNOUNCEMENTS_ADMIN_PATH,
  ANNOUNCEMENTS_HISTORY_PATH,
  type AnnouncementAdministrationSnapshot,
  type AnnouncementHistoryCursor,
  type AnnouncementHistoryEntry,
  type AnnouncementHistoryPage,
} from "../../../packages/platformclaw-control-plane/src/announcement-contracts.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { platformClawT as t } from "./i18n.ts";

function localTime(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

class PlatformClawAnnouncementAdministration extends OpenClawLitElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @state() private busy = false;
  @state() private error = "";
  @state() private message = "";
  @state() private snapshot: AnnouncementAdministrationSnapshot | null = null;
  @state() private draftTitle = "";
  @state() private body = "";
  @state() private kind: "general" | "maintenance" = "general";
  @state() private maintenanceAt = "";
  @state() private expiresAt = "";
  @state() private editing = false;
  @state() private preview: "publish" | "update" | "cancel" | null = null;
  @state() private history: AnnouncementHistoryEntry[] = [];
  @state() private historyCursor: AnnouncementHistoryCursor | null = null;
  @state() private historyBusy = false;
  @state() private historyError = "";
  private generation = 0;
  private historyGeneration = 0;

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
    void this.loadHistory();
  }

  override disconnectedCallback() {
    this.generation++;
    this.historyGeneration++;
    super.disconnectedCallback();
  }

  static override styles = css`
    :host {
      display: block;
      min-width: 0;
    }
    button {
      cursor: pointer;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      background: var(--bg-elevated, var(--bg));
      color: var(--text);
      font: inherit;
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    button:focus-visible {
      outline: 2px solid var(--accent, #4385ed);
      outline-offset: 2px;
    }
    .panel {
      padding: 20px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: var(--bg);
      color: var(--text);
    }
    p {
      margin: 8px 0;
    }
    form,
    label {
      display: grid;
      gap: 8px;
    }
    form {
      gap: 14px;
    }
    input,
    select,
    textarea {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px;
      font: inherit;
      background: var(--bg-elevated, var(--bg));
      color: var(--text);
    }
    textarea {
      min-height: 140px;
      resize: vertical;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }
    .preview {
      padding: 14px;
      border: 1px solid var(--accent, #4385ed);
      border-radius: 10px;
    }
    .body {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 20rem;
      overflow: auto;
    }
    .current,
    .history {
      margin-bottom: 20px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow-wrap: anywhere;
    }
    .history {
      margin-top: 20px;
      margin-bottom: 0;
    }
    details {
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
    }
    summary {
      cursor: pointer;
    }
    summary:focus-visible {
      outline: 2px solid var(--accent, #4385ed);
      outline-offset: 2px;
    }
    .hint {
      font-size: 13px;
      color: var(--muted);
    }
    [role="alert"] {
      color: var(--danger, #db5252);
    }
  `;

  private async request(
    body?: Record<string, unknown>,
  ): Promise<AnnouncementAdministrationSnapshot> {
    const generation = this.generation;
    const response = await this.fetchImpl(ANNOUNCEMENTS_ADMIN_PATH, {
      credentials: "same-origin",
      cache: "no-store",
      ...(body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (response.status === 401 && this.isConnected && generation === this.generation) {
      this.onUnauthenticated();
    }
    if (!response.ok) {
      const result = (await response.json()) as { error?: string };
      throw new Error(result.error ?? t("platformClaw.announcements.failed"));
    }
    return (await response.json()) as AnnouncementAdministrationSnapshot;
  }

  private async load() {
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    this.message = "";
    this.preview = null;
    try {
      const snapshot = await this.request();
      if (generation !== this.generation) {
        return;
      }
      this.snapshot = snapshot;
      this.newDraft();
    } catch (error) {
      if (generation === this.generation) {
        this.error =
          error instanceof Error ? error.message : t("platformClaw.announcements.failed");
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private newDraft() {
    const now = Date.now();
    this.editing = false;
    this.draftTitle = "";
    this.body = "";
    this.kind = "general";
    this.maintenanceAt = localTime(now);
    this.expiresAt = localTime(now + 24 * 60 * 60_000);
    this.preview = null;
    this.error = "";
    this.message = "";
  }

  private editCurrent() {
    const current = this.snapshot?.current;
    if (!current || current.cancelled) {
      return;
    }
    this.editing = true;
    this.draftTitle = current.title;
    this.body = current.body;
    this.kind = current.kind;
    this.maintenanceAt = localTime(current.maintenanceAt ?? Date.now());
    this.expiresAt = localTime(current.expiresAt);
    this.preview = null;
    this.error = "";
    this.message = "";
  }

  private async loadHistory(append = false) {
    if (append && (this.historyBusy || !this.historyCursor)) {
      return;
    }
    const generation = ++this.historyGeneration;
    this.historyBusy = true;
    this.historyError = "";
    const params = new URLSearchParams({ limit: "20" });
    if (append && this.historyCursor) {
      params.set("cursor", JSON.stringify(this.historyCursor));
    } else {
      this.history = [];
      this.historyCursor = null;
    }
    try {
      const response = await this.fetchImpl(`${ANNOUNCEMENTS_HISTORY_PATH}?${params}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      // History has its own lifecycle so paging cannot reset an in-progress draft or save.
      if (!this.isConnected || generation !== this.historyGeneration) {
        return;
      }
      if (response.status === 401) {
        this.onUnauthenticated();
      }
      if (!response.ok) {
        throw new Error(t("platformClaw.announcements.historyFailed"));
      }
      const page = (await response.json()) as AnnouncementHistoryPage;
      if (!this.isConnected || generation !== this.historyGeneration) {
        return;
      }
      this.history = append ? [...this.history, ...page.items] : page.items;
      this.historyCursor = page.nextCursor;
    } catch (error) {
      if (generation === this.historyGeneration) {
        this.historyError =
          error instanceof Error ? error.message : t("platformClaw.announcements.historyFailed");
      }
    } finally {
      if (generation === this.historyGeneration) {
        this.historyBusy = false;
      }
    }
  }

  private draft() {
    return {
      title: this.draftTitle,
      body: this.body,
      kind: this.kind,
      maintenanceAt: this.kind === "maintenance" ? new Date(this.maintenanceAt).getTime() : null,
      expiresAt: new Date(this.expiresAt).getTime(),
    };
  }

  private validDraft(): boolean {
    const draft = this.draft();
    if (
      !draft.title.trim() ||
      draft.title.length > 160 ||
      !draft.body.trim() ||
      draft.body.length > 8_000 ||
      !Number.isFinite(draft.expiresAt) ||
      draft.expiresAt <= Date.now() ||
      (draft.kind === "maintenance" &&
        (!Number.isFinite(draft.maintenanceAt) || draft.expiresAt <= (draft.maintenanceAt ?? 0)))
    ) {
      this.error = t("platformClaw.announcements.invalid");
      return false;
    }
    this.error = "";
    return true;
  }

  private prepare(event: SubmitEvent) {
    event.preventDefault();
    const action = this.editing ? "update" : "publish";
    if ((event.submitter as HTMLButtonElement | null)?.value === "preview") {
      if (this.validDraft()) {
        this.preview = action;
      }
    } else {
      void this.save(action);
    }
  }

  private async save(action: "publish" | "update" | "cancel") {
    if (!this.snapshot || this.busy || (action !== "cancel" && !this.validDraft())) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    this.message = "";
    try {
      const snapshot = await this.request({
        action,
        expectedRevision: this.snapshot.revision,
        ...(action === "cancel" ? {} : this.draft()),
      });
      window.dispatchEvent(new Event("platformclaw-announcements-refresh"));
      if (generation !== this.generation) {
        return;
      }
      this.snapshot = snapshot;
      if (action === "update") {
        this.editCurrent();
      } else {
        this.newDraft();
      }
      this.message = t("platformClaw.announcements.saved");
      void this.loadHistory();
    } catch (error) {
      if (generation === this.generation) {
        this.error =
          error instanceof Error ? error.message : t("platformClaw.announcements.failed");
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  override render() {
    const current = this.snapshot?.current;
    return html`
      <section class="panel">
        ${current
          ? html`<section class="current" aria-label=${t("platformClaw.announcements.current")}>
              <strong>${current.title}</strong>
              <p class="hint">
                ${t(
                  current.cancelled
                    ? "platformClaw.announcements.cancelled"
                    : this.snapshot?.announcement
                      ? "platformClaw.announcements.active"
                      : "platformClaw.announcements.expired",
                )}
                · ${t("platformClaw.announcements.revision")} ${current.revision}
              </p>
              <p class="body" tabindex="0">${current.body}</p>
              ${!current.cancelled && !this.preview
                ? html`<div class="actions">
                    <button
                      data-action="edit-current"
                      ?disabled=${this.busy}
                      @click=${() => this.editCurrent()}
                    >
                      ${t("platformClaw.announcements.editCurrent")}
                    </button>
                    <button
                      data-action="cancel"
                      ?disabled=${this.busy}
                      @click=${() => {
                        this.preview = "cancel";
                        this.error = "";
                      }}
                    >
                      ${t("platformClaw.announcements.cancel")}
                    </button>
                  </div>`
                : nothing}
            </section>`
          : nothing}
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${this.message ? html`<p role="status">${this.message}</p>` : nothing}
        ${this.preview
          ? html`<section class="preview" aria-label=${t("platformClaw.announcements.preview")}>
              <h3>
                ${t(
                  this.preview === "cancel"
                    ? "platformClaw.announcements.cancelConfirm"
                    : "platformClaw.announcements.preview",
                )}
              </h3>
              <strong>${this.preview === "cancel" ? current?.title : this.draftTitle}</strong>
              <p class="body" tabindex="0">
                ${this.preview === "cancel" ? current?.body : this.body}
              </p>
              ${this.preview !== "cancel"
                ? html`<p>
                      ${t(
                        this.kind === "maintenance"
                          ? "platformClaw.announcements.maintenance"
                          : "platformClaw.announcements.general",
                      )}
                    </p>
                    ${this.kind === "maintenance"
                      ? html`<p>
                          ${t("platformClaw.announcements.maintenanceAt")}:
                          ${new Date(this.maintenanceAt).toLocaleString()}
                        </p>`
                      : nothing}
                    <p>
                      ${t("platformClaw.announcements.expiresAt")}:
                      ${new Date(this.expiresAt).toLocaleString()}
                    </p>`
                : nothing}
              <div class="actions">
                <button
                  data-action=${this.preview === "cancel" ? "cancel-confirm" : this.preview}
                  ?disabled=${this.busy}
                  @click=${() => {
                    if (this.preview) {
                      void this.save(this.preview);
                    }
                  }}
                >
                  ${t(
                    this.preview === "cancel"
                      ? "platformClaw.announcements.cancel"
                      : this.preview === "update"
                        ? "platformClaw.announcements.update"
                        : "platformClaw.announcements.publish",
                  )}
                </button>
                <button
                  ?disabled=${this.busy}
                  @click=${() => {
                    this.preview = null;
                  }}
                >
                  ${t("platformClaw.announcements.back")}
                </button>
              </div>
            </section>`
          : html`<form @submit=${(event: SubmitEvent) => this.prepare(event)}>
              <label
                >${t("platformClaw.announcements.title")}<input
                  name="title"
                  ?disabled=${this.busy || !this.snapshot}
                  autofocus
                  required
                  maxlength="160"
                  .value=${this.draftTitle}
                  @input=${(e: Event) => {
                    this.draftTitle = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label
                >${t("platformClaw.announcements.body")}<textarea
                  name="body"
                  ?disabled=${this.busy || !this.snapshot}
                  required
                  maxlength="8000"
                  .value=${this.body}
                  @input=${(e: Event) => {
                    this.body = (e.target as HTMLTextAreaElement).value;
                  }}
                ></textarea>
              </label>
              <label
                >${t("platformClaw.announcements.kind")}<select
                  name="kind"
                  ?disabled=${this.busy || !this.snapshot}
                  .value=${this.kind}
                  @change=${(e: Event) => {
                    this.kind = (e.target as HTMLSelectElement).value as "general" | "maintenance";
                  }}
                >
                  <option value="general">${t("platformClaw.announcements.general")}</option>
                  <option value="maintenance">
                    ${t("platformClaw.announcements.maintenance")}
                  </option>
                </select></label
              >
              ${this.kind === "maintenance"
                ? html`<label
                    >${t("platformClaw.announcements.maintenanceAt")}<input
                      name="maintenanceAt"
                      ?disabled=${this.busy || !this.snapshot}
                      type="datetime-local"
                      required
                      .value=${this.maintenanceAt}
                      @input=${(e: Event) => {
                        this.maintenanceAt = (e.target as HTMLInputElement).value;
                      }}
                  /></label>`
                : nothing}
              <label
                >${t("platformClaw.announcements.expiresAt")}<input
                  name="expiresAt"
                  ?disabled=${this.busy || !this.snapshot}
                  type="datetime-local"
                  required
                  .value=${this.expiresAt}
                  @input=${(e: Event) => {
                    this.expiresAt = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <p class="hint">
                ${t("platformClaw.announcements.localTime")}
                (${Intl.DateTimeFormat().resolvedOptions().timeZone})
              </p>
              <div class="actions">
                <button
                  type="submit"
                  data-action=${this.editing ? "update" : "publish"}
                  ?disabled=${this.busy || !this.snapshot}
                >
                  ${t(
                    this.editing
                      ? "platformClaw.announcements.update"
                      : "platformClaw.announcements.publish",
                  )}
                </button>
                <button
                  type="submit"
                  value="preview"
                  data-action="preview"
                  ?disabled=${this.busy || !this.snapshot}
                >
                  ${t("platformClaw.announcements.preview")}
                </button>
              </div>
            </form>`}
        <div class="actions">
          <button
            data-action="reload"
            ?disabled=${this.busy}
            @click=${() => {
              void this.load();
              void this.loadHistory();
            }}
          >
            ${t("platformClaw.announcements.reload")}
          </button>
          <button data-action="new" ?disabled=${this.busy} @click=${() => this.newDraft()}>
            ${t("platformClaw.announcements.new")}
          </button>
        </div>
        <section
          class="history"
          aria-label=${t("platformClaw.announcements.history")}
          aria-busy=${String(this.historyBusy)}
        >
          <h3>${t("platformClaw.announcements.history")}</h3>
          ${this.history.map(
            (entry) => html`<details>
              <summary>
                ${entry.announcement?.title ?? t("platformClaw.announcements.notice")} ·
                ${t(`platformClaw.announcements.historyAction.${entry.action}`)} ·
                <time datetime=${new Date(entry.occurredAt).toISOString()}
                  >${new Date(entry.occurredAt).toLocaleString()}</time
                >
                · ${t("platformClaw.announcements.revision")} ${entry.revision}
              </summary>
              ${entry.announcement
                ? html`
                    <p>
                      ${t(
                        entry.announcement.kind === "maintenance"
                          ? "platformClaw.announcements.maintenance"
                          : "platformClaw.announcements.general",
                      )}
                    </p>
                    <p class="body" tabindex="0">${entry.announcement.body}</p>
                    ${entry.announcement.maintenanceAt !== null
                      ? html`<p>
                          ${t("platformClaw.announcements.maintenanceAt")}:
                          ${new Date(entry.announcement.maintenanceAt).toLocaleString()}
                        </p>`
                      : nothing}
                    <p>
                      ${t("platformClaw.announcements.expiresAt")}:
                      ${new Date(entry.announcement.expiresAt).toLocaleString()}
                    </p>
                  `
                : html`<p>${t("platformClaw.announcements.historyContentUnavailable")}</p>`}
            </details>`,
          )}
          ${this.historyError
            ? html`<p role="alert">${this.historyError}</p>
                <button
                  data-action="history-retry"
                  ?disabled=${this.historyBusy}
                  @click=${() => void this.loadHistory(this.historyCursor !== null)}
                >
                  ${t("platformClaw.announcements.retry")}
                </button>`
            : nothing}
          ${this.historyBusy
            ? html`<p aria-live="polite">${t("platformClaw.announcements.historyLoading")}</p>`
            : !this.history.length && !this.historyError
              ? html`<p>${t("platformClaw.announcements.historyEmpty")}</p>`
              : nothing}
          ${this.historyCursor && !this.historyError
            ? html`<button
                data-action="history-more"
                ?disabled=${this.historyBusy}
                @click=${() => void this.loadHistory(true)}
              >
                ${t("platformClaw.announcements.loadMore")}
              </button>`
            : nothing}
        </section>
      </section>
    `;
  }
}

if (!customElements.get("platformclaw-announcement-administration")) {
  customElements.define(
    "platformclaw-announcement-administration",
    PlatformClawAnnouncementAdministration,
  );
}
