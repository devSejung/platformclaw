import { html } from "lit";
import { platformClawGuideT as guideT, platformClawT as t } from "./i18n.ts";
import type { TourStep } from "./quick-actions-tour.ts";

export function renderPlatformClawTour(options: {
  step: TourStep;
  index: number;
  total: number;
  moving: boolean;
  highlightStyle: string;
  popoverStyle: string;
  shadeStyles: readonly string[];
  onClose: () => void;
  onComplete: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const finalStep = options.index === options.total - 1;
  return html`<div class="tour-layer">
    <div class="tour-dismiss-layer" @click=${options.onClose}></div>
    ${options.shadeStyles.map((style) => html`<div class="tour-shade" style=${style}></div>`)}
    <div class="tour-highlight" style=${options.highlightStyle}>
      <span class="tour-target-label">${guideT("platformClaw.guide.clickTarget")}</span>
    </div>
    <section
      class="tour-popover"
      style=${options.popoverStyle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="platformclaw-tour-title"
    >
      <button
        class="tour-close"
        type="button"
        aria-label=${t("platformClaw.voc.close")}
        @click=${options.onClose}
      >
        ×
      </button>
      <h2 id="platformclaw-tour-title">${options.step.title}</h2>
      <p>${options.step.body}</p>
      ${options.step.details?.length
        ? html`<ul>
            ${options.step.details.map((detail) => html`<li>${detail}</li>`)}
          </ul>`
        : null}
      <div class="tour-progress">
        ${guideT("platformClaw.guide.progress", {
          current: String(options.index + 1),
          total: String(options.total),
        })}
      </div>
      <div class="tour-footer">
        <button class="tour-never" type="button" @click=${options.onComplete}>
          ${guideT("platformClaw.guide.neverShowAgain")}
        </button>
        ${options.index > 0
          ? html`<button
              type="button"
              ?disabled=${options.moving}
              @click=${() => options.onMove(-1)}
            >
              ${guideT("platformClaw.guide.previous")}
            </button>`
          : null}
        <button
          class="tour-next"
          type="button"
          ?disabled=${options.moving}
          @click=${() => options.onMove(1)}
        >
          ${guideT(finalStep ? "platformClaw.guide.done" : "platformClaw.guide.next")}
        </button>
      </div>
    </section>
  </div>`;
}
