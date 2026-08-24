import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../styles/platformclaw-organization.css";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import { PlatformClawOrganizationApi, type OrganizationContext } from "./organization-api.ts";

export const ORGANIZATION_JOIN_PROMPT_DISMISSED_KEY =
  "platformclaw.organizationJoinPrompt.dismissed";

class PlatformClawOrganizationJoinPrompt extends OpenClawLightDomElement {
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @property() href = "/platformclaw/app/settings/organization?tab=requests";
  @property({ attribute: false }) storage: Pick<Storage, "getItem" | "setItem"> | null = null;
  @state() private context: OrganizationContext | null = null;
  @state() private dismissed = false;

  override connectedCallback(): void {
    super.connectedCallback();
    void Promise.all([
      loadPlatformClawLocale(),
      new PlatformClawOrganizationApi({
        fetchImpl: this.fetchImpl,
        onUnauthenticated: this.onUnauthenticated,
      }).context(),
    ])
      .then(([, context]) => {
        this.context = context;
        try {
          this.dismissed =
            this.storage?.getItem(ORGANIZATION_JOIN_PROMPT_DISMISSED_KEY) === context.actor.id;
        } catch {
          this.dismissed = false;
        }
      })
      .catch(() => {
        // The optional prompt must never block the signed-in application shell.
      });
  }

  private dismiss(): void {
    this.dismissed = true;
    try {
      if (this.context) {
        this.storage?.setItem(ORGANIZATION_JOIN_PROMPT_DISMISSED_KEY, this.context.actor.id);
      }
    } catch {
      // Dismissal remains effective for this rendered session when storage is unavailable.
    }
  }

  override render() {
    if (this.dismissed || this.context?.joinPromptEligible !== true) {
      return nothing;
    }
    return html`<aside
      class="platformclaw-organization-prompt callout"
      aria-label=${t("platformClaw.organization.prompt.title")}
    >
      <div>
        <strong>${t("platformClaw.organization.prompt.title")}</strong>
        <p>${t("platformClaw.organization.prompt.description")}</p>
      </div>
      <div class="organization-request-actions">
        <button class="btn" type="button" @click=${() => this.dismiss()}>
          ${t("platformClaw.organization.prompt.dismiss")}
        </button>
        <a class="btn primary" href=${this.href} @click=${() => this.dismiss()}
          >${t("platformClaw.organization.prompt.action")}</a
        >
      </div>
    </aside>`;
  }
}

if (!customElements.get("platformclaw-organization-join-prompt")) {
  customElements.define(
    "platformclaw-organization-join-prompt",
    PlatformClawOrganizationJoinPrompt,
  );
}
