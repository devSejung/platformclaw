import { css } from "lit";

export const vmAdministrationStyles = css`
  [hidden] {
    display: none !important;
  }
  .empty > svg {
    width: 30px;
    height: 30px;
  }
  .progress[data-outcome="success"] .flow {
    color: var(--ok);
  }
  .progress[data-outcome="error"] .flow {
    color: var(--danger);
  }
  :host {
    display: block;
    min-width: 0;
    color: var(--text);
    font: 13px/1.45 var(--font-sans, system-ui, sans-serif);
  }
  * {
    box-sizing: border-box;
  }
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
    padding: 4px 20px 28px;
    max-width: 1120px;
    margin: 0 auto;
  }
  h2,
  h3,
  p {
    margin: 0;
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 8px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    color: var(--text);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--border-hover);
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-foreground);
  }
  .primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  button svg {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 12px;
  }
  .overview {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  .metric {
    display: grid;
    gap: 4px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
  }
  .metric strong {
    font-size: 25px;
    line-height: 1.2;
    font-weight: 650;
  }
  .metric span {
    color: var(--muted);
    font-size: 12px;
  }
  .toolbar,
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .tabs {
    max-width: 100%;
    min-width: 0;
    --indicator-color: transparent;
    --track-color: var(--border);
    --track-width: 1px;
  }
  .tabs::part(body) {
    display: none;
  }
  .tabs::part(tabs) {
    gap: 5px;
    padding-bottom: 9px;
  }
  .tabs wa-tab {
    font: inherit;
    color: var(--muted);
  }
  .tabs wa-tab::part(base) {
    gap: 7px;
    padding: 7px 9px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    font: inherit;
    color: inherit;
  }
  .tabs wa-tab[active]::part(base) {
    background: var(--accent-subtle);
    color: var(--accent);
    border-color: var(--border);
  }
  .tabs wa-tab:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
    border-radius: var(--radius-md);
  }
  .tabs wa-tab:focus-visible::part(base) {
    outline: none;
  }
  .hub-tab__badge {
    font-size: 11px;
    border-radius: var(--radius-full);
    padding: 1px 5px;
    background: var(--bg-muted);
    color: var(--muted);
  }
  .section {
    display: grid;
    gap: 13px;
  }
  .section-heading h2 {
    font-size: 16px;
  }
  .section-heading p {
    margin-top: 3px;
  }
  .catalog {
    display: grid;
    gap: 10px;
  }
  .server-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 15px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    min-width: 0;
  }
  .server-glyph {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 44px;
    color: var(--muted);
    background: var(--bg-muted);
    border-radius: var(--radius-md);
  }
  .server-glyph > svg {
    width: 29px;
    height: 29px;
  }
  .server-info {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 5px;
  }
  .server-info h3 {
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .address {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    font-size: 11px;
    border-radius: var(--radius-full);
    background: var(--bg-muted);
    color: var(--muted);
  }
  .badge[data-status="active"],
  .badge[data-status="ready"] {
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 9%, var(--card));
  }
  .badge[data-status="pending"],
  .badge[data-status="connection_required"] {
    color: var(--warn);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 6px;
  }
  .actions button {
    font-size: 12px;
    padding: 6px 9px;
  }
  .empty {
    display: grid;
    justify-items: start;
    gap: 9px;
    padding: 24px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    color: var(--muted);
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 9px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--muted);
  }
  .notice[role="alert"] {
    color: var(--danger);
  }
  .notice[data-success] {
    color: var(--ok);
  }
  .notice button {
    padding: 4px 8px;
    font-size: 12px;
  }
  .audit {
    display: grid;
    gap: 0;
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .audit li {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
    overflow-wrap: anywhere;
  }
  .audit time {
    color: var(--muted);
    font-size: 12px;
    flex: none;
  }
  .admin-modal {
    --openclaw-modal-width: min(540px, calc(100vw - 32px));
  }
  .admin-dialog {
    position: relative;
    padding: 22px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-xl);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-xl);
    max-height: calc(100dvh - min(20dvh, 160px) - 24px);
    overflow: auto;
    display: grid;
    gap: 17px;
  }
  .dialog-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 12px;
  }
  .dialog-heading h2 {
    font-size: 18px;
  }
  .dialog-heading p {
    margin-top: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .dialog-close {
    border: 0;
    padding: 3px 7px;
    font-size: 22px;
    line-height: 1;
    background: transparent;
  }
  .admin-dialog form {
    display: grid;
    gap: 13px;
  }
  .admin-dialog label {
    display: grid;
    gap: 5px;
    font-weight: 550;
  }
  .admin-dialog input,
  .admin-dialog select,
  .admin-dialog textarea {
    width: 100%;
    padding: 9px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
  }
  .admin-dialog textarea {
    min-height: 84px;
    resize: vertical;
  }
  .admin-dialog fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 13px;
    min-width: 0;
  }
  .admin-dialog details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
  }
  .admin-dialog details > div {
    display: grid;
    gap: 13px;
    padding-top: 12px;
  }
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
  }
  .form-error {
    padding: 10px 12px;
    border-inline-start: 3px solid var(--danger);
    color: var(--danger);
    background: var(--bg);
    border-radius: var(--radius-md);
    overflow-wrap: anywhere;
  }
  .probe-facts {
    display: grid;
    gap: 10px;
  }
  .probe-facts dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 7px 12px;
    margin: 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
  }
  .probe-facts dt {
    color: var(--muted);
    font-size: 12px;
  }
  .probe-facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .fingerprint {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    user-select: all;
  }
  .progress {
    display: grid;
    gap: 12px;
    text-align: center;
    padding: 4px 0;
  }
  .flow {
    display: grid;
    grid-template-columns: 80px minmax(60px, 1fr) 80px;
    align-items: center;
    gap: 10px;
    color: var(--accent);
    max-width: 340px;
    width: 100%;
    margin: 0 auto;
  }
  .flow-server {
    display: grid;
    justify-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--muted);
  }
  .flow-server > svg {
    width: 33px;
    height: 33px;
  }
  .flow-link {
    position: relative;
    height: 32px;
    display: grid;
    place-items: center;
  }
  .flow-track {
    position: absolute;
    inset-inline: 0;
    height: 1px;
    background: var(--border-strong);
  }
  .flow-packet {
    position: absolute;
    left: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: vm-packet 1.2s ease-in-out infinite;
  }
  .flow-orb {
    display: grid;
    place-items: center;
    z-index: 1;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--bg-elevated);
  }
  .flow-orb > svg {
    width: 24px;
    height: 24px;
  }
  .spinner {
    width: 19px;
    height: 19px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: vm-spin 1s linear infinite;
  }
  .progress[data-outcome="success"] {
    color: var(--ok);
  }
  .progress[data-outcome="error"] {
    color: var(--danger);
  }
  .progress:not([data-outcome="working"]) .flow-packet {
    display: none;
  }
  .progress p {
    font-size: 13px;
  }
  .progress .small {
    font-size: 12px;
    color: var(--muted);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @keyframes vm-packet {
    0% {
      left: 0;
      opacity: 0;
    }
    20% {
      opacity: 1;
    }
    80% {
      opacity: 1;
    }
    100% {
      left: calc(100% - 6px);
      opacity: 0;
    }
  }
  @keyframes vm-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 600px) {
    main {
      padding-inline: 10px;
    }
    .overview {
      gap: 7px;
    }
    .metric {
      padding: 11px 10px;
    }
    .metric strong {
      font-size: 22px;
    }
    .metric span {
      font-size: 11px;
    }
    .server-card {
      gap: 10px;
      padding: 12px;
    }
    .server-glyph {
      width: 32px;
      height: 38px;
    }
    .server-glyph > svg {
      width: 24px;
      height: 24px;
    }
    .audit li {
      display: grid;
      gap: 5px;
    }
    .admin-dialog {
      padding: 18px;
    }
    .tabs {
      max-width: 100%;
      margin-inline: -2px;
    }
    .tabs wa-tab::part(base) {
      padding: 7px 6px;
      font-size: 12px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .flow-packet,
    .spinner {
      animation: none;
    }
    .flow-packet {
      display: none;
    }
    .admin-modal {
      --wa-transition-normal: 0ms;
    }
  }
`;
