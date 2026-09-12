import { html, nothing } from "lit";
import { platformClawT as t } from "./i18n.ts";
import "./memory-knowledge-comparison.css";

type KnowledgeComparisonSource = {
  id: string;
  revision: number;
  title: string;
  text: string;
  textTruncated?: boolean;
  evidence?: string[];
  evidenceStatus?: "available" | "unavailable";
  evidenceTruncated?: boolean;
};

export function renderKnowledgeComparison(
  comparison: { kind: string; summary: string; proposedText?: string },
  sources: KnowledgeComparisonSource[],
  compact = false,
) {
  const prefix = "platformClaw.memory.knowledge.";
  return html`<div class="knowledge-comparison" data-knowledge-comparison>
    ${sources.length
      ? html`<div class="knowledge-comparison__sources">
          ${sources.map(
            (source) => html`<section class="knowledge-comparison__source">
              <h4>${source.title} · r${source.revision}</h4>
              <h5>${t(`${prefix}originalClaim`)}</h5>
              ${source.textTruncated ? html`<p>${t(`${prefix}originalTruncated`)}</p>` : nothing}
              <blockquote
                .textContent=${compact && source.text.length > 220
                  ? `${source.text.slice(0, 220)}…`
                  : source.text}
              ></blockquote>
              ${compact && source.text.length > 220
                ? html`<details>
                    <summary>${t(`${prefix}fullOriginal`)}</summary>
                    <blockquote .textContent=${source.text}></blockquote>
                  </details>`
                : nothing}
              <h5>${t(`${prefix}registeredEvidence`)}</h5>
              ${source.evidence === undefined || source.evidenceStatus === "unavailable"
                ? html`<p>${t(`${prefix}evidenceUnavailable`)}</p>`
                : source.evidence.length
                  ? source.evidence.map(
                      (evidence) =>
                        html`<blockquote
                          class="knowledge-comparison__evidence"
                          .textContent=${evidence}
                        ></blockquote>`,
                    )
                  : html`<p class="knowledge-comparison__missing">
                      ${t(`${prefix}evidenceMissing`)}
                    </p>`}
              ${source.evidenceTruncated
                ? html`<p>${t(`${prefix}evidenceTruncated`)}</p>`
                : nothing}
            </section>`,
          )}
        </div>`
      : html`<p>${t(`${prefix}originalsUnavailable`)}</p>`}
    <section class="knowledge-comparison__judgment" data-comparison-kind=${comparison.kind}>
      <h4>
        ${t(`${prefix}aiJudgment`)} ·
        <span class="knowledge-comparison__kind">${t(`${prefix}kind.${comparison.kind}`)}</span>
      </h4>
      <p>${comparison.summary}</p>
      ${comparison.kind === "condition-difference"
        ? html`<p>${t(`${prefix}conditionDifferenceHint`)}</p>`
        : comparison.kind === "insufficient-evidence"
          ? html`<p>${t(`${prefix}insufficientEvidenceHint`)}</p>`
          : nothing}
    </section>
    ${comparison.proposedText
      ? html`<section>
          <h4>${t(`${prefix}suggestedContent`)}</h4>
          <blockquote>${comparison.proposedText}</blockquote>
        </section>`
      : nothing}
  </div>`;
}
