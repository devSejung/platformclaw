import { html, nothing, type ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import {
  editPlatformClawSkillHubSkill,
  PlatformClawSkillHubRequestError,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
} from "../../platformclaw/skill-hub.ts";
import type { SkillHubRef } from "./page-support.ts";

type SkillEditDraft = Parameters<typeof editPlatformClawSkillHubSkill>[2];

export class SkillHubEditController {
  private pending: { ref: SkillHubRef; draft: SkillEditDraft; namespaces: string[] } | null = null;
  private saving = false;
  private submitted = false;
  private reloadRequired = false;
  private error: string | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: (ref: SkillHubRef) => Promise<void>;
      setMessage: (message: PlatformClawSkillHubMessage | null) => void;
    },
  ) {}

  get busy(): boolean {
    return this.saving;
  }

  request(
    ref: SkillHubRef | null,
    detail: PlatformClawSkillHubDetail | null,
    namespaces: string[],
  ) {
    const ownerRevision = detail?.owner?.revision;
    if (
      !ref ||
      !detail?.canManage ||
      typeof ownerRevision !== "number" ||
      !detail.skill.revision ||
      this.saving
    ) {
      return;
    }
    this.pending = {
      ref: { ...ref },
      namespaces: [...new Set([ref.namespace, ...namespaces])],
      draft: {
        operationId: crypto.randomUUID(),
        namespace: ref.namespace,
        displayName: detail.skill.displayName,
        summary: detail.skill.summary,
        visibility: detail.skill.visibility,
        expectedOwnerUpdatedAt: ownerRevision,
        expectedRegistryRevision: detail.skill.revision,
      },
    };
    this.error = null;
    this.submitted = false;
    this.reloadRequired = false;
    this.options.setMessage(null);
    this.host.requestUpdate();
  }

  clear() {
    if (this.saving) {
      return;
    }
    this.pending = null;
    this.error = null;
    this.host.requestUpdate();
  }

  private update(draft: Partial<SkillEditDraft>) {
    if (!this.pending || this.saving) {
      return;
    }
    const changed = Object.entries(draft).some(
      ([key, value]) => this.pending!.draft[key as keyof SkillEditDraft] !== value,
    );
    if (!changed) {
      return;
    }
    // Retrying an unchanged submission must recover its durable receipt, even
    // after a namespace move. A changed payload starts a distinct operation.
    const operationId = this.submitted ? crypto.randomUUID() : this.pending.draft.operationId;
    this.pending = { ...this.pending, draft: { ...this.pending.draft, ...draft, operationId } };
    this.submitted = false;
    this.host.requestUpdate();
  }

  renderDialog() {
    if (!this.pending) {
      return nothing;
    }
    const { draft, ref, namespaces } = this.pending;
    const invalidDraft = !draft.displayName.trim() || !draft.namespace;
    return html`<openclaw-modal-dialog
      label=${t("skillHubPage.editSkill")}
      @modal-cancel=${(event: Event) => {
        if (this.saving) {
          event.preventDefault();
        } else {
          this.clear();
        }
      }}
    >
      <form
        class="skill-hub-dialog skill-hub-edit"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void (this.reloadRequired ? this.reload() : this.save());
        }}
      >
        <header class="skill-hub-dialog__header">
          <div>
            <h2>${t("skillHubPage.editSkill")}</h2>
            <p>${t("skillHubPage.packageIdentity", { slug: ref.slug })}</p>
          </div>
        </header>
        <div class="skill-hub-upload__fields">
          <label class="field"
            ><span>${t("skillHubPage.displayName")}</span>
            <input
              name="displayName"
              autofocus
              required
              maxlength="200"
              .value=${draft.displayName}
              ?disabled=${this.saving}
              @input=${(event: Event) =>
                this.update({ displayName: (event.target as HTMLInputElement).value })}
            />
          </label>
          <label class="field"
            ><span>${t("skillsPage.skillHub.namespace")}</span>
            <select
              name="namespace"
              .value=${draft.namespace}
              ?disabled=${this.saving}
              @change=${(event: Event) =>
                this.update({ namespace: (event.target as HTMLSelectElement).value })}
            >
              ${namespaces.map(
                (namespace) =>
                  html`<option value=${namespace} ?selected=${namespace === draft.namespace}>
                    ${namespace}
                  </option>`,
              )}
            </select>
          </label>
          <label class="field"
            ><span>${t("skillHubPage.summary")}</span>
            <textarea
              name="summary"
              maxlength="4000"
              .value=${draft.summary}
              ?disabled=${this.saving}
              @input=${(event: Event) =>
                this.update({ summary: (event.target as HTMLTextAreaElement).value })}
            ></textarea>
          </label>
          <label class="field"
            ><span>${t("skillsPage.skillHub.visibility")}</span>
            <select
              name="visibility"
              .value=${draft.visibility}
              ?disabled=${this.saving}
              @change=${(event: Event) =>
                this.update({
                  visibility: (event.target as HTMLSelectElement)
                    .value as SkillEditDraft["visibility"],
                })}
            >
              <option value="PUBLIC" ?selected=${draft.visibility === "PUBLIC"}>
                ${t("skillsPage.skillHub.public")}
              </option>
              <option value="NAMESPACE_ONLY" ?selected=${draft.visibility === "NAMESPACE_ONLY"}>
                ${t("skillsPage.skillHub.namespaceOnly")}
              </option>
              <option value="PRIVATE" ?selected=${draft.visibility === "PRIVATE"}>
                ${t("skillsPage.skillHub.private")}
              </option>
            </select>
          </label>
        </div>
        <p>${t("skillHubPage.editNamespaceHelp")}</p>
        ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}
        <div class="skill-hub-install-actions">
          <button type="button" class="btn" ?disabled=${this.saving} @click=${() => this.clear()}>
            ${t("common.cancel")}
          </button>
          <button
            type=${this.reloadRequired ? "button" : "submit"}
            class="btn primary"
            ?disabled=${this.saving || (!this.reloadRequired && invalidDraft)}
            @click=${() => {
              if (this.reloadRequired) {
                void this.reload();
              }
            }}
          >
            ${this.saving
              ? t(this.reloadRequired ? "common.loading" : "skillHubPage.savingSkill")
              : this.reloadRequired
                ? t("common.reload")
                : t("skillHubPage.saveSkill")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>`;
  }

  private async save() {
    if (
      !this.pending ||
      this.saving ||
      this.reloadRequired ||
      !this.pending.draft.displayName.trim()
    ) {
      return;
    }
    const { ref, draft } = this.pending;
    this.saving = true;
    this.submitted = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const result = await editPlatformClawSkillHubSkill(ref.namespace, ref.slug, draft);
      this.pending = null;
      await this.options.refresh(result);
      this.options.setMessage({
        kind: result.ownershipReviewRequired || result.publicationPending ? "warning" : "success",
        text: t(
          result.ownershipReviewRequired
            ? "skillHubPage.editedNeedsOwnershipReview"
            : result.publicationPending
              ? "skillHubPage.editedPublicationPending"
              : "skillHubPage.editedSkill",
          {
            skill: `${result.namespace}/${result.slug}`,
          },
        ),
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      // Definitive rejection cancels the durable operation. Read fresh revisions
      // before creating another edit; uncertain results retain the retry receipt.
      this.reloadRequired =
        error instanceof PlatformClawSkillHubRequestError &&
        [400, 404, 409, 422].includes(error.status) &&
        error.details?.code !== "skill-hub-edit-pending";
    } finally {
      this.saving = false;
      this.host.requestUpdate();
    }
  }

  private async reload() {
    if (!this.pending || this.saving) {
      return;
    }
    const ref = this.pending.ref;
    this.saving = true;
    this.host.requestUpdate();
    try {
      await this.options.refresh(ref);
      this.pending = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.saving = false;
      this.host.requestUpdate();
    }
  }
}
