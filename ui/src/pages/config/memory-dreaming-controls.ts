import { html, type TemplateResult } from "lit";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { renderDreamingUnsupported } from "./memory-dreaming.ts";

const DREAMING_DOCS_URL = "https://docs.openclaw.ai/concepts/dreaming";

export function renderMemoryDreamingControls(
  pluginId: string,
  unsupported: boolean,
  settings: TemplateResult,
) {
  return html`<p class="settings-page__intro">
      ${t("memoryPage.dreaming.intro", { plugin: pluginId })}
      ${renderDocsLink(DREAMING_DOCS_URL, t("common.learnMore"))}
    </p>
    ${unsupported ? renderDreamingUnsupported(pluginId) : settings}`;
}
