import { css } from "lit";

export const quickActionsTourStyles = css`
  .tour-layer {
    position: fixed;
    z-index: 10000;
    inset: 0;
    pointer-events: none;
  }
  .tour-dismiss-layer {
    position: absolute;
    inset: 0;
    pointer-events: auto;
  }
  .tour-shade {
    position: fixed;
    background: rgb(5 7 10 / 48%);
    pointer-events: none;
  }
  .tour-highlight {
    position: fixed;
    box-sizing: border-box;
    border: 3px solid var(--accent);
    border-radius: 12px;
    box-shadow: 0 0 0 3px var(--accent);
    pointer-events: none;
    transition: all 180ms ease;
  }
  .tour-target-label {
    position: absolute;
    right: 6px;
    bottom: calc(100% + 7px);
    border-radius: 999px;
    padding: 5px 9px;
    background: var(--accent);
    color: var(--accent-foreground);
    box-shadow: var(--shadow-md);
    font: 700 11px/1.2 var(--font-sans, system-ui, sans-serif);
    white-space: nowrap;
  }
  .tour-popover {
    position: fixed;
    box-sizing: border-box;
    width: min(360px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    padding: 18px;
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-xl);
    pointer-events: auto;
  }
  .tour-close {
    position: absolute;
    top: 8px;
    right: 8px;
    border: 0;
    padding: 4px 8px;
    background: transparent;
    color: var(--muted-strong);
    font-size: 22px;
    cursor: pointer;
  }
  .tour-popover h2 {
    margin: 0 28px 8px 0;
    font-size: 17px;
  }
  .tour-popover p {
    margin: 0;
    color: var(--muted-strong);
    font-size: 14px;
    line-height: 1.55;
  }
  .tour-popover ul {
    display: grid;
    gap: 7px;
    margin: 12px 0 0;
    padding-left: 19px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
  }
  .tour-progress {
    padding-top: 14px;
    font-size: 12px;
    color: var(--muted);
  }
  .tour-footer {
    position: sticky;
    z-index: 1;
    bottom: -18px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0 -18px -18px;
    padding: 14px 18px 18px;
    background: var(--bg-elevated);
  }
  .tour-footer button {
    min-height: 32px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    padding: 6px 11px;
    background: var(--bg);
    color: var(--text);
    font: 600 12px/1.4 var(--font-sans, system-ui, sans-serif);
    cursor: pointer;
  }
  .tour-footer .tour-never {
    margin-right: auto;
    border: 0;
    padding-inline: 0;
    background: transparent;
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .tour-footer .tour-next {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-foreground);
  }
  @media (prefers-reduced-motion: reduce) {
    .tour-highlight {
      transition: none;
    }
  }
`;
