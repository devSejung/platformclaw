import { html, type TemplateResult } from "lit";
import type { SkillStatusReport } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { SkillWorkshopPageContext } from "./source-scope.ts";

type LoadPersonalAccessOptions = {
  context: SkillWorkshopPageContext;
  loadServerProposals: () => Promise<unknown>;
  onError: (error: unknown) => void;
  onUpdate: () => void;
};

export class SkillWorkshopPersonalAccess {
  target: SkillStatusReport["executionTarget"] | null = null;
  loading = false;
  private attempted = false;
  private epoch = 0;

  reset() {
    this.epoch += 1;
    this.target = null;
    this.loading = false;
    this.attempted = false;
  }

  prepareRetry(force: boolean, error: string | null): string | null {
    if (!force || !error) {
      return error;
    }
    this.reset();
    return null;
  }

  async load(options: LoadPersonalAccessOptions): Promise<void> {
    const client = options.context.gateway.snapshot.client;
    if (!client || this.loading || this.attempted) {
      return;
    }
    const epoch = this.epoch;
    this.attempted = true;
    this.loading = true;
    options.onUpdate();
    try {
      const report = await client.request<SkillStatusReport>("skills.status", {});
      if (this.epoch !== epoch || options.context.gateway.snapshot.client !== client) {
        return;
      }
      this.target = report.executionTarget ?? "platform_server";
      if (this.target === "platform_server") {
        await options.loadServerProposals();
      }
    } catch (error) {
      if (this.epoch === epoch) {
        options.onError(error);
      }
    } finally {
      if (this.epoch === epoch && options.context.gateway.snapshot.client === client) {
        this.loading = false;
        options.onUpdate();
      }
    }
  }
}

export function renderAssignedVmWorkshopUnavailable(
  context: SkillWorkshopPageContext,
): TemplateResult {
  return html`
    <section class="content--skill-workshop">
      <section class="content-header content-header--page plugins-content-header">
        <div><h1 class="page-title">${t("tabs.skillWorkshop")}</h1></div>
      </section>
      <div class="callout" role="status">
        <strong>${t("platformClaw.skills.vmWorkshopUnavailableTitle")}</strong>
        <div class="muted">${t("platformClaw.skills.vmWorkshopUnavailableDescription")}</div>
        <button class="btn" @click=${() => context.navigate("skills")}>
          ${t("platformClaw.skills.vmWorkshopUnavailableAction")}
        </button>
      </div>
    </section>
  `;
}
