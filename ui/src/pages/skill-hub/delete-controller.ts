import type { ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import {
  deletePlatformClawSkillHubSkill,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubDelete } from "./dialogs.ts";
import { refreshSkillHubAfterMutation, type SkillHubRef } from "./page-support.ts";

type PendingSkillDelete = {
  id: string;
  slug: string;
  expectedRevision: number;
  reason?: string;
  error?: string;
};

export class SkillHubDeleteController {
  private pending: PendingSkillDelete | null = null;
  private deleting = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: () => Promise<void>;
      closeDetail: () => void;
      setMessage: (message: PlatformClawSkillHubMessage | null) => void;
    },
  ) {}

  get busy(): boolean {
    return this.deleting;
  }

  request(
    ref: SkillHubRef | null,
    detail: PlatformClawSkillHubDetail | null,
    reason?: string,
  ): void {
    const revision = detail?.skill.revision;
    if (!ref || !detail?.canManage || typeof revision !== "number" || this.deleting) {
      return;
    }
    this.options.setMessage(null);
    this.pending = {
      ...ref,
      ...(reason ? { reason } : {}),
      expectedRevision: revision,
    };
    this.host.requestUpdate();
  }

  clear(): void {
    if (this.deleting) {
      return;
    }
    this.pending = null;
    this.host.requestUpdate();
  }

  renderDialog() {
    return renderSkillHubDelete({
      open: this.pending !== null,
      skill: this.pending?.slug ?? "",
      busy: this.deleting,
      error: this.pending?.error ?? null,
      onClose: () => this.clear(),
      onConfirm: () => void this.confirm(),
    });
  }

  private async confirm(): Promise<void> {
    if (!this.pending || this.deleting) {
      return;
    }
    const target = {
      id: this.pending.id,
      reason: this.pending.reason,
      slug: this.pending.slug,
      expectedRevision: this.pending.expectedRevision,
    };
    this.deleting = true;
    this.pending = target;
    this.host.requestUpdate();
    try {
      await deletePlatformClawSkillHubSkill(target.id, target.expectedRevision, target.reason);
      this.pending = null;
      this.options.closeDetail();
      this.host.requestUpdate();
      await refreshSkillHubAfterMutation(
        t("skillHubPage.deletedSkill", { skill: target.slug }),
        this.options.refresh,
        this.options.setMessage,
      );
    } catch (error) {
      this.pending = {
        ...target,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.deleting = false;
      this.host.requestUpdate();
    }
  }
}
