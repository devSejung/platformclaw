import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  OrganizationMemoryLifecycleSnapshot,
  OrganizationMemoryPromotionRequest,
  OrganizationMemoryPromotionSourceKind,
} from "../../../../packages/platformclaw-control-plane/src/contracts.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "../../platformclaw/i18n.ts";
import type { PersonalWikiSourceSelected } from "./memory-promotion-source-picker.ts";
import "./memory-promotion-source-picker.ts";

class MemoryPromotionsElement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = false;
  @property({ type: Boolean }) wikiSearchAdvertised = false;
  @property({ type: Boolean }) wikiGetAdvertised = false;
  @property() agentId: string | null = null;

  @state() private snapshot: OrganizationMemoryLifecycleSnapshot | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private sourceKind: OrganizationMemoryPromotionSourceKind = "personal";
  @state() private sourceClaimId = "";
  @state() private sourceRevision = "1";
  @state() private targetScopeId = "";
  @state() private proposedText = "";
  @state() private evidence = "";
  @state() private reason = "";
  private loadRequest: object | null = null;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  protected override updated(changed: PropertyValues<this>) {
    if (
      changed.has("client") ||
      changed.has("connected") ||
      changed.has("agentId") ||
      changed.has("methodAdvertised")
    ) {
      void this.load();
    }
  }

  private async load(page?: OrganizationMemoryLifecycleSnapshot["next"]) {
    const client = this.connected && this.methodAdvertised ? this.client : null;
    const agentId = this.agentId;
    if (!client || !agentId) {
      this.loadRequest = null;
      this.snapshot = null;
      this.loading = false;
      return;
    }
    const request = {};
    this.loadRequest = request;
    this.loading = true;
    this.error = null;
    try {
      const requestPage =
        page && this.snapshot
          ? {
              claims: page.claims ?? this.snapshot.claims.length,
              submitted: page.submitted ?? this.snapshot.submitted.length,
              reviewable: page.reviewable ?? this.snapshot.reviewable.length,
            }
          : {};
      const loaded = await client.request<OrganizationMemoryLifecycleSnapshot>(
        "platformclaw.memory.lifecycle",
        requestPage,
      );
      if (this.loadRequest !== request) {
        return;
      }
      this.snapshot =
        page && this.snapshot
          ? {
              ...loaded,
              claims: [...this.snapshot.claims, ...loaded.claims],
              submitted: [...this.snapshot.submitted, ...loaded.submitted],
              reviewable: [...this.snapshot.reviewable, ...loaded.reviewable],
            }
          : loaded;
    } catch (error) {
      if (this.loadRequest !== request) {
        return;
      }
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
    } finally {
      if (this.loadRequest === request) {
        this.loadRequest = null;
        this.loading = false;
      }
    }
  }

  private sourceClaims() {
    return (this.snapshot?.claims ?? []).filter(
      (claim) => claim.status === "active" && claim.scopeKind === this.sourceKind,
    );
  }

  private targetScopes() {
    const scopes = this.snapshot?.scopes ?? [];
    if (this.sourceKind === "personal") {
      return scopes.filter((scope) => scope.kind === "part");
    }
    if (this.sourceKind === "part") {
      const source = this.sourceClaims().find((claim) => claim.id === this.sourceClaimId);
      const part = scopes.find((scope) => scope.id === source?.scopeId);
      return scopes.filter((scope) => scope.kind === "group" && scope.id === part?.parentGroupId);
    }
    return scopes.filter((scope) => scope.kind === "global");
  }

  private resetForSourceKind(kind: OrganizationMemoryPromotionSourceKind) {
    this.sourceKind = kind;
    this.sourceClaimId = "";
    this.sourceRevision = "1";
    this.targetScopeId = "";
    this.proposedText = "";
    this.evidence = "";
    this.reason = "";
  }

  private async submit() {
    const client = this.client;
    const target = this.targetScopes().find(
      (scope) => (scope.id ?? "global") === this.targetScopeId,
    );
    if (!client || !target) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const content = {
        sourceClaimId: this.sourceClaimId,
        proposedText: this.proposedText,
        evidence: this.evidence
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
        reason: this.reason,
      };
      await client.request("platformclaw.memory.promotion.submit", {
        ...content,
        sourceKind: this.sourceKind,
        ...(this.sourceKind === "personal"
          ? {}
          : { expectedSourceRevision: Number(this.sourceRevision) }),
        targetKind: target.kind,
        ...(target.id ? { targetScopeId: target.id } : {}),
      });
      this.proposedText = "";
      this.evidence = "";
      this.reason = "";
      await this.load();
    } catch (error) {
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
      this.loading = false;
    }
  }

  private selectPersonalSource(event: CustomEvent<PersonalWikiSourceSelected>) {
    this.sourceClaimId = event.detail.lookup;
    this.proposedText = event.detail.content;
    this.evidence = event.detail.path;
    this.reason = t("memoryPage.promotions.defaultReason");
    this.targetScopeId = "";
  }

  private async decide(
    request: OrganizationMemoryPromotionRequest,
    decision: "approve" | "reject",
  ) {
    const reason = window.prompt(t("memoryPage.promotions.decisionReason"));
    if (!reason || !this.client) {
      return;
    }
    this.loading = true;
    try {
      await this.client.request("platformclaw.memory.promotion.decide", {
        requestId: request.id,
        decision,
        reason,
      });
      await this.load();
    } catch (error) {
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
      this.loading = false;
    }
  }

  private async retire(claimId: string, purge: boolean) {
    const reason = window.prompt(
      t(purge ? "memoryPage.promotions.purgeReason" : "memoryPage.promotions.retireReason"),
    );
    if (!reason || !this.client) {
      return;
    }
    this.loading = true;
    try {
      await this.client.request(
        purge ? "platformclaw.memory.claim.purge" : "platformclaw.memory.claim.retire",
        { claimId, reason },
      );
      await this.load();
    } catch (error) {
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
      this.loading = false;
    }
  }

  private canAdministerClaim(scopeKind: "global" | "group" | "part", scopeId?: string) {
    return (this.snapshot?.scopes ?? []).some(
      (scope) =>
        scope.kind === scopeKind && (scope.id ?? null) === (scopeId ?? null) && scope.canAdminister,
    );
  }

  private statusLabel(
    status: "pending" | "approved" | "rejected" | "active" | "retired" | "purged",
  ) {
    switch (status) {
      case "pending":
        return t("memoryPage.promotions.statusPending");
      case "approved":
        return t("memoryPage.promotions.statusApproved");
      case "rejected":
        return t("memoryPage.promotions.statusRejected");
      case "active":
        return t("memoryPage.promotions.statusActive");
      case "retired":
        return t("memoryPage.promotions.statusRetired");
      case "purged":
        return t("memoryPage.promotions.statusPurged");
    }
  }

  private sourceLabel(kind: OrganizationMemoryPromotionSourceKind) {
    return kind === "personal"
      ? t("memoryPage.promotions.personal")
      : kind === "part"
        ? t("memoryPage.promotions.part")
        : t("memoryPage.promotions.group");
  }

  private renderRequest(request: OrganizationMemoryPromotionRequest, review = false) {
    return html`<div class="settings-row">
      <span class="settings-row__text">
        <span class="settings-row__title">${request.proposedText}</span>
        <span class="settings-row__desc"
          >${this.sourceLabel(request.sourceKind)} · ${request.sourceClaimId} ·
          ${t("memoryPage.promotions.revision", { revision: String(request.sourceRevision) })} →
          ${request.targetScopeName} · ${this.statusLabel(request.status)}</span
        >
        <span class="settings-row__desc"
          >${t("memoryPage.promotions.reasonLabel")}: ${request.reason}</span
        >
        ${request.evidence.length > 0
          ? html`<span class="settings-row__desc"
              >${t("memoryPage.promotions.evidenceLabel")}: ${request.evidence.join(" · ")}</span
            >`
          : nothing}
        ${request.decisionReason
          ? html`<span class="settings-row__desc"
              >${t("memoryPage.promotions.decisionLabel")}: ${request.decisionReason}</span
            >`
          : nothing}
      </span>
      ${review
        ? html`<span class="settings-row__control">
            <button
              class="btn btn--sm primary"
              @click=${() => void this.decide(request, "approve")}
            >
              ${t("memoryPage.promotions.approve")}
            </button>
            <button class="btn btn--sm" @click=${() => void this.decide(request, "reject")}>
              ${t("memoryPage.promotions.reject")}
            </button>
          </span>`
        : nothing}
    </div>`;
  }

  override render() {
    if (!this.methodAdvertised) {
      return html`<p class="memory-memories__unavailable">
        ${t("memoryPage.promotions.gatewayUpdateRequired")}
      </p>`;
    }
    if (this.loading && !this.snapshot) {
      return html`<div class="settings-page memory-promotions">
        <p class="memory-promotions__empty" role="status">${t("memoryPage.promotions.loading")}</p>
      </div>`;
    }
    const sourceClaims = this.sourceClaims();
    const targets = this.targetScopes();
    return html`<div class="settings-page memory-promotions">
      <section class="settings-section">
        <header class="settings-section__header">
          <div>
            <h2 class="settings-section__heading">${t("memoryPage.promotions.title")}</h2>
            <p class="settings-section__description">${t("memoryPage.promotions.description")}</p>
          </div>
        </header>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        <div class="settings-group">
          <label class="settings-row">
            <span class="settings-row__text"
              ><span class="settings-row__title">${t("memoryPage.promotions.source")}</span></span
            >
            <select
              class="settings-select"
              .value=${this.sourceKind}
              @change=${(event: Event) =>
                this.resetForSourceKind(
                  (event.currentTarget as HTMLSelectElement)
                    .value as OrganizationMemoryPromotionSourceKind,
                )}
            >
              <option value="personal">${t("memoryPage.promotions.personal")}</option>
              <option value="part">${t("memoryPage.promotions.part")}</option>
              <option value="group">${t("memoryPage.promotions.group")}</option>
            </select>
          </label>
          ${this.sourceKind === "personal"
            ? html`<openclaw-memory-promotion-source-picker
                .client=${this.client}
                .connected=${this.connected}
                .searchAdvertised=${this.wikiSearchAdvertised}
                .getAdvertised=${this.wikiGetAdvertised}
                .agentId=${this.agentId}
                @source-selected=${(event: CustomEvent<PersonalWikiSourceSelected>) =>
                  this.selectPersonalSource(event)}
              ></openclaw-memory-promotion-source-picker>`
            : html`<select
                class="settings-select"
                .value=${this.sourceClaimId}
                @change=${(event: Event) => {
                  const claim = sourceClaims.find(
                    (item) => item.id === (event.currentTarget as HTMLSelectElement).value,
                  );
                  this.sourceClaimId = claim?.id ?? "";
                  this.sourceRevision = String(claim?.revision ?? 1);
                  this.proposedText = claim?.text ?? "";
                  this.evidence = claim ? `${claim.id}@${claim.revision}` : "";
                  this.reason = claim ? t("memoryPage.promotions.defaultReason") : "";
                  this.targetScopeId = "";
                }}
              >
                <option value="">${t("memoryPage.promotions.chooseClaim")}</option>
                ${sourceClaims.map(
                  (claim) =>
                    html`<option value=${claim.id}>${claim.scopeName} · ${claim.title}</option>`,
                )}
              </select>`}
          <label class="memory-promotions__field">
            <span>${t("memoryPage.promotions.target")}</span>
            <select
              class="settings-select"
              .value=${this.targetScopeId}
              @change=${(event: Event) =>
                (this.targetScopeId = (event.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">${t("memoryPage.promotions.chooseTarget")}</option>
              ${targets.map(
                (scope) => html`<option value=${scope.id ?? "global"}>${scope.name}</option>`,
              )}
            </select>
          </label>
          <label class="memory-promotions__field">
            <span>${t("memoryPage.promotions.proposedText")}</span>
            <textarea
              class="settings-textarea"
              placeholder=${t("memoryPage.promotions.textPlaceholder")}
              .value=${this.proposedText}
              @input=${(event: InputEvent) =>
                (this.proposedText = (event.currentTarget as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
          <label class="memory-promotions__field">
            <span>${t("memoryPage.promotions.evidenceLabel")}</span>
            <textarea
              class="settings-textarea"
              placeholder=${t("memoryPage.promotions.evidencePlaceholder")}
              .value=${this.evidence}
              @input=${(event: InputEvent) =>
                (this.evidence = (event.currentTarget as HTMLTextAreaElement).value)}
            ></textarea>
          </label>
          <label class="memory-promotions__field">
            <span>${t("memoryPage.promotions.reasonLabel")}</span>
            <input
              class="settings-input"
              placeholder=${t("memoryPage.promotions.reasonPlaceholder")}
              .value=${this.reason}
              @input=${(event: InputEvent) =>
                (this.reason = (event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button
            class="btn btn--sm primary"
            ?disabled=${this.loading ||
            !this.sourceClaimId ||
            !this.targetScopeId ||
            !this.proposedText.trim() ||
            !this.reason.trim()}
            @click=${() => void this.submit()}
          >
            ${t("memoryPage.promotions.submit")}
          </button>
        </div>
      </section>
      <section class="settings-section">
        <header class="settings-section__header">
          <h3 class="settings-section__heading">${t("memoryPage.promotions.needsReview")}</h3>
        </header>
        <div class="settings-group">
          ${(this.snapshot?.reviewable ?? []).length > 0
            ? this.snapshot!.reviewable.map((request) => this.renderRequest(request, true))
            : html`<p class="memory-promotions__empty">${t("memoryPage.promotions.noReviews")}</p>`}
        </div>
      </section>
      <section class="settings-section">
        <header class="settings-section__header">
          <h3 class="settings-section__heading">${t("memoryPage.promotions.myRequests")}</h3>
        </header>
        <div class="settings-group">
          ${(this.snapshot?.submitted ?? []).length > 0
            ? this.snapshot!.submitted.map((request) => this.renderRequest(request))
            : html`<p class="memory-promotions__empty">
                ${t("memoryPage.promotions.noRequests")}
              </p>`}
        </div>
      </section>
      <section class="settings-section">
        <header class="settings-section__header">
          <h3 class="settings-section__heading">${t("memoryPage.promotions.claims")}</h3>
        </header>
        <div class="settings-group">
          ${(this.snapshot?.claims ?? []).length > 0
            ? this.snapshot!.claims.map(
                (claim) => html`<div class="settings-row">
                  <span class="settings-row__text">
                    <span class="settings-row__title">${claim.title}</span>
                    <span class="settings-row__desc"
                      >${claim.scopeName} · ${this.statusLabel(claim.status)}</span
                    >
                  </span>
                  <span class="settings-row__control">
                    ${claim.status === "active" &&
                    this.canAdministerClaim(claim.scopeKind, claim.scopeId)
                      ? html`<button
                          class="btn btn--sm"
                          @click=${() => void this.retire(claim.id, false)}
                        >
                          ${t("memoryPage.promotions.retire")}
                        </button>`
                      : claim.status === "retired" && this.snapshot?.canApproveGlobal
                        ? html`<button
                            class="btn btn--sm danger"
                            @click=${() => void this.retire(claim.id, true)}
                          >
                            ${t("memoryPage.promotions.purge")}
                          </button>`
                        : nothing}
                  </span>
                </div>`,
              )
            : html`<p class="memory-promotions__empty">${t("memoryPage.promotions.noClaims")}</p>`}
        </div>
        ${this.snapshot?.next
          ? html`<button
              class="btn btn--sm"
              ?disabled=${this.loading}
              @click=${() => void this.load(this.snapshot?.next)}
            >
              ${t("memoryPage.promotions.loadMore")}
            </button>`
          : nothing}
      </section>
    </div>`;
  }
}

if (!customElements.get("openclaw-memory-promotions")) {
  customElements.define("openclaw-memory-promotions", MemoryPromotionsElement);
}
