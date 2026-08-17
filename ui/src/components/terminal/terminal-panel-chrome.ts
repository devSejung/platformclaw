import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { DockPanelSide } from "../dock-panel-layout.ts";
import type { TerminalPanelSessionTab } from "./terminal-panel-session-types.ts";
import { renderTerminalPanelTabs } from "./terminal-panel-tabs.ts";
import {
  renderTerminalPanelActions,
  renderTerminalUploadLayer,
  type TerminalPanelUploadController,
} from "./terminal-panel-upload.ts";

type TerminalDock = Exclude<DockPanelSide, "left">;

export function renderTerminalPanelToolbar(
  fullscreen: boolean,
  dock: TerminalDock,
  uploadController: TerminalPanelUploadController,
  sessionPicker: unknown,
  uploadsEnabled: boolean,
  setDock: (dock: TerminalDock) => void,
  hidePanel: () => void,
): TemplateResult {
  return renderTerminalPanelActions({
    fullscreen,
    dock,
    upload: uploadController,
    sessionPicker,
    uploadsEnabled,
    onDock: setDock,
    onHide: hidePanel,
  });
}

export function renderTerminalPanelHeader(
  tabs: TerminalPanelSessionTab[],
  activeId: string | null,
  booting: boolean,
  toolbar: TemplateResult,
  selectTab: (id: string) => void,
  closeTab: (id: string) => void,
  openSession: () => void,
  showNew: boolean,
): TemplateResult {
  return html`<header class="tp-header">
    ${renderTerminalPanelTabs({
      tabs,
      activeId,
      booting,
      onSelect: selectTab,
      onClose: closeTab,
      onNew: openSession,
      showNew,
    })}
    ${toolbar}
  </header>`;
}

export function renderTerminalPanelViewport(
  activeId: string | null,
  connecting: boolean,
  errorText: string | null,
  uploadController: TerminalPanelUploadController,
  uploadsEnabled: boolean,
): TemplateResult {
  return html`
    ${errorText ? html`<div class="tp-error" role="alert">${errorText}</div>` : nothing}
    <wa-tab-panel
      id="terminal-tab-panel"
      class="tp-viewport"
      name=${activeId ?? "terminal"}
      active
      aria-labelledby=${activeId ? `terminal-tab-${activeId}` : nothing}
      @dragenter=${uploadsEnabled ? uploadController.handleDragEnter : nothing}
      @dragover=${uploadsEnabled ? uploadController.handleDragOver : nothing}
      @dragleave=${uploadsEnabled ? uploadController.handleDragLeave : nothing}
      @drop=${uploadsEnabled ? uploadController.handleDrop : nothing}
    >
      ${connecting
        ? html`<div class="tp-connecting" role="status">
            <span class="tp-connecting__spinner" aria-hidden="true"></span>
            <span>${t("terminal.connecting")}</span>
          </div>`
        : nothing}
      ${uploadsEnabled ? renderTerminalUploadLayer(uploadController) : nothing}
    </wa-tab-panel>
  `;
}
