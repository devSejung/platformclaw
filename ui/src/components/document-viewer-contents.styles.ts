import { css } from "lit";

export const documentContentsStyles = css`
  :host {
    display: block;
    width: 156px;
    min-width: 0;
    height: 100%;
    color: var(--text, #222);
  }
  nav {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg, #fff);
  }
  .window-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 8px;
    font-size: 11px;
  }
  button {
    color: inherit;
    background: var(--bg, #fff);
    border: 1px solid var(--border, #ccc);
    border-radius: 5px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--accent, #159b93);
    outline-offset: 2px;
  }
  .window-controls button {
    width: 28px;
    min-height: 30px;
  }
  .thumbnail-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 8px 12px;
    min-height: 0;
    overflow: auto;
  }
  .thumbnail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-height: 64px;
    padding: 6px;
    font: inherit;
    font-size: 12px;
  }
  .thumbnail[aria-current="page"] {
    border: 2px solid var(--accent, #159b93);
    background: var(--bg-hover, #eee);
  }
  canvas {
    display: block;
    max-width: 100%;
    max-height: 144px;
    background: #fff;
  }
  canvas[data-thumbnail-state="loading"] {
    visibility: hidden;
    height: 96px;
  }
  .thumbnail-error {
    font-size: 11px;
  }
  @media (max-width: 600px) {
    :host {
      width: 100%;
      height: 156px;
    }
    .window-controls {
      padding: 4px 8px;
    }
    .thumbnail-list {
      flex-direction: row;
      padding: 4px 8px;
    }
    .thumbnail {
      flex: 0 0 84px;
      min-width: 0;
    }
    canvas {
      max-height: 84px;
    }
    canvas[data-thumbnail-state="loading"] {
      height: 68px;
    }
  }
`;
