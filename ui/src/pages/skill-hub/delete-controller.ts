import type { ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import {
  deletePlatformClawSkillHubSkill,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubDelete } from "./dialogs.ts";
import type { SkillHubRef } from "./page-support.ts";

type PendingSkillDelete = {
  namespace: string;
  slug: string;
  expectedOwnerUpdatedAt: number;
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

  request(ref: SkillHubRef | null, detail: PlatformClawSkillHubDetail | null): void {
    const revision = detail?.owner?.revision;
    if (!ref || !detail?.canManage || typeof revision !== "number" || this.deleting) {
      return;
    }
    this.options.setMessage(null);
    this.pending = {
      ...ref,
      expectedOwnerUpdatedAt: revision,
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
      skill: this.pending ? `${this.pending.namespace}/${this.pending.slug}` : "",
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
      namespace: this.pending.namespace,
      slug: this.pending.slug,
      expectedOwnerUpdatedAt: this.pending.expectedOwnerUpdatedAt,
    };
    this.deleting = true;
    this.pending = target;
    this.host.requestUpdate();
    try {
      await deletePlatformClawSkillHubSkill(
        target.namespace,
        target.slug,
        target.expectedOwnerUpdatedAt,
      );
      this.pending = null;
      this.options.closeDetail();
      await this.options.refresh();
      this.options.setMessage({
        kind: "success",
        text: t("skillHubPage.deletedSkill", { skill: `${target.namespace}/${target.slug}` }),
      });
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
