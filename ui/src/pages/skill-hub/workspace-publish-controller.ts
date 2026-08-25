import { html, type ReactiveController, type ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT } from "../../platformclaw/i18n.ts";
import {
  loadPlatformClawWorkspaceSkills,
  publishPlatformClawWorkspaceSkill,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubWorkspaceSkill,
  type PlatformClawSkillHubWorkspaceTarget,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubWorkspacePublish } from "./dialogs.ts";

export class SkillHubWorkspacePublishController implements ReactiveController {
  private open = false;
  private source: PlatformClawSkillHubWorkspaceTarget = "platform_server";
  private skills: PlatformClawSkillHubWorkspaceSkill[] = [];
  private skill = "";
  private namespace = "";
  private version = "1.0.0";
  private visibility = "NAMESPACE_ONLY";
  private loading = false;
  private publishing = false;
  private error: string | null = null;
  private generation = 0;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: () => Promise<void>;
      setMessage: (message: PlatformClawSkillHubMessage | null) => void;
    },
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    void loadPlatformClawLocale().then(() => this.host.requestUpdate());
  }

  hostDisconnected(): void {
    this.generation += 1;
  }

  renderAction(config: PlatformClawSkillHubConfig | null) {
    return html`<button
      class="btn primary"
      ?disabled=${!config || config.namespaces.length === 0}
      @click=${() => config && this.openDialog(config)}
    >
      ${platformClawT("platformClaw.skillHub.publish.action")}
    </button>`;
  }

  renderDialog(config: PlatformClawSkillHubConfig | null) {
    return renderSkillHubWorkspacePublish({
      open: this.open,
      config,
      source: this.source,
      skills: this.skills,
      skill: this.skill,
      namespace: this.namespace,
      version: this.version,
      visibility: this.visibility,
      loading: this.loading,
      busy: this.publishing,
      error: this.error,
      onClose: () => this.close(),
      onSource: (source) => void this.loadSkills(source),
      onSkill: (skill) => this.selectSkill(skill),
      onNamespace: (namespace) => this.update(() => (this.namespace = namespace)),
      onVersion: (version) => this.update(() => (this.version = version)),
      onVisibility: (visibility) => this.update(() => (this.visibility = visibility)),
      onPublish: () => void this.publish(),
    });
  }

  private update(mutate: () => void): void {
    mutate();
    this.host.requestUpdate();
  }

  private async openDialog(config: PlatformClawSkillHubConfig) {
    if (this.publishing) {
      return;
    }
    this.source =
      config.activeTarget === "assigned_vm" &&
      config.installTargets?.some((target) => target.target === "assigned_vm" && target.available)
        ? "assigned_vm"
        : "platform_server";
    this.namespace = config.namespaces[0] ?? "";
    this.version = "1.0.0";
    this.visibility = "NAMESPACE_ONLY";
    this.open = true;
    this.options.setMessage(null);
    this.host.requestUpdate();
    await this.loadSkills(this.source);
  }

  private async loadSkills(source: PlatformClawSkillHubWorkspaceTarget) {
    const generation = ++this.generation;
    this.source = source;
    this.skills = [];
    this.skill = "";
    this.error = null;
    this.loading = true;
    this.host.requestUpdate();
    try {
      const result = await loadPlatformClawWorkspaceSkills(source);
      if (generation !== this.generation || this.source !== source) {
        return;
      }
      this.skills = result.items;
      if (result.items.length === 1) {
        this.selectSkill(result.items[0]!.skillKey);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  private selectSkill(skillKey: string) {
    this.skill = skillKey;
    const skill = this.skills.find((item) => item.skillKey === skillKey);
    if (skill?.version) {
      this.version = skill.version;
    }
    this.host.requestUpdate();
  }

  private close() {
    if (this.publishing) {
      return;
    }
    this.generation += 1;
    this.open = false;
    this.loading = false;
    this.host.requestUpdate();
  }

  private async publish() {
    if (!this.skill || this.publishing || this.loading) {
      return;
    }
    this.publishing = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const result = await publishPlatformClawWorkspaceSkill({
        skill: this.skill,
        source: this.source,
        namespace: this.namespace,
        version: this.version,
        visibility: this.visibility,
      });
      const source = platformClawT(
        this.source === "assigned_vm"
          ? "platformClaw.skillHub.publish.sourceVm"
          : "platformClaw.skillHub.publish.sourceBasic",
      );
      const message: PlatformClawSkillHubMessage = {
        kind: result.ownershipReviewRequired ? "warning" : "success",
        text: result.ownershipReviewRequired
          ? t("skillHubPage.publishedNeedsOwnershipReview", {
              skill: `${result.namespace}/${result.slug}@${result.version}`,
            })
          : platformClawT("platformClaw.skillHub.publish.published", {
              skill: `${result.namespace}/${result.slug}@${result.version}`,
              source,
            }),
      };
      this.open = false;
      await this.options.refresh();
      this.options.setMessage(message);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.publishing = false;
      this.host.requestUpdate();
    }
  }
}
