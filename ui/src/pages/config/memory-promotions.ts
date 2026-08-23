import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  OrganizationMemoryLifecycleSnapshot,
  OrganizationMemoryPromotionRequest,
  OrganizationMemoryPromotionSourceKind,
} from "../../../../packages/platformclaw-control-plane/src/contracts.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

class MemoryPromotionsElement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = false;
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
      this.snapshot = null;
      return;
    }
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
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
    } finally {
      this.loading = false;
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
      await client.request("platformclaw.memory.promotion.submit", {
        sourceKind: this.sourceKind,
        sourceClaimId: this.sourceClaimId,
        ...(this.sourceKind === "personal"
          ? {}
          : { expectedSourceRevision: Number(this.sourceRevision) }),
        targetKind: target.kind,
        ...(target.id ? { targetScopeId: target.id } : {}),
        proposedText: this.proposedText,
        evidence: this.evidence
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean),
        reason: this.reason,
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

  private renderRequest(request: OrganizationMemoryPromotionRequest, review = false) {
    return html`<div class="settings-row">
      <span class="settings-row__text">
        <span class="settings-row__title">${request.proposedText}</span>
        <span class="settings-row__desc"
          >${request.sourceKind}:${request.sourceClaimId}@${request.sourceRevision} →
          ${request.targetScopeName} · ${request.status}</span
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
    const sourceClaims = this.sourceClaims();
    const targets = this.targetScopes();
    return html`<section class="memory-promotions">
      <h2>${t("memoryPage.promotions.title")}</h2>
      <p class="muted">${t("memoryPage.promotions.description")}</p>
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
          ? html`<input
              class="settings-input"
              placeholder=${t("memoryPage.promotions.personalClaimPlaceholder")}
              .value=${this.sourceClaimId}
              @input=${(event: InputEvent) =>
                (this.sourceClaimId = (event.currentTarget as HTMLInputElement).value)}
            />`
          : html`<select
              class="settings-select"
              .value=${this.sourceClaimId}
              @change=${(event: Event) => {
                const claim = sourceClaims.find(
                  (item) => item.id === (event.currentTarget as HTMLSelectElement).value,
                );
                this.sourceClaimId = claim?.id ?? "";
                this.sourceRevision = String(claim?.revision ?? 1);
                this.targetScopeId = "";
              }}
            >
              <option value="">${t("memoryPage.promotions.chooseClaim")}</option>
              ${sourceClaims.map(
                (claim) =>
                  html`<option value=${claim.id}>${claim.scopeName} · ${claim.title}</option>`,
              )}
            </select>`}
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
        <textarea
          class="settings-textarea"
          placeholder=${t("memoryPage.promotions.textPlaceholder")}
          .value=${this.proposedText}
          @input=${(event: InputEvent) =>
            (this.proposedText = (event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
        <textarea
          class="settings-textarea"
          placeholder=${t("memoryPage.promotions.evidencePlaceholder")}
          .value=${this.evidence}
          @input=${(event: InputEvent) =>
            (this.evidence = (event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
        <input
          class="settings-input"
          placeholder=${t("memoryPage.promotions.reasonPlaceholder")}
          .value=${this.reason}
          @input=${(event: InputEvent) =>
            (this.reason = (event.currentTarget as HTMLInputElement).value)}
        />
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
      <h3>${t("memoryPage.promotions.needsReview")}</h3>
      <div class="settings-group">
        ${(this.snapshot?.reviewable ?? []).map((request) => this.renderRequest(request, true))}
      </div>
      <h3>${t("memoryPage.promotions.myRequests")}</h3>
      <div class="settings-group">
        ${(this.snapshot?.submitted ?? []).map((request) => this.renderRequest(request))}
      </div>
      <h3>${t("memoryPage.promotions.claims")}</h3>
      <div class="settings-group">
        ${(this.snapshot?.claims ?? []).map(
          (claim) => html`<div class="settings-row">
            <span class="settings-row__text">
              <span class="settings-row__title">${claim.title}</span>
              <span class="settings-row__desc">${claim.scopeName} · ${claim.status}</span>
            </span>
            <span class="settings-row__control">
              ${claim.status === "active" && this.canAdministerClaim(claim.scopeKind, claim.scopeId)
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
        )}
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
    </section>`;
  }
}

if (!customElements.get("openclaw-memory-promotions")) {
  customElements.define("openclaw-memory-promotions", MemoryPromotionsElement);
}
