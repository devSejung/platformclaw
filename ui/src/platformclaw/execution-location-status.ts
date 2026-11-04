import { css, html } from "lit";
import type { ExecutionSettings } from "./execution-settings-view.ts";
import { platformClawT as t } from "./i18n.ts";

export const executionLocationStatusStyles = css`
  .location-launcher-copy {
    display: grid;
    min-width: 0;
    gap: 1px;
  }
  .location-status {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 5px;
    color: var(--muted);
    font-size: 11px;
  }
  .location-status-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .location-launcher-copy > .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .execution-dot {
    width: 6px;
    height: 6px;
    flex: none;
    border-radius: var(--radius-full);
    background: var(--ok);
  }
  .location-status[data-state="loading"] .execution-dot {
    background: var(--muted);
  }
  .location-status[data-state="warning"] .execution-dot,
  .location-status[data-state="unavailable"] .execution-dot {
    background: var(--warn);
  }
`;

export function renderExecutionLocationStatus(
  settings: ExecutionSettings | null | undefined,
  loading: boolean,
) {
  const vmNeedsConnection =
    !loading &&
    settings?.activeTarget === "assigned_vm" &&
    (settings.assignment?.status !== "ready" || settings.credentialStatus !== "current");
  const status = loading
    ? "loading"
    : !settings
      ? "unavailable"
      : vmNeedsConnection
        ? "warning"
        : "ready";
  const target = loading
    ? t("common.loading")
    : !settings
      ? t("platformClaw.execution.locationUnknown")
      : settings.activeTarget === "assigned_vm"
        ? (settings.assignment?.vmLabel ?? t("platformClaw.execution.vm"))
        : t("platformClaw.execution.basic");
  const label = t("platformClaw.execution.selectedLocation", { target });
  const detail = vmNeedsConnection
    ? `${label} · ${t("platformClaw.execution.connectionRequired")}`
    : label;
  return html`<span
    class="location-status"
    id="execution-location-status"
    data-location-status
    data-state=${status}
    role="status"
    aria-label=${detail}
    aria-atomic="true"
    title=${`${detail}. ${t("platformClaw.execution.boundary")}`}
  >
    <span class="execution-dot" aria-hidden="true"></span
    ><span class="location-status-label">${detail}</span>
  </span>`;
}
