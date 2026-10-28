import type { ReactiveController, ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import {
  publishPlatformClawSkillArchive,
  PlatformClawSkillHubRequestError,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubDetail,
  type PlatformClawSkillHubMessage,
} from "../../platformclaw/skill-hub.ts";
import { renderSkillHubUpload } from "./dialogs.ts";
import { refreshSkillHubAfterMutation, type SkillHubRef } from "./page-support.ts";
import { SkillHubPublicationAttempts } from "./publication-attempts.ts";
import {
  initialSkillHubSharing,
  skillHubSharingInvalid,
  skillHubSharingRequest,
} from "./sharing.ts";

type UploadPublicationDraft = {
  request: Omit<Parameters<typeof publishPlatformClawSkillArchive>[1], "operationId">;
  sharing: ReturnType<typeof initialSkillHubSharing>;
  existing: { id: string; slug: string; displayName: string; revision: number } | null;
  file: File;
};

function uploadOutcomeUnconfirmed(error: unknown): boolean {
  // ZIP body 413/415 and these typed validation errors precede catalog reservation.
  // Native registry 413/415 normalize to 502; other statuses may follow an effect.
  if (!(error instanceof PlatformClawSkillHubRequestError)) {
    return true;
  }
  const code = error.details?.code;
  return !(
    error.status === 413 ||
    error.status === 415 ||
    (error.status === 400 &&
      typeof code === "string" &&
      [
        "skill-hub-invalid-version",
        "skill-hub-invalid-manifest",
        "skill-hub-invalid-archive",
        "skill-hub-version-mismatch",
      ].includes(code))
  );
}

export class SkillHubUploadController implements ReactiveController {
  private open = false;
  private reason: string | undefined;
  private existing: { id: string; slug: string; displayName: string; revision: number } | null =
    null;
  private file: File | null = null;
  private slug = "";
  private operationId = "";
  private version = "1.0.0";
  private sharing = initialSkillHubSharing();
  private publishing = false;
  private error: string | null = null;
  private readonly attempts = new SkillHubPublicationAttempts<UploadPublicationDraft>();

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: (ref: SkillHubRef | null) => Promise<void>;
      setMessage: (message: PlatformClawSkillHubMessage | null) => void;
    },
  ) {
    host.addController(this);
  }

  hostDisconnected(): void {
    this.attempts.clear();
    this.file = null;
  }

  forgetPublication(operationId: string): void {
    this.attempts.forget(operationId);
    if (this.operationId === operationId) {
      this.operationId = crypto.randomUUID();
    }
    this.host.requestUpdate();
  }

  openDialog(
    _config: PlatformClawSkillHubConfig | null,
    detail?: PlatformClawSkillHubDetail | null,
    reason?: string,
  ) {
    if (this.publishing || (detail && !detail.canManage)) {
      return;
    }
    this.reason = detail && !detail.owner.isMine ? reason?.trim() : undefined;
    const skill = detail?.skill;
    this.existing = skill
      ? { id: skill.id, slug: skill.slug, displayName: skill.displayName, revision: skill.revision }
      : null;
    this.slug = skill?.slug ?? "";
    this.operationId = crypto.randomUUID();
    this.sharing = initialSkillHubSharing();
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
      version: this.version,
      sharing: this.sharing,
      existing: this.existing,
      busy: this.publishing,
      recovery: this.attempts.items.map((attempt) => ({
        operationId: attempt.operationId,
        label: `${attempt.draft.request.slug} · ${attempt.draft.request.version} · ${attempt.draft.file.name}`,
        onRestore: () => {
          if (this.publishing) {
            return;
          }
          const { request, sharing, existing, file } = attempt.draft;
          this.operationId = attempt.operationId;
          this.slug = request.slug;
          this.version = request.version;
          this.reason = request.reason;
          this.sharing = sharing;
          this.existing = existing;
          this.file = file;
          this.error = null;
          this.host.requestUpdate();
        },
      })),
      onClose: () => this.update(() => (this.open = false)),
      onFile: (file) => this.update(() => (this.file = file)),
      onSlug: (slug) => this.update(() => (this.slug = slug)),
      onVersion: (version) => this.update(() => (this.version = version)),
      onSharing: (sharing) => this.update(() => (this.sharing = sharing)),
      onPublish: () => void this.publish(),
    });
  }

  private update(mutate: () => void) {
    if (!this.publishing) {
      mutate();
      this.operationId = crypto.randomUUID();
      this.host.requestUpdate();
    }
  }

  private async publish() {
    if (!this.file || this.publishing || (!this.existing && skillHubSharingInvalid(this.sharing))) {
      return;
    }
    const draft: UploadPublicationDraft = {
      request: {
        ...(this.reason ? { reason: this.reason } : {}),
        slug: this.slug,
        version: this.version,
        ...(this.existing
          ? { id: this.existing.id, expectedRevision: this.existing.revision }
          : { sharing: skillHubSharingRequest(this.sharing) }),
      },
      sharing: this.sharing,
      existing: this.existing,
      file: this.file,
    };
    const intent = JSON.stringify(draft.request);
    if (this.attempts.hasUnconfirmedFileConflict(intent, this.file)) {
      this.error = t("skillHubPage.uploadRequestUnconfirmed");
      this.host.requestUpdate();
      return;
    }
    this.publishing = true;
    this.error = null;
    this.options.setMessage(null);
    this.host.requestUpdate();
    const attempt = this.attempts.begin(this.operationId, intent, draft, this.file);
    this.operationId = attempt.operationId;
    try {
      const result = await publishPlatformClawSkillArchive(attempt.draft.file, {
        operationId: attempt.operationId,
        ...attempt.draft.request,
      });
      this.attempts.forget(attempt.operationId);
      this.open = false;
      this.file = null;
      this.host.requestUpdate();
      await refreshSkillHubAfterMutation(
        t("skillHubPage.publishedZip", {
          skill: `${result.slug}@${result.version}`,
        }),
        () => this.options.refresh(this.existing ? result : null),
        this.options.setMessage,
      );
    } catch (error) {
      if (
        error instanceof PlatformClawSkillHubRequestError &&
        error.details?.code === "skill-hub-publication-cancelled"
      ) {
        this.forgetPublication(attempt.operationId);
      } else {
        this.attempts.remember(attempt, uploadOutcomeUnconfirmed(error));
      }
      this.error = error instanceof Error ? error.message : String(error);
      // Preserve the error and File without holding the dialog open for an optional read.
      void this.options.refresh(null).catch(() => {});
    } finally {
      this.publishing = false;
      this.host.requestUpdate();
    }
  }
}
