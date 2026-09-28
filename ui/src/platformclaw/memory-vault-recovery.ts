import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  KnowledgeVaultCatalogEntry,
  KnowledgeVaultGrantTarget,
} from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";
import { renderMemberTargetSearch } from "./member-target-search.ts";
import { renderVaultDialog } from "./memory-vault-catalog.ts";

const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);

class PlatformClawVaultRecovery extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) vault!: KnowledgeVaultCatalogEntry;
  @state() private targets: KnowledgeVaultGrantTarget[] = [];
  @state() private chosen: KnowledgeVaultGrantTarget | null = null;
  @state() private hasMore = false;
  @state() private searched = false;
  @state() private busy = false;
  @state() private error = "";
  private epoch = 0;

  protected override updated(changed: PropertyValues) {
    if (changed.has("client") || changed.has("vault")) {
      this.epoch++;
      this.targets = [];
      this.chosen = null;
      this.searched = this.busy = false;
      this.error = "";
    }
  }
  override disconnectedCallback() {
    this.epoch++;
    super.disconnectedCallback();
  }
  private async run(action: () => Promise<void>) {
    if (!this.isConnected || !this.client || !this.vault.canRecoverOwner || this.busy) {
      return;
    }
    const epoch = this.epoch;
    this.busy = true;
    this.error = "";
    try {
      await action();
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
      }
    }
  }
  override render() {
    if (!this.vault?.canRecoverOwner) {
      return nothing;
    }
    return renderVaultDialog({
      title: t("recoverOwner"),
      busy: this.busy,
      error: this.error,
      onClose: () => this.dispatchEvent(new CustomEvent("recovery-close", { bubbles: true })),
      content: html`<p><strong>${this.vault.name}</strong></p>
        <p>${t("recoverOwnerHint")}</p>
        ${this.chosen
          ? html`<p>${this.chosen.label} · ${this.chosen.accountId}</p>
              <button
                class="btn primary"
                ?disabled=${this.busy}
                @click=${() =>
                  void this.run(async () => {
                    const epoch = this.epoch;
                    await this.client!.request("platformclaw.vault.owner.recover", {
                      vaultId: this.vault.id,
                      accountId: this.chosen!.accountId,
                    });
                    if (epoch === this.epoch) {
                      this.dispatchEvent(new CustomEvent("recovery-saved", { bubbles: true }));
                    }
                  })}
              >
                ${t("confirmOwner")}</button
              ><button class="btn" ?disabled=${this.busy} @click=${() => (this.chosen = null)}>
                ${t("cancel")}
              </button>`
          : renderMemberTargetSearch({
              label: t("searchPeople"),
              searchLabel: t("searchTargets"),
              moreLabel: t("targetsHasMore"),
              busy: this.busy,
              hasMore: this.hasMore,
              items: this.targets.map((target) => ({
                ...target,
                action: t("recoverOwner"),
                disabled: !target.accountId,
              })),
              onSelect: (id) =>
                (this.chosen = this.targets.find((target) => target.id === id) ?? null),
              onSearch: (query) =>
                void this.run(async () => {
                  const epoch = this.epoch;
                  const result = await this.client!.request<{
                    items: KnowledgeVaultGrantTarget[];
                    hasMore: boolean;
                  }>("platformclaw.vault.targets.search", {
                    vaultId: this.vault.id,
                    kind: "user",
                    query,
                  });
                  if (epoch === this.epoch) {
                    this.targets = result.items;
                    this.hasMore = result.hasMore;
                    this.searched = true;
                  }
                }),
            })}
        ${this.searched && !this.targets.length
          ? html`<p role="status">${t("noMatches")}</p>`
          : nothing}`,
    });
  }
}
if (!customElements.get("platformclaw-vault-recovery")) {
  customElements.define("platformclaw-vault-recovery", PlatformClawVaultRecovery);
}
