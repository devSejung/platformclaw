import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  OrganizationMemoryPromotionRequest,
  OrganizationMemoryPromotionSourceKind,
  OrganizationMemoryReferencesPreview,
  OrganizationMemoryLifecycleSnapshot,
} from "../../../../packages/platformclaw-control-plane/src/contracts.js";
import type { OrganizationPromotionKnowledgeComparison } from "../../../../packages/platformclaw-control-plane/src/organization-memory-knowledge-contracts.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { platformClawT as t } from "../../platformclaw/i18n.ts";
import "../../components/modal-dialog.ts";
import { renderKnowledgeComparison } from "../../platformclaw/memory-knowledge-comparison.ts";
import { isOrganizationMemoryPath } from "../../platformclaw/organization-memory-document-preview.ts";

export async function retirePromotionClaim(
  props: {
    client: GatewayBrowserClient | null;
    onBusy: (busy: boolean) => void;
    onReload: () => Promise<void>;
    onError: (error: unknown) => void;
  },
  claimId: string,
  purge: boolean,
) {
  const reason = window.prompt(
    t(purge ? "memoryPage.promotions.purgeReason" : "memoryPage.promotions.retireReason"),
  );
  if (!reason || !props.client) {
    return;
  }
  props.onBusy(true);
  try {
    await props.client.request(
      purge ? "platformclaw.memory.claim.purge" : "platformclaw.memory.claim.retire",
      { claimId, reason },
    );
    await props.onReload();
  } catch (error) {
    props.onError(error);
    props.onBusy(false);
  }
}
export type PromotionReferencesPreview = {
  proposedText: string;
  references?: OrganizationMemoryReferencesPreview;
};
export type PromotionReferenceConfirmation = {
  proposedText: string;
  references: OrganizationMemoryReferencesPreview;
  original: Record<string, unknown>;
};
type PromotionDecisionProps = {
  pending: {
    request: OrganizationMemoryPromotionRequest;
    decision: "approve" | "reject";
    comparison: OrganizationPromotionKnowledgeComparison | null;
  } | null;
  loading: boolean;
  error: string | null;
  comparisonAdvertised: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  onCompare: () => void;
};
function renderPromotionKnowledgeComparison(
  comparison: OrganizationPromotionKnowledgeComparison | null | undefined,
) {
  if (!comparison) {
    return nothing;
  }
  return html`<section data-promotion-knowledge-comparison>
    <h4>${t("platformClaw.memory.knowledge.promotionComparison")}</h4>
    ${comparison.status === "available" && comparison.analysis
      ? html`
          ${comparison.analysis.comparisons.map(
            (item) =>
              html`<article>
                ${renderKnowledgeComparison(
                  item,
                  (comparison.sourceClaims ?? []).filter((source) =>
                    item.claimIds.includes(source.id),
                  ),
                  true,
                )}
              </article>`,
          )}
          <p>
            ${t("platformClaw.memory.knowledge.coverage", {
              compared: String(comparison.analysis.coverage.comparedPairs),
              candidates: String(comparison.analysis.coverage.candidatePairs),
            })}
          </p>
          ${comparison.analysis.coverage.hasUncomparedPairs
            ? html`<p>${t("platformClaw.memory.knowledge.incomplete")}</p>`
            : nothing}
        `
      : html`<p role="status">
          ${t(
            comparison.status === "stale"
              ? "platformClaw.memory.knowledge.promotionComparisonStale"
              : "platformClaw.memory.knowledge.promotionComparisonUnavailable",
          )}
        </p>`}
  </section>`;
}

function renderPromotionReferences(
  request: Pick<OrganizationMemoryPromotionRequest, "references">,
) {
  const references = request.references;
  if (!references) {
    return nothing;
  }
  return html`<section data-promotion-references>
    <h4>${t("memoryPage.promotions.referencesTitle")}</h4>
    <p>${t("memoryPage.promotions.referencesHint")}</p>
    ${references.resolved.map(
      (reference) =>
        html`<p>
          <button
            class="btn btn--subtle btn--sm"
            type="button"
            @click=${(event: Event) =>
              (event.currentTarget as HTMLElement).dispatchEvent(
                new CustomEvent("organization-reference-open", {
                  bubbles: true,
                  detail: reference.path,
                }),
              )}
          >
            ${reference.title} ·
            ${t("platformClaw.memory.graph.revision", { revision: String(reference.revision) })}
          </button>
        </p>`,
    )}
    <p>
      ${t("memoryPage.promotions.referencesCounts", {
        unresolved: String(references.unresolvedCount),
        blocked: String(references.blockedCount),
        ambiguous: String(references.ambiguousCount),
      })}
    </p>
  </section>`;
}

export function renderPromotionReferencesConfirmation(props: {
  preview: { proposedText: string; references: OrganizationMemoryReferencesPreview };
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return html`<openclaw-modal-dialog
    style="--openclaw-modal-width: 800px"
    label=${t("memoryPage.promotions.referencesConfirmTitle")}
    @modal-cancel=${(event: Event) => {
      if (props.loading) {
        event.preventDefault();
      } else {
        props.onCancel();
      }
    }}
  >
    <div class="exec-approval-card memory-promotions__decision-dialog">
      <h3>${t("memoryPage.promotions.referencesConfirmTitle")}</h3>
      <div
        class="memory-promotions__decision-body"
        tabindex="0"
        role="region"
        aria-label=${t("memoryPage.promotions.referencesConfirmTitle")}
      >
        <article
          class="sidebar-markdown"
          @click=${(event: MouseEvent) => {
            const anchor = (event.target as Element).closest<HTMLAnchorElement>(
              "a[href], [data-wiki-lookup]",
            );
            const path = anchor?.dataset.wikiLookup ?? anchor?.getAttribute("href") ?? "";
            if (isOrganizationMemoryPath(path)) {
              event.preventDefault();
              (event.currentTarget as HTMLElement).dispatchEvent(
                new CustomEvent("organization-reference-open", { bubbles: true, detail: path }),
              );
            }
          }}
        >
          ${unsafeHTML(
            toSanitizedMarkdownHtml(props.preview.proposedText, {
              codeBlockChrome: "none",
              fileLinks: false,
              interactiveImages: false,
              wikiLinks: true,
            }),
          )}
        </article>
        ${renderPromotionReferences(props.preview)}
        ${props.error ? html`<p role="alert">${props.error}</p>` : nothing}
      </div>
      <div class="exec-approval-actions">
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.loading}
          @click=${props.onConfirm}
        >
          ${t("memoryPage.promotions.referencesConfirm")}
        </button>
        <button type="button" class="btn" ?disabled=${props.loading} @click=${props.onCancel}>
          ${t("common.cancel")}
        </button>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}

export function renderPromotionDecisionDialog(props: PromotionDecisionProps) {
  const pending = props.pending;
  if (!pending) {
    return nothing;
  }
  const label = t(
    pending.decision === "approve"
      ? "memoryPage.promotions.approve"
      : "memoryPage.promotions.reject",
  );
  return html`<openclaw-modal-dialog
    style="--openclaw-modal-width: 800px"
    label=${label}
    description=${pending.request.targetScopeName}
    @modal-cancel=${(event: Event) => {
      if (props.loading) {
        event.preventDefault();
      } else {
        props.onCancel();
      }
    }}
  >
    <form
      class="exec-approval-card memory-promotions__decision-dialog"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const input = form.elements.namedItem("reason") as HTMLTextAreaElement;
        input.value = input.value.trim();
        if (!form.reportValidity()) {
          return;
        }
        const value = new FormData(form).get("reason");
        const reason = typeof value === "string" ? value.trim() : "";
        if (reason) {
          props.onSubmit(reason);
        }
      }}
    >
      <div class="exec-approval-header">
        <div>
          <div class="exec-approval-title">${label}</div>
          <div class="exec-approval-sub">${pending.request.targetScopeName}</div>
        </div>
      </div>
      <div
        class="memory-promotions__decision-body"
        tabindex="0"
        role="region"
        aria-label=${t("platformClaw.memory.knowledge.promotionComparison")}
      >
        <label class="field">
          <span>${t("memoryPage.promotions.decisionReason")}</span>
          <textarea name="reason" maxlength="500" required ?disabled=${props.loading}></textarea>
        </label>
        ${renderPromotionKnowledgeComparison(pending.comparison)}
        ${renderPromotionReferences(pending.request)}
        ${pending.decision === "approve" && props.comparisonAdvertised
          ? html`<button
              class="btn"
              type="button"
              ?disabled=${props.loading}
              @click=${() => props.onCompare()}
            >
              ${t("platformClaw.memory.knowledge.comparePromotion")}
            </button>`
          : nothing}
        ${props.error ? html`<p role="alert">${props.error}</p>` : nothing}
      </div>
      <div class="exec-approval-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${props.loading ||
          (pending.decision === "approve" && pending.comparison?.status === "stale")}
        >
          ${label}
        </button>
        <button
          class="btn"
          type="button"
          ?disabled=${props.loading}
          @click=${() => {
            props.onCancel();
          }}
        >
          ${t("common.cancel")}
        </button>
      </div>
    </form>
  </openclaw-modal-dialog>`;
}

type PromotionRequestProps = {
  review: boolean;
  loading: boolean;
  comparisonAdvertised: boolean;
  onDecide: (request: OrganizationMemoryPromotionRequest, decision: "approve" | "reject") => void;
  onCompare: (request: OrganizationMemoryPromotionRequest) => void;
};
export function promotionStatusLabel(
  status: "pending" | "approved" | "rejected" | "active" | "retired" | "purged",
): string {
  const key = {
    pending: "memoryPage.promotions.statusPending",
    approved: "memoryPage.promotions.statusApproved",
    rejected: "memoryPage.promotions.statusRejected",
    active: "memoryPage.promotions.statusActive",
    retired: "memoryPage.promotions.statusRetired",
    purged: "memoryPage.promotions.statusPurged",
  }[status];
  return t(key);
}

function promotionSourceLabel(kind: OrganizationMemoryPromotionSourceKind) {
  return kind === "personal"
    ? t("memoryPage.promotions.personal")
    : kind === "part"
      ? t("memoryPage.promotions.part")
      : kind === "group"
        ? t("memoryPage.promotions.group")
        : t("memoryPage.promotions.team");
}

export function renderPromotionRequest(
  request: OrganizationMemoryPromotionRequest,
  props: PromotionRequestProps,
) {
  return html`<div class="settings-row">
    <span class="settings-row__text">
      <article class="settings-row__title sidebar-markdown memory-promotions__document">
        ${unsafeHTML(
          toSanitizedMarkdownHtml(request.proposedText, {
            codeBlockChrome: "none",
            fileLinks: false,
            interactiveImages: false,
          }),
        )}
      </article>
      <span class="settings-row__desc"
        >${promotionSourceLabel(request.sourceKind)}${request.sourceClaimId
          ? ` · ${request.sourceClaimId}`
          : ""}
        · ${t("memoryPage.promotions.revision", { revision: String(request.sourceRevision) })} →
        ${request.targetScopeName} · ${promotionStatusLabel(request.status)}</span
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
      ${renderPromotionKnowledgeComparison(request.relatedKnowledgeComparison)}
      ${renderPromotionReferences(request)}
    </span>
    ${props.review && request.canReview
      ? html`<span class="settings-row__control">
          ${props.comparisonAdvertised
            ? html`<button
                class="btn btn--sm"
                ?disabled=${props.loading}
                @click=${() => {
                  props.onCompare(request);
                }}
              >
                ${t("platformClaw.memory.knowledge.comparePromotion")}
              </button>`
            : nothing}
          <button
            class="btn btn--sm primary"
            ?disabled=${props.loading}
            @click=${() => props.onDecide(request, "approve")}
          >
            ${t("memoryPage.promotions.approve")}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${props.loading}
            @click=${() => props.onDecide(request, "reject")}
          >
            ${t("memoryPage.promotions.reject")}
          </button>
        </span>`
      : nothing}
  </div>`;
}

export function promotionSourceClaims(
  snapshot: OrganizationMemoryLifecycleSnapshot | null,
  sourceKind: OrganizationMemoryPromotionSourceKind,
) {
  return (snapshot?.claims ?? []).filter(
    (claim) =>
      claim.status === "active" &&
      claim.scopeKind === sourceKind &&
      (claim.promotionTargets?.length ?? 0) > 0,
  );
}

export function promotionTargetScopes(
  snapshot: OrganizationMemoryLifecycleSnapshot | null,
  sourceKind: OrganizationMemoryPromotionSourceKind,
  sourceClaimId: string,
) {
  if (sourceKind === "personal") {
    return snapshot?.personalTargets ?? [];
  }
  return (
    promotionSourceClaims(snapshot, sourceKind).find((claim) => claim.id === sourceClaimId)
      ?.promotionTargets ?? []
  );
}
