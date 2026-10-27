import { html, LitElement } from "lit";
import { renderSettingsToggleRow } from "../components/settings-ui.ts";
import {
  composerPredictionsAvailable,
  subscribeComposerPreferences,
  updateComposerPreferences,
} from "./composer-predictions.ts";
import { platformClawT as t } from "./i18n.ts";

class ComposerPredictionSettings extends LitElement {
  private unsubscribe?: () => void;
  private saving = false;
  private error = false;
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = subscribeComposerPreferences(() => this.requestUpdate());
    void updateComposerPreferences();
  }
  override disconnectedCallback() {
    this.unsubscribe?.();
    super.disconnectedCallback();
  }
  private async save(checked: boolean): Promise<void> {
    this.saving = true;
    this.error = false;
    this.requestUpdate();
    await updateComposerPreferences(checked);
    this.error = composerPredictionsAvailable().enabled !== checked;
    this.saving = false;
    this.requestUpdate();
  }
  protected override render() {
    const value = composerPredictionsAvailable();
    return html`${renderSettingsToggleRow({
      title: t("platformClaw.composerPredictions.title"),
      description: html`${t("platformClaw.composerPredictions.description")}
      ${!value.available ? html`<br />${t("platformClaw.composerPredictions.unavailable")}` : ""}
      ${this.error
        ? html`<span role="status">${t("platformClaw.composerPredictions.saveError")}</span>`
        : ""}`,
      checked: value.enabled,
      disabled: this.saving || !value.available,
      onChange: (checked: boolean) => {
        void this.save(checked);
      },
    })}`;
  }
}
customElements.define("platformclaw-composer-predictions-settings", ComposerPredictionSettings);
