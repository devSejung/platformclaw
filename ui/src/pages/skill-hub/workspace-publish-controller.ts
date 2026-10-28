import { html, type ReactiveController, type ReactiveControllerHost } from "lit";
import { loadPlatformClawLocale, platformClawT } from "../../platformclaw/i18n.ts";
import {
  loadPlatformClawWorkspaceSkills,
  publishPlatformClawWorkspaceSkill,
  PlatformClawSkillHubRequestError,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubWorkspaceInventory,
  type PlatformClawSkillHubWorkspaceTarget,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubWorkspacePublish } from "./dialogs.ts";
import { refreshSkillHubAfterMutation, type SkillHubRef } from "./page-support.ts";
import { SkillHubPublicationAttempts } from "./publication-attempts.ts";
import {
  initialSkillHubSharing,
  skillHubSharingInvalid,
  skillHubSharingRequest,
} from "./sharing.ts";

type WorkspacePublicationDraft = {
  request: Omit<Parameters<typeof publishPlatformClawWorkspaceSkill>[0], "operationId">;
  sharing: ReturnType<typeof initialSkillHubSharing>;
  existingName: string;
  inventory: PlatformClawSkillHubWorkspaceInventory | null;
};

export class SkillHubWorkspacePublishController implements ReactiveController {
  private open = false;
  private reason: string | undefined;
  private source: PlatformClawSkillHubWorkspaceTarget = "platform_server";
  private inventory: PlatformClawSkillHubWorkspaceInventory | null = null;
  private skill = "";
  private existingId = "";
  private existingName = "";
  private expectedRevision: number | undefined;
  private config: PlatformClawSkillHubConfig | null = null;
  private operationId = "";
  private version = "1.0.0";
  private sharing = initialSkillHubSharing();
  private loading = false;
  private publishing = false;
  private error: string | null = null;
  private generation = 0;
  private readonly attempts = new SkillHubPublicationAttempts<WorkspacePublicationDraft>();

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: (ref: SkillHubRef | null) => Promise<void>;
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
    this.attempts.clear();
  }

  forgetPublication(operationId: string): void {
    this.attempts.forget(operationId);
    if (this.operationId === operationId) {
      this.operationId = crypto.randomUUID();
    }
    this.host.requestUpdate();
  }

  renderAction(config: PlatformClawSkillHubConfig | null) {
    return html`<button
      class="btn primary"
      ?disabled=${!config}
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
      skills: this.inventory?.items ?? [],
      targetLabel: this.inventory?.targetLabel,
      skill: this.skill,
      existingId: this.existingId,
      existingName: this.existingName,
      version: this.version,
      sharing: this.sharing,
      loading: this.loading,
      busy: this.publishing,
      error: this.error,
      recovery: this.attempts.items.map((attempt) => ({
        operationId: attempt.operationId,
        label: `${attempt.draft.request.skill} · ${attempt.draft.request.version} · ${
          attempt.draft.inventory?.targetLabel ??
          platformClawT(
            attempt.draft.request.source === "assigned_vm"
              ? "platformClaw.skillHub.publish.sourceVm"
              : "platformClaw.skillHub.publish.sourceBasic",
          )
        }`,
        onRestore: () => {
          if (this.publishing) {
            return;
          }
          const { request, sharing, existingName, inventory } = attempt.draft;
          this.generation += 1;
          this.loading = false;
          this.operationId = attempt.operationId;
          this.source = request.source;
          this.skill = request.skill;
          this.version = request.version;
          this.reason = request.reason;
          this.existingId = request.id ?? "";
          this.expectedRevision = request.expectedRevision;
          this.sharing = sharing;
          this.existingName = existingName;
          this.inventory = inventory;
          this.error = null;
          this.host.requestUpdate();
        },
      })),
      onClose: () => this.close(),
      onSource: (source) => void this.loadSkills(source),
      onReload: () => void this.loadSkills(this.source, true),
      onSkill: (skill) => this.selectSkill(skill),
      onExisting: (id) =>
        this.update(() => {
          this.existingId = id;
          this.expectedRevision = this.config?.ownedSkills.find(
            (skill) => skill.id === id,
          )?.revision;
        }),
      onVersion: (version) => this.update(() => (this.version = version)),
      onSharing: (sharing) => this.update(() => (this.sharing = sharing)),
      onPublish: () => void this.publish(),
    });
  }

  private update(mutate: () => void): void {
    mutate();
    this.operationId = crypto.randomUUID();
    this.host.requestUpdate();
  }

  async openDialog(
    config: PlatformClawSkillHubConfig,
    detail?: PlatformClawSkillHubDetail,
    initial?: { skill: string; source: PlatformClawSkillHubWorkspaceTarget },
    reason?: string,
  ) {
    if (this.publishing) {
      return;
    }
    this.source =
      initial?.source ??
      (config.activeTarget === "assigned_vm" &&
      config.installTargets?.some((target) => target.target === "assigned_vm" && target.available)
        ? "assigned_vm"
        : "platform_server");
    this.config = config;
    this.reason = detail && !detail.owner.isMine ? reason?.trim() : undefined;
    this.operationId = crypto.randomUUID();
    this.existingId = detail?.skill.id ?? "";
    this.existingName = detail?.skill.displayName ?? "";
    this.expectedRevision = detail?.skill.revision;
    this.version = "1.0.0";
    this.sharing = initialSkillHubSharing();
    this.open = true;
    this.options.setMessage(null);
    this.host.requestUpdate();
    const loading = this.loadSkills(this.source);
    const generation = this.generation;
    await loading;
    if (!this.open || generation !== this.generation) {
      return;
    }
    if (initial && this.inventory?.items.some((skill) => skill.skillKey === initial.skill)) {
      this.selectSkill(initial.skill);
    }
  }

  private async loadSkills(source: PlatformClawSkillHubWorkspaceTarget, preserveDraft = false) {
    const generation = ++this.generation;
    const selectedSkill = this.skill;
    this.source = source;
    this.operationId = crypto.randomUUID();
    this.inventory = null;
    this.skill = "";
    this.error = null;
    this.loading = true;
    this.host.requestUpdate();
    try {
      const result = await loadPlatformClawWorkspaceSkills(source);
      if (generation !== this.generation || this.source !== source) {
        return;
      }
      this.inventory = result;
      if (preserveDraft) {
        this.skill = result.items.some((skill) => skill.skillKey === selectedSkill)
          ? selectedSkill
          : !selectedSkill && result.items.length === 1
            ? result.items[0]!.skillKey
            : "";
      } else if (result.items.length === 1) {
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
    const skill = this.inventory?.items.find((item) => item.skillKey === skillKey);
    if (this.skill !== skillKey || (skill?.version && this.version !== skill.version)) {
      this.operationId = crypto.randomUUID();
    }
    this.skill = skillKey;
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
    if (
      !this.skill ||
      this.publishing ||
      this.loading ||
      (!this.existingId && skillHubSharingInvalid(this.sharing))
    ) {
      return;
    }
    this.publishing = true;
    this.error = null;
    this.host.requestUpdate();
    const draft: WorkspacePublicationDraft = {
      request: {
        ...(this.reason ? { reason: this.reason } : {}),
        skill: this.skill,
        source: this.source,
        ...(this.inventory?.targetId ? { expectedTargetId: this.inventory.targetId } : {}),
        version: this.version,
        ...(this.existingId
          ? { id: this.existingId, expectedRevision: this.expectedRevision }
          : { sharing: skillHubSharingRequest(this.sharing) }),
      },
      sharing: this.sharing,
      existingName: this.existingName,
      inventory: this.inventory,
    };
    const revision = this.inventory?.items.find((skill) => skill.skillKey === this.skill)?.revision;
    const intent = JSON.stringify([draft.request, revision]);
    const attempt = this.attempts.begin(this.operationId, intent, draft);
    this.operationId = attempt.operationId;
    try {
      const result = await publishPlatformClawWorkspaceSkill({
        operationId: attempt.operationId,
        ...attempt.draft.request,
      });
      this.attempts.forget(attempt.operationId);
      const source = platformClawT(
        this.source === "assigned_vm"
          ? "platformClaw.skillHub.publish.sourceVm"
          : "platformClaw.skillHub.publish.sourceBasic",
      );
      this.open = false;
      this.host.requestUpdate();
      await refreshSkillHubAfterMutation(
        platformClawT("platformClaw.skillHub.publish.published", {
          skill: `${result.slug}@${result.version}`,
          source,
        }),
        () => this.options.refresh(this.existingId ? result : null),
        this.options.setMessage,
      );
    } catch (error) {
      if (
        error instanceof PlatformClawSkillHubRequestError &&
        error.details?.code === "skill-hub-publication-cancelled"
      ) {
        this.forgetPublication(attempt.operationId);
      } else {
        this.attempts.remember(attempt);
      }
      this.error = error instanceof Error ? error.message : String(error);
      // A lost response may have left a canonical pending request. Refresh its cancel affordance.
      // Keep the dialog usable while this optional read is slow or unavailable.
      void this.options.refresh(null).catch(() => {});
    } finally {
      this.publishing = false;
      this.host.requestUpdate();
    }
  }
}
