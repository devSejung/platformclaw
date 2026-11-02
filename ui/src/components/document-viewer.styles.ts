import { css } from "lit";

export const documentViewerStyles = css`
  :host {
    display: block;
    min-width: 0;
    width: 100%;
  }
  .viewer {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    color: var(--text, #222);
  }
  .header {
    min-width: 0;
    padding: 12px;
    border-bottom: 1px solid var(--border, #ccc);
  }
  .document-title {
    display: block;
    overflow: hidden;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--border, #ccc);
  }
  .controls,
  .pagination,
  .option-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pagination {
    justify-content: center;
    min-width: 0;
  }
  .option-controls {
    flex-wrap: wrap;
  }
  .request-changes {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .request-icon,
  .request-icon svg {
    display: block;
    width: 16px;
    height: 16px;
  }
  button,
  input,
  textarea,
  summary {
    box-sizing: border-box;
    color: inherit;
    font: inherit;
    font-size: 12px;
  }
  button {
    min-height: 32px;
    padding: 4px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    cursor: pointer;
  }
  button:hover,
  .preview-options > summary:hover {
    background: var(--bg-hover, #eee);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button[aria-pressed="true"],
  button[aria-expanded="true"] {
    background: var(--bg-hover, #eee);
    color: var(--accent, #159b93);
  }
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible,
  summary:focus-visible,
  .stage:focus-visible {
    outline: 2px solid var(--accent, #159b93);
    outline-offset: 2px;
  }
  .position,
  .zoom-level {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .position {
    min-width: 36px;
    text-align: center;
  }
  .page-unit {
    font-size: 12px;
    color: var(--muted, #777);
  }
  .zoom-level {
    min-width: 34px;
    text-align: center;
  }
  .page-layout {
    display: flex;
    min-width: 0;
  }
  .stage {
    position: relative;
    box-sizing: border-box;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    padding: 16px;
    border-radius: 4px;
    background: #d5d7da;
    overscroll-behavior: contain;
  }
  .current-page {
    display: block;
    margin: 0;
    background: #fff;
    box-shadow: 0 2px 12px #0003;
  }
  .current-page[aria-hidden="true"] {
    visibility: hidden;
  }
  openclaw-document-contents {
    flex: 0 0 132px;
    height: auto;
    min-height: 0;
    /* The page determines inline height; thumbnails scroll within that height. */
    contain: size;
    border-right: 1px solid var(--border, #ccc);
  }
  .page-surface {
    position: relative;
    width: fit-content;
    margin: 0 auto;
  }
  .selection-active {
    cursor: crosshair;
    touch-action: none;
    user-select: none;
  }
  .selection-region {
    position: absolute;
    pointer-events: none;
    box-sizing: border-box;
    border: 2px solid var(--accent, #159b93);
    background: #159b9326;
  }
  .selection-hint {
    padding: 0 8px 6px;
    color: var(--muted, #777);
    font-size: 12px;
  }
  .request-popover {
    position: absolute;
    z-index: 3;
    left: var(--request-popover-left, 12px);
    top: var(--request-popover-top, 12px);
    width: var(--request-popover-width, min(300px, calc(100% - 24px)));
    max-height: var(--request-popover-max-height);
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 12px;
    box-sizing: border-box;
    border: 1px solid var(--border, #ccc);
    border-radius: 8px;
    background: var(--bg, #fff);
    color: var(--text, #222);
    box-shadow: 0 6px 24px #0003;
    font-size: 12px;
  }
  .request-context-trigger {
    position: fixed;
    width: 1px;
    height: 1px;
    min-height: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
  }
  .request-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .request-popover-header strong {
    font-weight: 500;
  }
  .request-popover-header button {
    min-height: 24px;
    padding: 0 5px;
  }
  .request-popover label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .request-instruction {
    display: block;
    width: 100%;
    min-height: 58px;
    padding: 7px 8px;
    resize: vertical;
    border: 1px solid var(--border, #ccc);
    border-radius: 5px;
    background: var(--bg, #fff);
  }
  .request-popover .controls {
    justify-content: flex-end;
  }
  .request-popover button[type="submit"] {
    align-self: flex-end;
    background: var(--accent, #159b93);
    color: var(--accent-foreground, #fff);
  }
  .selected-text {
    margin: 0;
    max-height: 38px;
    overflow: auto;
    color: var(--muted, #777);
    font-size: 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .request-error {
    color: var(--danger, #b42318);
  }
  .request-result {
    padding: 5px 8px;
    font-size: 12px;
  }
  .notice {
    position: absolute;
    z-index: 1;
    inset: 0 auto auto 0;
    padding: 12px;
    background: var(--bg, #fff);
    font-size: 13px;
  }
  .preview-options {
    position: relative;
  }
  .preview-options > summary {
    display: grid;
    place-items: center;
    min-width: 30px;
    min-height: 32px;
    border-radius: 5px;
    list-style: none;
    cursor: pointer;
  }
  .preview-options > summary::-webkit-details-marker {
    display: none;
  }
  .options-panel {
    position: absolute;
    z-index: 4;
    right: 0;
    bottom: calc(100% + 6px);
    width: min(320px, calc(100vw - 72px));
    max-height: 55dvh;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--border, #ccc);
    border-radius: 8px;
    background: var(--bg, #fff);
    box-shadow: 0 6px 24px #0003;
  }
  .text-alternative {
    margin-top: 10px;
    font-size: 12px;
  }
  .text-alternative > summary {
    cursor: pointer;
  }
  .page-text {
    max-height: 140px;
    overflow: auto;
    padding-top: 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .option-note {
    margin: 10px 0 0;
    color: var(--muted, #777);
    font-size: 11px;
  }
  openclaw-modal-dialog {
    --openclaw-modal-width: calc(100vw - 32px);
    --openclaw-modal-max-width: calc(100vw - 32px);
    --openclaw-modal-max-height: calc(100dvh - 32px);
  }
  .expanded {
    width: calc(100vw - 32px);
    height: calc(100dvh - 32px);
    background: var(--bg, #fff);
  }
  .expanded .toolbar {
    padding: 8px;
  }
  .expanded .page-layout {
    flex: 1;
    height: auto;
    min-height: 0;
  }
  .expanded .stage {
    height: auto;
    scrollbar-gutter: stable;
  }
  @media (max-width: 600px) {
    .page-layout {
      flex-direction: column;
    }
    openclaw-document-contents {
      flex: 0 0 120px;
      border-right: 0;
      border-bottom: 1px solid var(--border, #ccc);
    }
    .stage {
      height: auto;
      padding: 12px;
    }
    .toolbar {
      gap: 4px;
    }
    .pagination,
    .controls {
      gap: 2px;
    }
    .toolbar button {
      padding: 4px 5px;
    }
    .request-instruction {
      font-size: 16px;
    }
    openclaw-modal-dialog {
      --openclaw-modal-width: calc(100vw - 16px);
      --openclaw-modal-max-width: calc(100vw - 16px);
      --openclaw-modal-max-height: calc(100dvh - 16px);
    }
    .expanded {
      width: calc(100vw - 16px);
      height: calc(100dvh - 16px);
    }
  }
  @media (max-width: 420px) {
    .toolbar {
      grid-template-columns: 1fr 1fr;
    }
    .pagination {
      grid-row: 1;
      grid-column: 1 / -1;
    }
    .toolbar > .controls {
      grid-column: 1 / -1;
      justify-self: end;
    }
  }
  @media (pointer: coarse) {
    .toolbar button,
    .preview-options > summary,
    .request-popover button {
      min-height: 44px;
    }
  }
`;
