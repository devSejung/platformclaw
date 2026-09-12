import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  OrganizationKnowledgeProposal,
  OrganizationKnowledgeSnapshot,
  OrganizationKnowledgeSnapshotResponse,
} from "../../../packages/platformclaw-control-plane/src/organization-memory-knowledge-contracts.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import "../components/modal-dialog.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { formatMs, formatRelativeTimestamp } from "../lib/format.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import "./memory-knowledge-management.css";
import { renderKnowledgeComparison } from "./memory-knowledge-comparison.ts";

const METHOD = "platformclaw.memory.knowledge.";
const key = (name: string) => `platformClaw.memory.knowledge.${name}`;
const POLL_INTERVAL_MS = 2_000;
const MAX_JOB_POLLS = 150;

class PlatformClawMemoryKnowledgeManagement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = false;
  @property({ type: Boolean }) generateAdvertised = false;
  @property({ type: Boolean }) decideAdvertised = false;
  @property({ type: Boolean }) applyAdvertised = false;
  @property() agentId: string | null = null;

  @state() private response: OrganizationKnowledgeSnapshotResponse | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private outcomeMessage: string | null = null;
  @state() private historyFilter: "all" | "rejected" = "all";
  private historyCursor: { occurredAt: number; id: string } | undefined;
  @state() private action:
    | (
        | {
            proposal: OrganizationKnowledgeProposal;
            decision: "approve" | "reject" | "keep";
          }
        | {
            proposal: OrganizationKnowledgeProposal;
            decision: "apply";
            survivorClaimId: string;
            title: string;
            body: string;
          }
      )
    | null = null;
  private epoch = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollingJob: string | null = null;
  private pollAttempts = 0;
  @state() private pollingStopped = false;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  override disconnectedCallback() {
    this.epoch++;
    this.resetPolling();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (
      changed.has("client") ||
      changed.has("connected") ||
      changed.has("methodAdvertised") ||
      changed.has("agentId")
    ) {
      this.epoch++;
      this.resetPolling();
      this.response = null;
      this.action = null;
      this.historyFilter = "all";
      this.historyCursor = undefined;
      this.error = null;
      this.outcomeMessage = null;
      this.busy = false;
      void this.load();
    }
  }

  private resetPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollingJob = null;
    this.pollAttempts = 0;
    this.pollingStopped = false;
  }

  private schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    const selected = this.response?.selected;
    const job = selected?.currentJob;
    if (
      !selected ||
      !this.isConnected ||
      !this.connected ||
      !job ||
      !["queued", "running"].includes(job.status)
    ) {
      this.resetPolling();
      return;
    }
    if (this.pollingJob !== job.id) {
      this.pollingJob = job.id;
      this.pollAttempts = 0;
      this.pollingStopped = false;
    }
    // Only this visible pane polls a running job. The five-minute cap is shared
    // across reads of the same job; a server read never starts model work.
    if (this.pollAttempts >= MAX_JOB_POLLS) {
      this.pollingStopped = true;
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollAttempts++;
      void this.load(selected.scope.id, true);
    }, POLL_INTERVAL_MS);
  }

  private async load(
    scopeId?: string,
    poll = false,
    historyCursor?: { occurredAt: number; id: string },
  ) {
    const client = this.connected && this.methodAdvertised && this.agentId ? this.client : null;
    if (!client || this.busy) {
      return;
    }
    if (scopeId && scopeId !== this.response?.selected?.scope.id && this.response) {
      this.resetPolling();
      this.response = { ...this.response, selected: null };
      this.action = null;
      this.outcomeMessage = null;
      this.historyFilter = "all";
      this.historyCursor = undefined;
    }
    if (!poll) {
      this.historyCursor = historyCursor;
    }
    const epoch = ++this.epoch;
    if (!poll) {
      this.busy = true;
    }
    this.error = null;
    // Reading the organization snapshot never starts analysis. Generation belongs
    // exclusively to the explicit button and the server-owned shared job.
    try {
      const response = await client.request<OrganizationKnowledgeSnapshotResponse>(
        `${METHOD}snapshot`,
        {
          ...(scopeId ? { scopeId } : {}),
          ...(this.historyFilter === "rejected" ? { historyDecision: "reject" } : {}),
          ...(this.historyCursor ? { historyCursor: this.historyCursor } : {}),
        },
      );
      if (epoch === this.epoch) {
        this.response = response;
        this.dispatchEvent(
          new CustomEvent("knowledge-eligibility-change", {
            detail: response.scopes.some((scope) => scope.capabilities.canReadReport),
            bubbles: true,
          }),
        );
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.response = null;
        this.action = null;
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
        this.dispatchEvent(
          new CustomEvent("knowledge-eligibility-change", { detail: false, bubbles: true }),
        );
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        this.schedulePoll();
      }
    }
  }

  private async mutate(method: "generate" | "decide" | "apply", params: Record<string, unknown>) {
    const selected = this.response?.selected;
    const advertised =
      method === "generate"
        ? this.generateAdvertised
        : method === "decide"
          ? this.decideAdvertised
          : this.applyAdvertised;
    const permitted =
      method === "generate"
        ? selected?.scope.capabilities.canGenerateReport
        : method === "decide"
          ? selected?.scope.capabilities.canReviewProposals
          : selected?.scope.capabilities.canApplyProposals;
    if (!this.client || !this.connected || !advertised || !permitted || !selected || this.busy) {
      return;
    }
    const epoch = ++this.epoch;
    clearTimeout(this.pollTimer);
    this.busy = true;
    this.error = null;
    try {
      const snapshot = await this.client.request<OrganizationKnowledgeSnapshot>(
        `${METHOD}${method}`,
        {
          ...params,
          scopeId: selected.scope.id,
          ...(method === "generate" ? { requestId: crypto.randomUUID() } : {}),
        },
      );
      if (epoch === this.epoch && this.response) {
        this.response = { ...this.response, selected: snapshot };
        this.action = null;
        this.historyFilter = "all";
        this.historyCursor = undefined;
        this.outcomeMessage =
          method === "decide" && params.decision === "reject" ? t(key("rejectedOutcome")) : null;
      }
    } catch (error) {
      // Keep the last successful report visible while the latest operation fails.
      if (epoch === this.epoch) {
        if (
          error instanceof GatewayRequestError &&
          ["cross-agent-denied", "method-not-allowed"].includes(error.code)
        ) {
          this.response = null;
          this.action = null;
        }
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
        if (!this.error) {
          this.schedulePoll();
        }
      }
    }
  }

  private time(timestamp: number) {
    return html`<time datetime=${new Date(timestamp).toISOString()}>
      ${formatMs(timestamp)} · ${formatRelativeTimestamp(timestamp)}
    </time>`;
  }

  private renderProposal(proposal: OrganizationKnowledgeProposal) {
    const capabilities = this.response!.selected!.scope.capabilities;
    return html`<article class="card" data-knowledge-proposal=${proposal.id}>
      <h3>${t(key(`kind.${proposal.kind}`))}</h3>
      ${renderKnowledgeComparison(proposal, proposal.sourceClaims, true)}
      <details>
        <summary>${t(key("technicalDetails"))}</summary>
        <p>${proposal.id}</p>
        ${proposal.claimRevisions.map((claim) => html`<p>${claim.id} · r${claim.revision}</p>`)}
      </details>
      <p>${t(key(`proposal.${proposal.status === "deferred" ? "pending" : proposal.status}`))}</p>
      ${proposal.inputStatus === "stale" ? html`<p>${t(key("staleProposal"))}</p>` : nothing}
      ${["pending", "deferred"].includes(proposal.status) &&
      proposal.inputStatus === "current" &&
      capabilities.canReviewProposals &&
      this.decideAdvertised
        ? html`${(["keep", "reject", "approve"] as const).map(
            (decision) => html`<button
              class="btn btn--sm"
              ?disabled=${this.busy}
              @click=${() => {
                this.action = { proposal, decision };
              }}
            >
              ${t(key(decision))}
            </button>`,
          )}`
        : nothing}
      ${proposal.status === "approved" &&
      proposal.inputStatus === "current" &&
      ["duplicate", "enrichment"].includes(proposal.kind) &&
      capabilities.canApplyProposals &&
      this.applyAdvertised
        ? html`<button
            class="btn btn--sm"
            ?disabled=${this.busy}
            @click=${() => this.openApply(proposal)}
          >
            ${t(key("apply"))}
          </button>`
        : nothing}
    </article>`;
  }

  private openApply(
    proposal: OrganizationKnowledgeProposal,
    survivorClaimId = proposal.sourceClaims[0]?.id,
  ) {
    const source = proposal.sourceClaims.find((claim) => claim.id === survivorClaimId);
    if (!source) {
      return;
    }
    const text = proposal.proposedText ?? source.text;
    const heading = /^#\s+([^\n]+)\n*/u.exec(text);
    this.action = {
      proposal,
      decision: "apply",
      survivorClaimId: source.id,
      title: heading?.[1] ?? source.title,
      body: heading ? text.slice(heading[0].length) : text,
    };
  }

  private renderAction() {
    const action = this.action;
    if (!action) {
      return nothing;
    }
    return html`<openclaw-modal-dialog
      style="--openclaw-modal-width: 800px"
      label=${t(key(action.decision))}
      @modal-cancel=${(event: Event) => {
        if (this.busy) {
          event.preventDefault();
        } else {
          this.action = null;
        }
      }}
    >
      <form
        class="knowledge-management__dialog"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          if (!form.reportValidity()) {
            return;
          }
          const reasonValue = new FormData(form).get("reason");
          const reason = typeof reasonValue === "string" ? reasonValue.trim() : "";
          if (!reason) {
            return;
          }
          void this.mutate(action.decision === "apply" ? "apply" : "decide", {
            proposalId: action.proposal.id,
            expectedRevision: action.proposal.revision,
            ...(action.decision === "apply"
              ? {
                  survivorClaimId: action.survivorClaimId,
                  proposedText: `# ${action.title.trim()}\n\n${action.body.trim()}`,
                  reason,
                }
              : { decision: action.decision, reason }),
          });
        }}
      >
        <h2>${t(key(action.decision))}</h2>
        <p>${t(key(action.decision === "apply" ? "applyHint" : "reviewHint"))}</p>
        ${renderKnowledgeComparison(action.proposal, action.proposal.sourceClaims)}
        ${action.decision === "apply"
          ? html` <label class="field"
                >${t(key("survivor"))}
                <select
                  name="survivor"
                  ?disabled=${this.busy}
                  @change=${(event: Event) =>
                    this.openApply(
                      action.proposal,
                      (event.currentTarget as HTMLSelectElement).value,
                    )}
                >
                  ${action.proposal.sourceClaims.map(
                    (claim) =>
                      html`<option
                        value=${claim.id}
                        ?selected=${claim.id === action.survivorClaimId}
                      >
                        ${claim.title} · r${claim.revision}
                      </option>`,
                  )}
                </select>
              </label>
              <p>
                ${t(key("retireOriginals"))}:
                ${action.proposal.sourceClaims
                  .filter((claim) => claim.id !== action.survivorClaimId)
                  .map((claim) => claim.title)
                  .join(" / ")}
              </p>
              <label class="field"
                >${t(key("resultTitle"))}
                <input
                  name="title"
                  required
                  maxlength="160"
                  .value=${action.title}
                  ?disabled=${this.busy}
                  @input=${(event: Event) => {
                    action.title = (event.currentTarget as HTMLInputElement).value;
                  }}
                />
              </label>
              <label class="field"
                >${t(key("resultBody"))}
                <textarea
                  name="body"
                  required
                  maxlength="8000"
                  .value=${action.body}
                  ?disabled=${this.busy}
                  @input=${(event: Event) => {
                    action.body = (event.currentTarget as HTMLTextAreaElement).value;
                  }}
                ></textarea>
              </label>`
          : nothing}
        <label class="field"
          >${t(key(action.decision === "apply" ? "applyReason" : "reason"))}
          <textarea name="reason" required maxlength="2000" ?disabled=${this.busy}></textarea>
        </label>
        <button
          class="btn"
          type="button"
          ?disabled=${this.busy}
          @click=${() => {
            this.action = null;
          }}
        >
          ${t("common.cancel")}
        </button>
        <button class="btn btn--primary" type="submit" ?disabled=${this.busy}>
          ${t(key(action.decision))}
        </button>
      </form>
    </openclaw-modal-dialog>`;
  }

  override render() {
    if (!this.methodAdvertised || !this.connected) {
      return html`<p role="status">${t(key("unavailable"))}</p>`;
    }
    const selected = this.response?.selected;
    const report = selected?.lastSuccess;
    const job = selected?.currentJob;
    return html`<section class="knowledge-management" data-knowledge-management>
      <h2>${t(key("title"))}</h2>
      <p>${t(key("description"))}</p>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.outcomeMessage ? html`<p role="status">${this.outcomeMessage}</p>` : nothing}
      ${this.busy ? html`<p role="status">${t(key("loading"))}</p>` : nothing}
      ${this.pollingStopped ? html`<p role="status">${t(key("pollingStopped"))}</p>` : nothing}
      ${this.response?.scopes.length
        ? html`<label class="field"
            >${t(key("scope"))}
            <select
              aria-label=${t(key("scope"))}
              ?disabled=${this.busy}
              @change=${(event: Event) => {
                this.action = null;
                void this.load((event.currentTarget as HTMLSelectElement).value);
              }}
            >
              ${this.response.scopes.map(
                (scope) => html`<option
                  value=${scope.id}
                  ?selected=${scope.id === selected?.scope.id}
                >
                  ${scope.name} · ${t(key(scope.kind))}
                </option>`,
              )}
            </select></label
          >`
        : !this.busy && this.response
          ? html`<p role="status">${t(key("noScopes"))}</p>`
          : nothing}
      <div class="knowledge-management__actions">
        ${selected?.scope.capabilities.canGenerateReport && this.generateAdvertised
          ? html` <button
                class="btn btn--primary"
                ?disabled=${this.busy}
                @click=${() => void this.mutate("generate", { force: false })}
              >
                ${t(key("generate"))}
              </button>
              ${report && !["queued", "running"].includes(job?.status ?? "")
                ? html`<button
                    class="btn"
                    ?disabled=${this.busy}
                    @click=${() => void this.mutate("generate", { force: true })}
                  >
                    ${t(key("regenerate"))}
                  </button>`
                : nothing}`
          : nothing}
        <button
          class="btn btn--subtle btn--sm"
          ?disabled=${this.busy}
          @click=${() => void this.load(selected?.scope.id)}
        >
          ${t(key("refresh"))}
        </button>
      </div>
      ${selected &&
      !selected.scope.capabilities.canGenerateReport &&
      !selected.scope.capabilities.canReviewProposals &&
      !selected.scope.capabilities.canApplyProposals
        ? html`<p role="status">${t(key("readOnly"))} · ${t(key("readOnlyHint"))}</p>`
        : nothing}
      ${selected
        ? html`
            ${job
              ? html`<p role="status" data-knowledge-job=${job.id}>
                  ${t(key(`job.${job.status}`))}
                  ${job.completedAt !== undefined ? this.time(job.completedAt) : nothing}
                  ${job.failure
                    ? html`<span>${redactToolDetail(job.failure.message)}</span>`
                    : nothing}
                </p>`
              : nothing}
            ${report
              ? html`<section class="card" data-knowledge-report=${report.id}>
                  <h3>${t(key("lastSuccess"))}</h3>
                  ${this.time(report.completedAt)}
                  <details>
                    <summary>${t(key("technicalDetails"))}</summary>
                    <p>${report.id} · ${report.jobId}</p>
                  </details>
                  <p>${t(key(report.inputStatus === "stale" ? "stale" : "current"))}</p>
                  <p>
                    ${t(key("bounds"), {
                      included: String(report.bounds.includedClaims),
                      total: String(report.bounds.totalEligibleClaims),
                      maxClaims: String(report.bounds.maxClaims),
                      maxTextChars: String(report.bounds.maxTextChars),
                    })}
                  </p>
                  ${report.bounds.truncated ? html`<p>${t(key("truncated"))}</p>` : nothing}
                  <p>
                    ${t(key("coverage"), {
                      compared: String(report.coverage.comparedPairs),
                      candidates: String(report.coverage.candidatePairs),
                    })}
                  </p>
                  ${report.coverage.hasUncomparedPairs
                    ? html`<p>${t(key("incomplete"))}</p>`
                    : nothing}
                  <details>
                    <summary>${t(key("analysisDetails"))} (${report.comparisons.length})</summary>
                    ${report.comparisons.map(
                      (comparison) => html`<article>
                        <h4>${t(key(`kind.${comparison.kind}`))}</h4>
                        <p>${comparison.summary}</p>
                        <p>
                          ${comparison.claimRevisions
                            .map((claim) => {
                              const source = selected.proposals
                                .flatMap((proposal) => proposal.sourceClaims)
                                .find((candidate) => candidate.id === claim.id);
                              return `${source?.title ?? t(key("sourceKnowledge"))} · r${claim.revision}`;
                            })
                            .join(" / ")}
                        </p>
                      </article>`,
                    )}
                  </details>
                </section>`
              : html`<div role="status">
                  <p>${t(key("empty"))}</p>
                  <p>
                    ${t(
                      key(
                        selected.scope.capabilities.canGenerateReport && this.generateAdvertised
                          ? "emptyHint"
                          : "readOnlyEmptyHint",
                      ),
                    )}
                  </p>
                </div>`}
            <h3>${t(key("proposals"))}</h3>
            ${selected.proposals
              .filter((proposal) => ["pending", "deferred", "approved"].includes(proposal.status))
              .map((proposal) => this.renderProposal(proposal))}
            <h3>${t(key("history"))}</h3>
            <label class="field"
              >${t(key("historyFilter"))}
              <select
                aria-label=${t(key("historyFilter"))}
                .value=${this.historyFilter}
                @change=${(event: Event) => {
                  this.historyFilter = (event.currentTarget as HTMLSelectElement).value as
                    | "all"
                    | "rejected";
                  void this.load(selected.scope.id);
                }}
              >
                <option value="all">${t(key("historyAll"))}</option>
                <option value="rejected">${t(key("historyRejected"))}</option>
              </select>
            </label>
            ${selected.history.map(
              (review) => html`<article class="card" data-knowledge-review=${review.id}>
                <p>${t(key(review.decision))} · r${review.revision}</p>
                <p>
                  ${t(key("reviewActor"))}: ${review.actorDisplayName ?? t(key("actorNotRetained"))}
                </p>
                ${review.actorUserId
                  ? html`<details>
                      <summary>${t(key("technicalDetails"))}</summary>
                      <p>${review.actorUserId}</p>
                    </details>`
                  : nothing}
                ${this.time(review.occurredAt)}
                <p>${review.reason}</p>
                <details>
                  <summary>${t(key("reviewComparison"))}</summary>
                  ${review.proposal
                    ? renderKnowledgeComparison(review.proposal, review.proposal.sourceClaims)
                    : html`<p>${t(key("comparisonNotRetained"))}</p>`}
                </details>
                ${review.outcome
                  ? html`<p>${t(key("sourceKnowledge"))} · r${review.outcome.revision}</p>`
                  : nothing}
              </article>`,
            )}
            ${this.historyCursor
              ? html`<button
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  @click=${() => void this.load(selected.scope.id)}
                >
                  ${t(key("historyFirst"))}
                </button>`
              : nothing}
            ${selected.nextHistoryCursor
              ? html`<button
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  @click=${() =>
                    void this.load(selected.scope.id, false, selected.nextHistoryCursor)}
                >
                  ${t(key("historyNext"))}
                </button>`
              : nothing}
            ${selected.history.length === 0
              ? html`<p role="status">${t(key("historyEmpty"))}</p>`
              : nothing}
            ${selected.hasMore || selected.historyHasMore
              ? html`<p role="status">${t(key("boundedHistory"))}</p>`
              : nothing}
          `
        : nothing}
      ${this.response?.scopesHasMore
        ? html`<p role="status">${t(key("boundedScopes"))}</p>`
        : nothing}
      ${this.renderAction()}
    </section>`;
  }
}

if (!customElements.get("platformclaw-memory-knowledge-management")) {
  customElements.define(
    "platformclaw-memory-knowledge-management",
    PlatformClawMemoryKnowledgeManagement,
  );
}
