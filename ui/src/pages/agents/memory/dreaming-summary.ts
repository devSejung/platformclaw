import { html, nothing, type TemplateResult } from "lit";
import {
  renderSettingsNavRow,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../../components/settings-ui.ts";
import { formatDateTimeMs } from "../../../lib/format.ts";
import type { DreamingEntry } from "./dreaming.ts";

type DreamingSummaryTextKey =
  | "enabled"
  | "disabled"
  | "statusUnavailable"
  | "loading"
  | "nextCycle"
  | "phaseLight"
  | "phaseDeep"
  | "phaseRem"
  | "phaseOff"
  | "pending"
  | "promotedToday"
  | "promotedTotal"
  | "lastPromotion"
  | "diaryUpdated"
  | "recentPromotions"
  | "noPromotions"
  | "openActivity"
  | "openDiary"
  | "unavailable";

type DreamingSummaryPhase = {
  enabled: boolean;
  nextRunAtMs?: number;
};

type DreamingSummaryProps = {
  enabled: boolean;
  loading: boolean;
  hasStatus: boolean;
  statusError: string | null;
  nextCycle: string | null;
  timezone: string | null;
  shortTermCount: number;
  promotedToday: number;
  promotedTotal: number;
  lastPromotedAt?: string;
  promotedEntries: DreamingEntry[];
  phases?: {
    light: DreamingSummaryPhase;
    deep: DreamingSummaryPhase;
    rem: DreamingSummaryPhase;
  };
  diaryUpdatedAtMs: number | null;
  mascot?: TemplateResult | typeof nothing;
  text: (key: DreamingSummaryTextKey) => string;
  onOpenActivity: () => void;
  onOpenDiary: () => void;
};

function timestampFromIso(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTimestamp(value: number | null | undefined, props: DreamingSummaryProps): string {
  return formatDateTimeMs(
    value,
    props.timezone ? { timeZone: props.timezone } : undefined,
    props.text("unavailable"),
  );
}

function renderPhaseValue(
  phase: DreamingSummaryPhase | undefined,
  props: DreamingSummaryProps,
): TemplateResult {
  if (!props.enabled) {
    return renderSettingsValue(props.text("phaseOff"));
  }
  if (!props.hasStatus || props.statusError || !phase) {
    return renderSettingsValue(props.text("unavailable"));
  }
  if (!phase.enabled) {
    return renderSettingsValue(props.text("phaseOff"));
  }
  return renderSettingsValue(formatTimestamp(phase.nextRunAtMs, props));
}

export function renderDreamingSummary(props: DreamingSummaryProps): TemplateResult {
  const unavailable = props.text("unavailable");
  const known = props.hasStatus && !props.statusError;
  const lastPromotedAtMs = timestampFromIso(props.lastPromotedAt);
  const statusLabel = props.statusError
    ? props.text("statusUnavailable")
    : props.enabled
      ? props.text("enabled")
      : props.text("disabled");

  const count = (value: number) => (known ? String(value) : unavailable);
  // Enablement is configuration, not a running heartbeat. Failed/unavailable
  // status reads must not turn missing counts into a successful zero result.
  return html`<div class="dreams-summary" aria-busy=${String(props.loading)}>
    <div class="dreams-summary__status" role="status">
      ${renderSettingsStatus({
        kind: props.statusError ? "danger" : props.enabled ? "accent" : "muted",
        label: statusLabel,
      })}
      <span class="muted"
        >${props.statusError ??
        (props.loading
          ? props.text("loading")
          : !props.hasStatus
            ? props.text("statusUnavailable")
            : nothing)}</span
      >
      ${props.mascot ?? nothing}
    </div>
    <div class="dreams-summary__columns">
      ${renderSettingsSection(
        {
          title: props.text("nextCycle"),
          actions: props.timezone
            ? html`<span class="settings-row__desc">${props.timezone}</span>`
            : undefined,
        },
        html`
          ${renderSettingsRow({
            title: props.text("nextCycle"),
            control: renderSettingsValue(
              !props.enabled
                ? props.text("phaseOff")
                : known
                  ? (props.nextCycle ?? unavailable)
                  : unavailable,
            ),
          })}
          ${renderSettingsRow({
            title: props.text("phaseLight"),
            control: renderPhaseValue(props.phases?.light, props),
          })}
          ${renderSettingsRow({
            title: props.text("phaseDeep"),
            control: renderPhaseValue(props.phases?.deep, props),
          })}
          ${renderSettingsRow({
            title: props.text("phaseRem"),
            control: renderPhaseValue(props.phases?.rem, props),
          })}
        `,
      )}
      ${renderSettingsSection(
        { title: props.text("promotedToday") },
        html`
          ${renderSettingsRow({
            title: props.text("promotedToday"),
            control: renderSettingsValue(count(props.promotedToday)),
          })}
          ${renderSettingsRow({
            title: props.text("pending"),
            control: renderSettingsValue(count(props.shortTermCount)),
          })}
          ${renderSettingsRow({
            title: props.text("promotedTotal"),
            control: renderSettingsValue(count(props.promotedTotal)),
          })}
          ${renderSettingsRow({
            title: props.text("lastPromotion"),
            control: renderSettingsValue(
              known ? formatTimestamp(lastPromotedAtMs, props) : unavailable,
            ),
          })}
        `,
      )}
    </div>
    ${renderSettingsSection(
      { title: props.text("recentPromotions") },
      html`
        ${renderSettingsNavRow({
          title: props.text("openActivity"),
          onClick: props.onOpenActivity,
        })}
        ${known
          ? props.promotedEntries
              .toSorted(
                (left, right) =>
                  (timestampFromIso(right.promotedAt) ?? 0) -
                  (timestampFromIso(left.promotedAt) ?? 0),
              )
              .slice(0, 3)
              .map((entry) =>
                renderSettingsRow({
                  title: entry.snippet,
                  description: entry.path,
                  control: renderSettingsValue(
                    formatTimestamp(timestampFromIso(entry.promotedAt), props),
                  ),
                }),
              )
          : nothing}
        ${known && props.promotedEntries.length === 0
          ? renderSettingsRow({ title: props.text("noPromotions") })
          : nothing}
      `,
    )}
    ${renderSettingsSection(
      {},
      renderSettingsNavRow({
        title: props.text("openDiary"),
        description: `${props.text("diaryUpdated")}: ${formatTimestamp(props.diaryUpdatedAtMs, props)}`,
        onClick: props.onOpenDiary,
      }),
    )}
  </div>`;
}
