import { css } from "lit";

export const mcpWorkspaceStyles = css`
  :host {
    display: block;
    min-width: 0;
    color: var(--text);
    font: 14px/1.5 var(--font-sans, system-ui, sans-serif);
  }
  * {
    box-sizing: border-box;
  }
  [hidden] {
    display: none !important;
  }
  h2,
  h3,
  p {
    margin: 0;
  }
  h2 {
    font-size: 18px;
  }
  h3 {
    font-size: 15px;
  }
  p,
  .muted {
    color: var(--muted);
  }
  button,
  input,
  select,
  textarea {
    font: inherit;
    color: var(--text);
  }
  button {
    min-height: 38px;
    padding: 8px 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  button:disabled,
  input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-foreground);
  }
  button.primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  button.danger {
    color: var(--danger);
  }
  input,
  select,
  textarea {
    width: 100%;
    min-width: 0;
    padding: 9px 11px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
  }
  input[type="checkbox"] {
    width: auto;
  }
  label {
    display: grid;
    min-width: 0;
    gap: 5px;
    color: var(--muted);
  }
  .heading,
  .actions,
  .editor-title,
  .list-meta,
  .pagination {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .heading {
    margin-bottom: 20px;
    align-items: flex-start;
  }
  .heading p {
    margin-top: 4px;
  }
  .workspace {
    display: grid;
    grid-template-columns: minmax(330px, 0.38fr) minmax(0, 0.62fr);
    gap: 20px;
    align-items: start;
  }
  .catalog,
  .detail {
    min-width: 0;
  }
  .detail {
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-content);
  }
  .toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 116px;
    gap: 10px;
    margin-bottom: 12px;
  }
  .search {
    grid-column: 1 / -1;
  }
  .list-meta {
    margin-bottom: 10px;
    color: var(--muted);
    font-size: 12px;
  }
  .server-list {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
  }
  .server-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
  }
  .server-row + .server-row {
    border-top: 1px solid var(--border);
  }
  .server-row[data-selected] {
    background: var(--accent-subtle);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .server-select {
    display: grid;
    flex: 1;
    min-width: 0;
    min-height: 44px;
    gap: 3px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    text-align: left;
  }
  .server-select:hover:not(:disabled) {
    background: transparent;
  }
  .server-name {
    display: flex;
    gap: 6px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .server-name strong {
    overflow-wrap: anywhere;
    color: var(--text-strong);
  }
  .origin {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .policy,
  .status {
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .status[data-warning] {
    color: var(--warn);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-size: 12px;
  }
  .toggle input {
    appearance: none;
    position: relative;
    width: 38px;
    height: 22px;
    margin: 0;
    padding: 0;
    border-radius: var(--radius-full, 999px);
    background: var(--bg-hover);
  }
  .toggle input::before {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--muted-strong);
  }
  .toggle input:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  .toggle input:checked::before {
    left: 18px;
    background: var(--accent-foreground);
  }
  .toggle span {
    max-width: 68px;
    overflow-wrap: anywhere;
  }
  .pagination {
    margin-top: 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .pagination span {
    margin-right: auto;
  }
  .editor-title {
    margin-bottom: 16px;
  }
  .editor-title small,
  .help,
  .optional {
    color: var(--muted);
    font-size: 12px;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .section {
    margin-top: 17px;
    padding-top: 15px;
    border-top: 1px solid var(--border);
  }
  .section > p {
    margin: 4px 0 13px;
    font-size: 12px;
  }
  .guide-row,
  .custom-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr) auto;
    align-items: end;
    gap: 10px;
    margin-bottom: 11px;
  }
  .guided-value {
    margin-bottom: 13px;
  }
  .guided-value > p {
    font-size: 12px;
    margin-bottom: 5px;
  }
  .input-line {
    display: flex;
    gap: 7px;
    align-items: end;
  }
  .input-line > label,
  .input-line > input {
    flex: 1;
    min-width: 0;
  }
  .input-line > button {
    flex: none;
  }
  .credential {
    margin-top: 14px;
  }
  .actions {
    justify-content: flex-start;
    margin-top: 17px;
  }
  .actions .danger {
    margin-left: auto;
  }
  .message,
  .warning {
    margin: 12px 0;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    background: var(--accent-subtle);
    overflow-wrap: anywhere;
  }
  .message[role="alert"] {
    color: var(--danger);
  }
  .warning {
    color: var(--warn);
    background: var(--warn-subtle);
  }
  .empty {
    padding: 22px 16px;
    color: var(--muted);
  }
  details {
    margin-top: 15px;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
  }
  details > label {
    margin-top: 9px;
  }
  .mobile-picker {
    display: none;
  }
  @media (max-width: 900px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }
    .mobile-picker {
      display: block;
      margin-bottom: 14px;
    }
    .mobile-picker button {
      max-width: 100%;
      text-align: left;
      overflow-wrap: anywhere;
    }
    .catalog {
      display: none;
    }
    .workspace[data-picking] .catalog {
      display: block;
    }
    .workspace[data-picking] .detail {
      display: none;
    }
  }
  @media (max-width: 600px) {
    .fields,
    .guide-row,
    .custom-row {
      grid-template-columns: minmax(0, 1fr);
    }
    .wide {
      grid-column: auto;
    }
    .guide-row > button,
    .custom-row > button {
      justify-self: start;
    }
    .input-line {
      flex-wrap: wrap;
    }
    .input-line > input,
    .input-line > label {
      flex-basis: 100%;
    }
    .detail {
      padding: 15px 12px;
    }
    .actions .danger {
      margin-left: 0;
    }
  }
  @media (pointer: coarse) {
    button,
    .toggle {
      min-height: 44px;
    }
    input,
    select,
    textarea {
      font-size: 16px;
    }
  }
`;
