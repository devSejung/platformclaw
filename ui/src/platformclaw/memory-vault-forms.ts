import { html } from "lit";
import { platformClawT } from "./i18n.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
type VaultFormOptions = {
  busy: boolean;
  onSubmit: (event: SubmitEvent) => void;
  onCancel: () => void;
};

export function renderVaultCreateForm(options: VaultFormOptions) {
  return html`<form class="vaults__form" @submit=${options.onSubmit}>
    <label
      >${t("name")}<input
        class="settings-input"
        name="name"
        required
        maxlength="160"
        autofocus
        placeholder=${t("namePlaceholder")}
    /></label>
    <label
      >${t("description")}<input class="settings-input" name="description" maxlength="2000"
    /></label>
    <p class="vaults__hint">${t("createHint")}</p>
    <div class="vaults__actions">
      <button class="btn primary" ?disabled=${options.busy}>${t("create")}</button
      ><button type="button" class="btn" ?disabled=${options.busy} @click=${options.onCancel}>
        ${t("cancel")}
      </button>
    </div>
  </form>`;
}
