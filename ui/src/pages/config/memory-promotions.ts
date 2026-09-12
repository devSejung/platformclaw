import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  OrganizationMemoryLifecycleSnapshot,
  OrganizationMemoryPromotionRequest,
  OrganizationMemoryPromotionSourceKind,
} from "../../../../packages/platformclaw-control-plane/src/contracts.js";
import type { OrganizationPromotionKnowledgeComparison } from "../../../../packages/platformclaw-control-plane/src/organization-memory-knowledge-contracts.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "../../platformclaw/i18n.ts";
import { renderOrganizationMemoryDocumentPreview } from "../../platformclaw/organization-memory-document-preview.ts";
import {
  retirePromotionClaim,
  renderPromotionDecisionDialog,
  renderPromotionReferencesConfirmation,
  renderPromotionRequest,
  promotionStatusLabel,
  promotionSourceClaims,
  promotionTargetScopes,
  type PromotionReferencesPreview,
  type PromotionReferenceConfirmation,
} from "./memory-promotion-review.ts";
import "../../styles/sidebar-markdown.css";
import "./memory-promotion-source-picker.ts";
import type { PersonalWikiSourceSelected } from "./memory-promotion-source-picker.ts";

class MemoryPromotionsElement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = false;
  @property({ type: Boolean }) wikiSearchAdvertised = false;
  @property({ type: Boolean }) wikiGetAdvertised = false;
  @property({ type: Boolean }) comparisonAdvertised = false;
  @property({ type: Boolean }) referencesAdvertised = false;
  @property({ type: Boolean }) getAdvertised = false;
  @state() private referencePath: string | null = null;
  @property() agentId: string | null = null;
  @property() initialPersonalLookup: string | null = null;
  @property({ type: Boolean }) formOnly = false;

  @state() private snapshot: OrganizationMemoryLifecycleSnapshot | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private sourceKind: OrganizationMemoryPromotionSourceKind = "personal";
  @state() private sourceClaimId = "";
  @state() private sourceRevision = "1";
  @state() private targetScopeId = "";
  @state() private proposedText = "";
  @state() private proposedTextTab: "write" | "preview" = "write";
  @state() private evidence = "";
  @state() private reason = "";
  @state() private success: string | null = null;
  @state() private referencesPreview: PromotionReferenceConfirmation | null = null;
  @state() private pendingDecision: {
    request: OrganizationMemoryPromotionRequest;
    decision: "approve" | "reject";
    comparison: OrganizationPromotionKnowledgeComparison | null;
  } | null = null;
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
      changed.has("initialPersonalLookup")
    ) {
      this.resetForSourceKind("personal");
      this.pendingDecision = null;
      this.referencePath = null;
      if (changed.has("client") || changed.has("connected") || changed.has("agentId")) {
        this.snapshot = null;
      }
    }
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
      this.snapshot = null;
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
    } finally {
      if (this.loadRequest === request) {
        this.loadRequest = null;
        this.loading = false;
      }
    }
  }

  private resetForSourceKind(kind: OrganizationMemoryPromotionSourceKind) {
    this.referencesPreview = null;
    this.success = null;
    this.sourceKind = kind;
    this.sourceClaimId = "";
    this.sourceRevision = "1";
    this.targetScopeId = "";
    this.proposedText = "";
    this.proposedTextTab = "write";
    this.evidence = "";
    this.reason = "";
  }

  private async submit(confirmed = false) {
    const client = this.client;
    const agentId = this.agentId;
    const target = promotionTargetScopes(this.snapshot, this.sourceKind, this.sourceClaimId).find(
      (scope) => (scope.scopeId ?? "global") === this.targetScopeId,
    );
    if (
      !client ||
      !this.connected ||
      !target ||
      !this.sourceClaimId ||
      !this.proposedText.trim() ||
      !this.reason.trim()
    ) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.success = null;
    // The enclosing sharing dialog must keep pending outcomes visible to the user.
    this.dispatchEvent(new CustomEvent("promotion-submit-state", { bubbles: true, detail: true }));
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
      const original =
        confirmed && this.referencesPreview
          ? this.referencesPreview.original
          : {
              ...content,
              sourceKind: this.sourceKind,
              ...(this.sourceKind === "personal"
                ? {}
                : { expectedSourceRevision: Number(this.sourceRevision) }),
              targetKind: target.kind,
              ...(target.scopeId ? { targetScopeId: target.scopeId } : {}),
            };
      if (!confirmed && this.referencesAdvertised) {
        const { evidence: _evidence, reason: _reason, ...previewInput } = original;
        const preview = await client.request<PromotionReferencesPreview>(
          "platformclaw.memory.promotion.previewReferences",
          previewInput,
        );
        if (this.client !== client || this.agentId !== agentId || !this.connected) {
          return;
        }
        if (preview.references) {
          this.referencesPreview = {
            proposedText: preview.proposedText,
            references: preview.references,
            original,
          };
          this.loading = false;
          return;
        }
      }
      await client.request(
        target.mode === "direct"
          ? "platformclaw.memory.promotion.publishDirect"
          : "platformclaw.memory.promotion.submit",
        {
          ...original,
          ...(confirmed && this.referencesPreview
            ? { expectedReferencesFingerprint: this.referencesPreview.references.fingerprint }
            : {}),
        },
      );
      if (this.client !== client || this.agentId !== agentId || !this.connected) {
        return;
      }
      this.proposedText = "";
      this.referencesPreview = null;
      this.evidence = "";
      this.reason = "";
      this.success = t(
        target.mode === "direct"
          ? "memoryPage.promotions.publishedSuccess"
          : "memoryPage.promotions.submittedSuccess",
        { scope: target.scopeName },
      );
      this.dispatchEvent(
        new CustomEvent("promotion-submitted", {
          bubbles: true,
          composed: true,
          detail: { message: this.success, scopeName: target.scopeName, mode: target.mode },
        }),
      );
      await this.load();
    } catch (error) {
      if (this.client !== client || this.agentId !== agentId || !this.connected) {
        return;
      }
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
      this.referencesPreview = null;
      this.loading = false;
    } finally {
      this.dispatchEvent(
        new CustomEvent("promotion-submit-state", { bubbles: true, detail: false }),
      );
    }
  }

  private selectPersonalSource(event: CustomEvent<PersonalWikiSourceSelected>) {
    this.success = null;
    this.sourceClaimId = event.detail.lookup;
    this.proposedText = event.detail.content;
    this.evidence = event.detail.path;
    this.reason = t("memoryPage.promotions.defaultReason");
    this.targetScopeId = "";
  }

  private decide(request: OrganizationMemoryPromotionRequest, decision: "approve" | "reject") {
    this.error = null;
    this.pendingDecision = {
      request,
      decision,
      comparison: request.relatedKnowledgeComparison ?? null,
    };
  }

  private async comparePending() {
    const pending = this.pendingDecision;
    const client = this.client;
    const agentId = this.agentId;
    if (!pending || !client || !this.connected || !this.comparisonAdvertised || this.loading) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const comparison = await client.request<OrganizationPromotionKnowledgeComparison>(
        "platformclaw.memory.knowledge.comparePromotion",
        { requestId: pending.request.id },
      );
      if (
        this.client === client &&
        this.agentId === agentId &&
        this.pendingDecision === pending &&
        this.connected
      ) {
        this.pendingDecision = { ...pending, comparison };
      }
    } catch (error) {
      if (
        this.client === client &&
        this.agentId === agentId &&
        this.pendingDecision === pending &&
        this.connected
      ) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
        this.pendingDecision = { ...pending, comparison: { status: "unavailable" } };
      }
    } finally {
      if (this.client === client && this.agentId === agentId && this.connected) {
        this.loading = false;
      }
    }
  }

  private async submitDecision(reason: string) {
    const pending = this.pendingDecision;
    if (
      !pending ||
      !reason ||
      !this.client ||
      (pending.decision === "approve" && pending.comparison?.status === "stale")
    ) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      await this.client.request("platformclaw.memory.promotion.decide", {
        requestId: pending.request.id,
        decision: pending.decision,
        reason,
        ...(pending.decision === "approve" && pending.request.references
          ? { expectedReferencesFingerprint: pending.request.references.fingerprint }
          : {}),
        ...(pending.decision === "approve" &&
        pending.comparison?.status === "available" &&
        pending.comparison.inputFingerprint
          ? { expectedComparisonFingerprint: pending.comparison.inputFingerprint }
          : {}),
      });
      this.pendingDecision = null;
      await this.load();
    } catch (error) {
      if (this.pendingDecision === pending && pending.request.references) {
        await this.load();
        const fresh = this.snapshot?.reviewable.find(
          (request) => request.id === pending.request.id,
        );
        this.pendingDecision = fresh
          ? { ...pending, request: fresh, comparison: fresh.relatedKnowledgeComparison ?? null }
          : null;
      } else if (this.pendingDecision === pending && pending.comparison?.status === "available") {
        this.pendingDecision = {
          ...pending,
          comparison: { ...pending.comparison, status: "stale" },
        };
      }
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
      this.loading = false;
    }
  }

  private renderDecisionDialog() {
    return renderPromotionDecisionDialog({
      pending: this.pendingDecision,
      loading: this.loading,
      error: this.error,
      comparisonAdvertised: this.comparisonAdvertised,
      onCancel: () => {
        this.pendingDecision = null;
        this.error = null;
      },
      onSubmit: (reason) => void this.submitDecision(reason),
      onCompare: () => void this.comparePending(),
    });
  }

  private async retire(claimId: string, purge: boolean) {
    await retirePromotionClaim(
      {
        client: this.client,
        onBusy: (busy) => (this.loading = busy),
        onReload: () => this.load(),
        onError: (error) => (this.error = formatErrorMessage(error, { redact: redactToolDetail })),
      },
      claimId,
      purge,
    );
  }
  private renderRequest(request: OrganizationMemoryPromotionRequest, review = false) {
    return renderPromotionRequest(request, {
      review,
      loading: this.loading,
      comparisonAdvertised: this.comparisonAdvertised,
      onDecide: (candidate, decision) => this.decide(candidate, decision),
      onCompare: (candidate) => {
        this.decide(candidate, "approve");
        void this.comparePending();
      },
    });
  }

  override render() {
    if (!this.methodAdvertised) {
      return html`<p class="memory-memories__unavailable">
        ${t("memoryPage.promotions.gatewayUpdateRequired")}
      </p>`;
    }
    if (!this.snapshot) {
      return html`<div class="settings-page memory-promotions">
        ${this.error
          ? html`<p role="alert">${this.error}</p>
              <button
                class="btn btn--sm"
                ?disabled=${this.loading || !this.connected}
                @click=${() => void this.load()}
              >
                ${t("memoryPage.memories.retry")}
              </button>`
          : html`<p class="memory-promotions__empty" role="status">
              ${t("memoryPage.promotions.loading")}
            </p>`}
      </div>`;
    }
    const sourceClaims = promotionSourceClaims(this.snapshot, this.sourceKind);
    const targets = promotionTargetScopes(this.snapshot, this.sourceKind, this.sourceClaimId);
    const selectedTarget = targets.find(
      (target) => (target.scopeId ?? "global") === this.targetScopeId,
    );
    return html`<div
      class="settings-page memory-promotions"
      @organization-reference-open=${(event: CustomEvent<string>) => {
        this.referencePath = event.detail;
      }}
    >
      ${renderOrganizationMemoryDocumentPreview(this, this.referencePath, () => {
        this.referencePath = null;
      })}
      <section class="settings-section">
        <header class="settings-section__header">
          <div>
            <h2 class="settings-section__heading">${t("memoryPage.promotions.title")}</h2>
            <p class="settings-section__description">${t("memoryPage.promotions.description")}</p>
          </div>
          ${!this.formOnly
            ? html`<button
                class="btn btn--sm"
                ?disabled=${this.loading || !this.connected}
                @click=${() => void this.load()}
              >
                ${t("memoryPage.memories.refresh")}
              </button>`
            : nothing}
        </header>
        ${this.error && !this.pendingDecision ? html`<p role="alert">${this.error}</p>` : nothing}
        ${this.success ? html`<p role="status">${this.success}</p>` : nothing}
        ${this.referencesPreview
          ? renderPromotionReferencesConfirmation({
              preview: this.referencesPreview,
              loading: this.loading,
              error: this.error,
              onCancel: () => {
                this.referencesPreview = null;
                this.error = null;
              },
              onConfirm: () => {
                void this.submit(true);
              },
            })
          : nothing}
        <fieldset class="settings-group" style="margin:0;padding:0" ?disabled=${this.loading}>
          <label class="settings-row memory-promotions__source-row">
            <span class="settings-row__text"
              ><span class="settings-row__title">${t("memoryPage.promotions.source")}</span></span
            >
            <span class="settings-row__control">
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
                <option value="team">${t("memoryPage.promotions.team")}</option>
              </select>
            </span>
          </label>
          ${this.sourceKind === "personal"
            ? html`<openclaw-memory-promotion-source-picker
                .client=${this.client}
                .connected=${this.connected}
                .searchAdvertised=${this.wikiSearchAdvertised}
                .getAdvertised=${this.wikiGetAdvertised}
                .agentId=${this.agentId}
                .initialPersonalLookup=${this.initialPersonalLookup}
                @source-cleared=${() => this.resetForSourceKind("personal")}
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
                (scope) =>
                  html`<option value=${scope.scopeId ?? "global"}>${scope.scopeName}</option>`,
              )}
            </select>
          </label>
          ${selectedTarget
            ? html`<p class="memory-promotions__visibility" role="status">
                ${t(
                  selectedTarget.mode === "direct"
                    ? "memoryPage.promotions.directVisibility"
                    : "memoryPage.promotions.requestVisibility",
                  { scope: selectedTarget.scopeName },
                )}
              </p>`
            : nothing}
          <div class="memory-promotions__field">
            <span>${t("memoryPage.promotions.proposedText")}</span>
            ${renderHubTabs({
              id: "memory-promotion-document",
              active: this.proposedTextTab,
              tabs: [
                { value: "write", label: t("memoryPage.promotions.write") },
                { value: "preview", label: t("memoryPage.promotions.preview") },
              ],
              ariaLabel: t("memoryPage.promotions.proposedText"),
              panelId: "memory-promotion-document-panel",
              variant: "sub",
              onSelect: (tab) => (this.proposedTextTab = tab),
            })}
            <div id="memory-promotion-document-panel">
              ${this.proposedTextTab === "write"
                ? html`<textarea
                    aria-label=${t("memoryPage.promotions.proposedText")}
                    class="settings-textarea"
                    placeholder=${t("memoryPage.promotions.textPlaceholder")}
                    .value=${this.proposedText}
                    @input=${(event: InputEvent) =>
                      (this.proposedText = (event.currentTarget as HTMLTextAreaElement).value)}
                  ></textarea>`
                : html`<article class="sidebar-markdown memory-promotions__document">
                    ${unsafeHTML(
                      toSanitizedMarkdownHtml(this.proposedText, {
                        codeBlockChrome: "none",
                        fileLinks: false,
                        interactiveImages: false,
                      }),
                    )}
                  </article>`}
            </div>
          </div>
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
            ${targets.find((target) => (target.scopeId ?? "global") === this.targetScopeId)
              ?.mode === "direct"
              ? t("memoryPage.promotions.publishDirect")
              : t("memoryPage.promotions.submit")}
          </button>
        </fieldset>
      </section>
      ${this.formOnly
        ? nothing
        : html`<section class="settings-section">
              <header class="settings-section__header">
                <h3 class="settings-section__heading">${t("memoryPage.promotions.needsReview")}</h3>
              </header>
              <div class="settings-group">
                ${(this.snapshot?.reviewable ?? []).length > 0
                  ? this.snapshot!.reviewable.map((request) => this.renderRequest(request, true))
                  : html`<p class="memory-promotions__empty">
                      ${t("memoryPage.promotions.noReviews")}
                    </p>`}
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
                            >${claim.scopeName} · ${promotionStatusLabel(claim.status)}</span
                          >
                        </span>
                        <span class="settings-row__control">
                          ${claim.status === "active" && claim.canRetire
                            ? html`<button
                                class="btn btn--sm"
                                ?disabled=${this.loading}
                                @click=${() => void this.retire(claim.id, false)}
                              >
                                ${t("memoryPage.promotions.retire")}
                              </button>`
                            : claim.status === "retired" && claim.canPurge
                              ? html`<button
                                  class="btn btn--sm danger"
                                  ?disabled=${this.loading}
                                  @click=${() => void this.retire(claim.id, true)}
                                >
                                  ${t("memoryPage.promotions.purge")}
                                </button>`
                              : nothing}
                        </span>
                      </div>`,
                    )
                  : html`<p class="memory-promotions__empty">
                      ${t("memoryPage.promotions.noClaims")}
                    </p>`}
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
            ${this.renderDecisionDialog()}`}
    </div>`;
  }
}

if (!customElements.get("openclaw-memory-promotions")) {
  customElements.define("openclaw-memory-promotions", MemoryPromotionsElement);
}
