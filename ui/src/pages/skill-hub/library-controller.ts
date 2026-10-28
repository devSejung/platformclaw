import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { html, nothing, type ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import { platformClawT } from "../../platformclaw/i18n.ts";
import {
  acceptPlatformClawSkillHubTransfer,
  loadPlatformClawSkillHubHistory,
  loadPlatformClawSkillHubTransfers,
  loadPlatformClawSkillHubTrash,
  restorePlatformClawSkillHubSkill,
  type PlatformClawSkillHubHistoryItem,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubTransfer,
  type PlatformClawSkillHubTrashItem,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubAdminReason, validSkillHubAdminReason } from "./management.ts";
import { refreshSkillHubAfterMutation } from "./page-support.ts";

type Panel = { kind: "trash" } | { kind: "transfers" } | { kind: "history"; id: string };

const historyActions: Record<string, string> = {
  "metadata-updated": "skillHubPage.historyMetadata",
  "sharing-updated": "skillHubPage.historySharing",
  "sharing-migrated": "skillHubPage.historyMigration",
  "transfer-requested": "skillHubPage.historyTransferRequested",
  "owner-transferred": "skillHubPage.historyOwnerTransferred",
  "version-published": "skillHubPage.historyVersionPublished",
  "version-blocked": "skillHubPage.historyVersionBlocked",
  "publication-cancelled": "skillHubPage.historyPublicationCancelled",
  deleted: "skillHubPage.historyDeleted",
  restored: "skillHubPage.historyRestored",
  "permanently-deleted": "skillHubPage.historyPurged",
};

export class SkillHubLibraryController {
  private panel: Panel | null = null;
  private generation = 0;
  private loading = false;
  private busy = false;
  private error: string | null = null;
  private message: PlatformClawSkillHubMessage | null = null;
  private trash: PlatformClawSkillHubTrashItem[] = [];
  private transfers: PlatformClawSkillHubTransfer[] = [];
  private reasons: Record<string, string> = {};
  private history: PlatformClawSkillHubHistoryItem[] = [];

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly refresh: () => Promise<void>,
  ) {}

  async open(
    panel: Panel,
    message: PlatformClawSkillHubMessage | null = null,
  ): Promise<Result<undefined, string>> {
    if (this.busy) {
      return ok(undefined);
    }
    this.panel = panel;
    if (panel.kind === "history") {
      this.history = [];
    }
    this.message = message;
    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      if (panel.kind === "trash") {
        const result = await loadPlatformClawSkillHubTrash();
        if (generation === this.generation) {
          this.trash = result.items;
        }
      } else if (panel.kind === "transfers") {
        const result = await loadPlatformClawSkillHubTransfers();
        if (generation === this.generation) {
          this.transfers = result.items;
        }
      } else {
        const result = await loadPlatformClawSkillHubHistory(panel.id);
        if (generation === this.generation) {
          this.history = result.items;
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : String(error);
        return err(this.error);
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.host.requestUpdate();
      }
    }
    return ok(undefined);
  }

  private close() {
    if (this.busy) {
      return;
    }
    this.generation++;
    this.panel = null;
    this.host.requestUpdate();
  }

  private async act(id: string, operation: () => Promise<unknown>, text: string) {
    if (this.busy || !this.panel) {
      return;
    }
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
    const panel = this.panel;
    try {
      await operation();
      // The item is no longer actionable after commit, even if a subsequent list read fails.
      this.trash = this.trash.filter((item) => item.id !== id);
      this.transfers = this.transfers.filter((item) => item.id !== id);
      await refreshSkillHubAfterMutation(
        text,
        async () => {
          await this.refresh();
          this.busy = false;
          const result = await this.open(panel, { kind: "success", text });
          if (!result.ok) {
            throw new Error(result.error);
          }
        },
        (message) => {
          this.message = message;
          if (message.kind === "warning") {
            this.error = null;
          }
          this.host.requestUpdate();
        },
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.host.requestUpdate();
    }
  }

  render() {
    const panel = this.panel;
    if (!panel) {
      return nothing;
    }
    const title = t(
      panel.kind === "trash"
        ? "skillHubPage.trash"
        : panel.kind === "transfers"
          ? "skillHubPage.transfers"
          : "skillHubPage.history",
    );
    return html`<openclaw-modal-dialog
      label=${title}
      @modal-cancel=${(event: Event) => (this.busy ? event.preventDefault() : this.close())}
    >
      <section class="skill-hub-dialog skill-hub-library">
        <header class="skill-hub-dialog__header">
          <h2>${title}</h2>
          <button class="btn btn--sm" ?disabled=${this.busy} @click=${() => this.close()}>
            ${t("skillsPage.close")}
          </button>
        </header>
        ${panel.kind === "trash" ? html`<p>${t("skillHubPage.trashHelp")}</p>` : nothing}
        ${this.message
          ? html`<div role="status" class="callout ${this.message.kind}">${this.message.text}</div>`
          : nothing}
        ${this.error ? html`<div role="alert" class="callout danger">${this.error}</div>` : nothing}
        ${this.error || this.message?.kind === "warning"
          ? html`<button class="btn" ?disabled=${this.busy} @click=${() => void this.open(panel)}>
              ${t("common.reload")}
            </button>`
          : nothing}
        ${this.loading
          ? html`<p role="status">${t("common.loading")}</p>`
          : this.error && panel.kind === "history"
            ? nothing
            : panel.kind === "trash"
              ? this.renderTrash()
              : panel.kind === "transfers"
                ? this.renderTransfers()
                : this.renderHistory()}
      </section>
    </openclaw-modal-dialog>`;
  }

  private renderTrash() {
    return this.trash.length
      ? html`<div class="skill-hub-library-list">
          ${this.trash.map(
            (skill) => html`<article>
              <div>
                <strong>${skill.displayName}</strong>
                <p>
                  ${t("skillHubPage.purgeOn", {
                    date: new Date(skill.purgeAt).toLocaleDateString(),
                  })}
                </p>
              </div>
              ${!skill.owner.isMine
                ? renderSkillHubAdminReason(
                    this.reasons[skill.id] ?? "",
                    (reason) => {
                      this.reasons[skill.id] = reason;
                      this.host.requestUpdate();
                    },
                    this.busy,
                  )
                : nothing}
              <button
                class="btn"
                ?disabled=${this.busy ||
                (!skill.owner.isMine && !validSkillHubAdminReason(this.reasons[skill.id] ?? ""))}
                @click=${() =>
                  void this.act(
                    skill.id,
                    () =>
                      restorePlatformClawSkillHubSkill(
                        skill.id,
                        skill.revision,
                        !skill.owner.isMine ? this.reasons[skill.id]?.trim() : undefined,
                      ),
                    platformClawT("platformClaw.skillHub.restored", {
                      skill: skill.displayName,
                    }),
                  )}
              >
                ${t("skillHubPage.restore")}
              </button>
            </article>`,
          )}
        </div>`
      : html`<p>${t("skillHubPage.trashEmpty")}</p>`;
  }

  private renderTransfers() {
    return this.transfers.length
      ? html`<div class="skill-hub-library-list">
          ${this.transfers.map(
            (transfer) => html`<article>
              <div>
                <strong>${transfer.displayName}</strong>
                <p>
                  ${t("skillHubPage.transferFrom", {
                    user:
                      transfer.from?.displayName ??
                      transfer.from?.accountId ??
                      t("skillHubPage.ownerUnassigned"),
                  })}
                </p>
              </div>
              <button
                class="btn primary"
                ?disabled=${this.busy}
                @click=${() =>
                  void this.act(
                    transfer.id,
                    () => acceptPlatformClawSkillHubTransfer(transfer.id, transfer.revision),
                    platformClawT("platformClaw.skillHub.transferAccepted", {
                      skill: transfer.displayName,
                    }),
                  )}
              >
                ${t("skillHubPage.acceptTransfer")}
              </button>
            </article>`,
          )}
        </div>`
      : html`<p>${t("skillHubPage.transfersEmpty")}</p>`;
  }

  private renderHistory() {
    return this.history.length
      ? html`<ol class="skill-hub-history">
          ${this.history.map(
            (item) => html`<li>
              <strong
                >${item.actor?.displayName ??
                item.actor?.accountId ??
                t("skillHubPage.systemActor")}</strong
              >
              <span
                >${historyActions[item.action]
                  ? t(historyActions[item.action]!)
                  : item.action}${item.version ? ` · v${item.version}` : ""}</span
              >
              <time datetime=${new Date(item.createdAt).toISOString()}
                >${new Date(item.createdAt).toLocaleString()}</time
              >
              ${typeof item.details.reason === "string"
                ? html`<small class="skill-hub-history__reason">${item.details.reason}</small>`
                : nothing}
            </li>`,
          )}
        </ol>`
      : html`<p>${t("skillHubPage.historyEmpty")}</p>`;
  }
}
