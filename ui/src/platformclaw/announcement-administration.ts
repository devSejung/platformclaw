import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  ANNOUNCEMENTS_ADMIN_PATH,
  type AnnouncementAdministrationSnapshot,
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
  private generation = 0;

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  override disconnectedCallback() {
    this.generation++;
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
      const current = this.snapshot.current;
      this.editing = Boolean(current && !current.cancelled);
      this.draftTitle = current?.title ?? "";
      this.body = current?.body ?? "";
      this.kind = current?.kind ?? "general";
      this.maintenanceAt = current?.maintenanceAt ? localTime(current.maintenanceAt) : "";
      this.expiresAt = current ? localTime(current.expiresAt) : "";
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

  private draft() {
    return {
      title: this.draftTitle,
      body: this.body,
      kind: this.kind,
      maintenanceAt: this.kind === "maintenance" ? new Date(this.maintenanceAt).getTime() : null,
      expiresAt: new Date(this.expiresAt).getTime(),
    };
  }

  private prepare(event: SubmitEvent) {
    event.preventDefault();
    const draft = this.draft();
    if (
      !draft.title.trim() ||
      !draft.body.trim() ||
      !Number.isFinite(draft.expiresAt) ||
      (draft.kind === "maintenance" &&
        (!Number.isFinite(draft.maintenanceAt) || draft.expiresAt <= (draft.maintenanceAt ?? 0)))
    ) {
      this.error = t("platformClaw.announcements.invalid");
      return;
    }
    this.error = "";
    this.preview = this.editing ? "update" : "publish";
  }

  private async save() {
    if (!this.preview || !this.snapshot || this.busy) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    this.message = "";
    try {
      const snapshot = await this.request({
        action: this.preview,
        expectedRevision: this.snapshot.revision,
        ...this.draft(),
      });
      window.dispatchEvent(new Event("platformclaw-announcements-refresh"));
      if (generation !== this.generation) {
        return;
      }
      this.snapshot = snapshot;
      this.editing = Boolean(this.snapshot.current && !this.snapshot.current.cancelled);
      this.preview = null;
      this.message = t("platformClaw.announcements.saved");
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
          ? html`<p class="hint">
              ${t(
                current.cancelled
                  ? "platformClaw.announcements.cancelled"
                  : this.snapshot?.announcement
                    ? "platformClaw.announcements.active"
                    : "platformClaw.announcements.expired",
              )}
              · revision ${current.revision}
            </p>`
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
              <p class="body">${this.preview === "cancel" ? current?.body : this.body}</p>
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
                <button ?disabled=${this.busy} @click=${() => void this.save()}>
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
              <button type="submit" ?disabled=${this.busy || !this.snapshot}>
                ${t("platformClaw.announcements.preview")}
              </button>
            </form>`}
        <div class="actions">
          ${current && !current.cancelled && !this.preview
            ? html`<button
                ?disabled=${this.busy}
                @click=${() => {
                  this.preview = "cancel";
                }}
              >
                ${t("platformClaw.announcements.cancel")}
              </button>`
            : nothing}
          <button ?disabled=${this.busy} @click=${() => void this.load()}>
            ${t("platformClaw.announcements.reload")}
          </button>
          <button
            ?disabled=${this.busy}
            @click=${() => {
              this.editing = false;
              this.draftTitle = "";
              this.body = "";
              this.maintenanceAt = "";
              this.expiresAt = "";
              this.preview = null;
              this.message = "";
            }}
          >
            ${t("platformClaw.announcements.new")}
          </button>
        </div>
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
