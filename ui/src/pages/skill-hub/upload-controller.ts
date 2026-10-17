import type { ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import {
  publishPlatformClawSkillArchive,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubUpload } from "./dialogs.ts";
import type { SkillHubRef } from "./page-support.ts";

export class SkillHubUploadController {
  private open = false;
  private existing: SkillHubRef | null = null;
  private file: File | null = null;
  private slug = "";
  private namespace = "";
  private version = "1.0.0";
  private visibility = "NAMESPACE_ONLY";
  private publishing = false;
  private error: string | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: (ref: SkillHubRef | null) => Promise<void>;
      setMessage: (message: PlatformClawSkillHubMessage | null) => void;
    },
  ) {}

  openDialog(
    config: PlatformClawSkillHubConfig | null,
    detail?: PlatformClawSkillHubDetail | null,
  ) {
    if (this.publishing || (detail && !detail.canManage)) {
      return;
    }
    const skill = detail?.skill;
    this.existing = skill ? { namespace: skill.namespace, slug: skill.slug } : null;
    this.slug = skill?.slug ?? "";
    this.namespace = skill?.namespace ?? config?.namespaces[0] ?? "";
    this.visibility = skill?.visibility ?? "NAMESPACE_ONLY";
    this.version = skill ? "" : "1.0.0";
    this.file = null;
    this.error = null;
    this.open = true;
    this.options.setMessage(null);
    this.host.requestUpdate();
  }

  renderDialog(config: PlatformClawSkillHubConfig | null) {
    return renderSkillHubUpload({
      open: this.open,
      config,
      file: this.file,
      error: this.error,
      slug: this.slug,
      namespace: this.namespace,
      version: this.version,
      visibility: this.visibility,
      existing: this.existing,
      busy: this.publishing,
      onClose: () => this.update(() => (this.open = false)),
      onFile: (file) => this.update(() => (this.file = file)),
      onSlug: (slug) => this.update(() => (this.slug = slug)),
      onNamespace: (namespace) => this.update(() => (this.namespace = namespace)),
      onVersion: (version) => this.update(() => (this.version = version)),
      onVisibility: (visibility) => this.update(() => (this.visibility = visibility)),
      onPublish: () => void this.publish(),
    });
  }

  private update(mutate: () => void) {
    if (!this.publishing) {
      mutate();
      this.host.requestUpdate();
    }
  }

  private async publish() {
    if (!this.file || this.publishing) {
      return;
    }
    this.publishing = true;
    this.error = null;
    this.options.setMessage(null);
    this.host.requestUpdate();
    try {
      const result = await publishPlatformClawSkillArchive(this.file, {
        slug: this.slug,
        namespace: this.namespace,
        version: this.version,
        visibility: this.visibility,
      });
      this.open = false;
      await this.options.refresh(this.existing ? result : null);
      this.options.setMessage({
        kind: result.ownershipReviewRequired ? "warning" : "success",
        text: t(
          result.ownershipReviewRequired
            ? "skillHubPage.publishedNeedsOwnershipReview"
            : "skillHubPage.publishedZip",
          {
            skill: `${result.namespace}/${result.slug}@${result.version}`,
          },
        ),
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.publishing = false;
      this.host.requestUpdate();
    }
  }
}
