import { html, nothing } from "lit";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import type { BrowseState, Translate } from "./memory-memories-view.ts";

type MemoryBrowseOptions = {
  gatewayReady: boolean;
  personalDetailAdvertised: boolean | null;
  browseListAdvertised: boolean | null;
  browseRefresh: "idle" | "loading" | "done";
  searchAvailable: boolean;
  renderFile: (
    path: string,
    name: string,
    index: number,
    description?: string,
    content?: string,
    updatedAtMs?: number,
  ) => unknown;
  text: Translate;
  onRefresh: () => void;
  onFocusSearch: () => void;
};

export function renderMemoryBrowse(
  state: BrowseState,
  options: MemoryBrowseOptions & { enabled: boolean; connected: boolean; connectionLabel: string },
) {
  if (!options.enabled) {
    return nothing;
  }
  if (
    options.connected &&
    options.personalDetailAdvertised === false &&
    options.browseListAdvertised === false
  ) {
    return renderSettingsSection(
      { title: options.text("memoryPage.memories.longTermTitle") },
      renderSettingsEmpty(options.text("memoryPage.memories.browseUpdateRequired")),
    );
  }
  if (state.kind === "ready") {
    return renderMemoryBrowseReady(state, options);
  }
  return renderSettingsSection(
    { title: options.text("memoryPage.memories.longTermTitle") },
    html`<div class="settings-empty" role="status">
      ${options.gatewayReady
        ? options.text(
            options.personalDetailAdvertised === null || options.browseListAdvertised === null
              ? "memoryPage.memories.capabilitiesLoading"
              : "memoryPage.memories.browseLoading",
          )
        : options.connectionLabel}
    </div>`,
  );
}

function renderMemoryBrowseReady(
  ready: Extract<BrowseState, { kind: "ready" }>,
  options: MemoryBrowseOptions,
) {
  const memoryRow =
    ready.memoryError && !ready.memory
      ? nothing
      : !ready.memory || ready.memory.missing
        ? renderSettingsEmpty(options.text("memoryPage.memories.longTermEmpty"))
        : options.renderFile(
            "MEMORY.md",
            "MEMORY.md",
            -1,
            options.text("memoryPage.memories.previewHint"),
            ready.memory.content,
            ready.memory.updatedAtMs,
          );
  const longTerm =
    options.gatewayReady && options.personalDetailAdvertised === null
      ? renderSettingsEmpty(options.text("memoryPage.memories.capabilitiesLoading"))
      : options.gatewayReady && options.personalDetailAdvertised === false
        ? renderSettingsEmpty(options.text("memoryPage.memories.previewUnavailable"))
        : html`${ready.memoryError
            ? html`<div class="settings-empty" role="alert">
                ${options.text("memoryPage.memories.browseErrorWithMessage", {
                  message: ready.memoryError,
                })}
              </div>`
            : nothing}${memoryRow}`;
  const recentRows =
    options.gatewayReady && options.browseListAdvertised === null
      ? renderSettingsEmpty(options.text("memoryPage.memories.capabilitiesLoading"))
      : options.gatewayReady && options.browseListAdvertised === false
        ? renderSettingsEmpty(options.text("memoryPage.memories.recentUnavailable"))
        : ready.recentError && ready.recent.length === 0
          ? nothing
          : ready.recent.length === 0
            ? ready.additionalEntries
              ? nothing
              : renderSettingsEmpty(options.text("memoryPage.memories.recentEmpty"))
            : ready.recent.map((entry, index) =>
                options.renderFile(
                  entry.path,
                  entry.name,
                  -index - 2,
                  undefined,
                  undefined,
                  entry.updatedAtMs,
                ),
              );
  const refreshBusy = options.browseRefresh === "loading";
  return html`
    ${renderSettingsSection(
      {
        title: options.text("memoryPage.memories.longTermTitle"),
        description: options.text("memoryPage.memories.longTermDescription"),
        actions: html`<button
          class="btn btn--sm"
          ?disabled=${refreshBusy || !options.gatewayReady}
          @click=${options.onRefresh}
        >
          ${options.text(
            refreshBusy ? "memoryPage.memories.refreshing" : "memoryPage.memories.refresh",
          )}
        </button>`,
      },
      html`${longTerm}${options.browseRefresh === "done"
        ? html`<p role="status">${options.text("memoryPage.memories.refreshed")}</p>`
        : nothing}`,
    )}
    ${renderSettingsSection(
      {
        title: options.text("memoryPage.memories.recentTitle"),
        description: options.text("memoryPage.memories.recentDescription"),
      },
      html`${ready.recentError
        ? html`<div class="settings-empty" role="alert">
            ${options.text("memoryPage.memories.recentPartialError", {
              message: ready.recentError,
            })}
          </div>`
        : nothing}${recentRows}${ready.additionalEntries
        ? renderSettingsRow({
            title: options.text("memoryPage.memories.recentMoreTitle"),
            description: options.text("memoryPage.memories.recentTruncated"),
            ...(options.searchAvailable
              ? {
                  control: html`<button class="btn btn--sm" @click=${() => options.onFocusSearch()}>
                    ${options.text("memoryPage.memories.searchButton")}
                  </button>`,
                }
              : {}),
          })
        : nothing}`,
    )}
  `;
}
