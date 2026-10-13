import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { icons } from "../../../components/icons.ts";
import { encodeTerminalUpload } from "../../../components/terminal/terminal-file-upload.ts";
import { t } from "../../../i18n/index.ts";
import { formatGatewayRequestFailure } from "../../../lib/gateway-errors.ts";

type UploadTarget = {
  client: GatewayBrowserClient;
  sessionKey: string;
  agentId: string;
  path: string;
};

type UploadHost = {
  capture: () => UploadTarget | null;
  isCurrent: (target: UploadTarget) => boolean;
  refresh: () => void;
  requestUpdate: () => void;
};

type UploadNotice = {
  state: "uploading" | "failed" | "unconfirmed" | "complete" | "stopped";
  path: string;
  names: string[];
  completed: number;
  error: string | null;
};

type UploadBatch = {
  target: UploadTarget;
  files: File[];
  notice: UploadNotice;
  abort: AbortController;
  retryable: boolean;
};

// Match the existing terminal encoder's guard before it reads browser file bytes.
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export class SessionWorkspaceUploadController {
  notice: UploadNotice | null = null;
  private batch: UploadBatch | null = null;

  constructor(private readonly host: UploadHost) {}

  get uploading(): boolean {
    return this.notice?.state === "uploading";
  }

  get retryable(): boolean {
    return this.notice?.state === "failed" && this.batch?.retryable === true;
  }

  sync(): void {
    if (this.batch && !this.host.isCurrent(this.batch.target)) {
      this.stop();
    }
  }

  selectFiles = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    this.uploadFiles(files);
  };

  uploadFiles(files: File[]): void {
    const target = this.host.capture();
    if (!files.length || !target || this.uploading) {
      return;
    }
    this.batch?.abort.abort();
    const notice: UploadNotice = {
      state: "uploading",
      path: target.path,
      names: files.map((file) => file.name),
      completed: 0,
      error: null,
    };
    const batch: UploadBatch = {
      target,
      files,
      notice,
      abort: new AbortController(),
      retryable: false,
    };
    this.batch = batch;
    this.notice = notice;
    this.host.requestUpdate();
    void this.run(batch);
  }

  private current(batch: UploadBatch): boolean {
    if (this.batch !== batch || batch.abort.signal.aborted) {
      return false;
    }
    if (!this.host.isCurrent(batch.target)) {
      this.stop();
      return false;
    }
    return true;
  }

  private async run(batch: UploadBatch): Promise<void> {
    try {
      while (batch.notice.completed < batch.files.length) {
        if (!this.current(batch)) {
          return;
        }
        const file = batch.files[batch.notice.completed];
        if (!file) {
          return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(t("chat.workspaceFiles.uploadTooLarge", { file: file.name }));
        }
        const contentBase64 = await encodeTerminalUpload(file);
        if (!this.current(batch)) {
          return;
        }
        await batch.target.client.request(
          "sessions.files.upload",
          {
            sessionKey: batch.target.sessionKey,
            agentId: batch.target.agentId,
            path: batch.target.path,
            name: file.name,
            contentBase64,
          },
          { signal: batch.abort.signal },
        );
        if (!this.current(batch)) {
          return;
        }
        batch.notice.completed += 1;
        this.host.requestUpdate();
      }
      batch.notice.state = "complete";
      this.batch = null;
    } catch (error) {
      if (!this.current(batch)) {
        return;
      }
      const gatewayError = error as {
        gatewayCode?: unknown;
        code?: unknown;
        details?: { type?: unknown };
        retryable?: unknown;
      } | null;
      const duplicate = gatewayError?.details?.type === "session_file_exists";
      const outcomeUnknown = formatGatewayRequestFailure(error).outcomeUnknown;
      batch.notice.state = outcomeUnknown ? "unconfirmed" : "failed";
      batch.notice.error = duplicate
        ? t("chat.workspaceFiles.uploadDuplicate")
        : error instanceof Error
          ? error.message
          : String(error);
      batch.retryable =
        !duplicate &&
        !outcomeUnknown &&
        (gatewayError?.retryable === true ||
          gatewayError?.gatewayCode === "UNAVAILABLE" ||
          gatewayError?.code === "UNAVAILABLE");
      if (!batch.retryable) {
        this.batch = null;
      }
    }
    this.host.refresh();
    this.host.requestUpdate();
  }

  retry = (): void => {
    const batch = this.batch;
    if (!batch || !this.retryable || !this.current(batch)) {
      return;
    }
    batch.notice.state = "uploading";
    batch.notice.error = null;
    batch.retryable = false;
    batch.abort = new AbortController();
    this.host.requestUpdate();
    void this.run(batch);
  };

  stop = (): void => {
    if (!this.batch) {
      return;
    }
    this.batch.abort.abort();
    this.batch.notice.state = "stopped";
    this.batch.notice.error = null;
    this.batch = null;
    this.host.refresh();
    this.host.requestUpdate();
  };

  dispose(): void {
    this.batch?.abort.abort();
    this.batch = null;
    this.notice = null;
  }
}

export function renderWorkspaceUploadAction(upload: SessionWorkspaceUploadController | undefined) {
  return upload
    ? keyed(
        upload,
        html`
          <input
            class="chat-workspace-upload__input"
            type="file"
            multiple
            hidden
            aria-label=${t("chat.workspaceFiles.upload")}
            ?disabled=${upload.uploading}
            @change=${upload.selectFiles}
          />
          <button
            class="btn btn--ghost btn--sm chat-workspace-rail__upload"
            type="button"
            title=${t("chat.workspaceFiles.uploadHint")}
            aria-label=${t("chat.workspaceFiles.upload")}
            ?disabled=${upload.uploading}
            @click=${(event: Event) => {
              const button = event.currentTarget as HTMLButtonElement;
              (button.previousElementSibling as HTMLInputElement | null)?.click();
            }}
          >
            ${icons.arrowUp}
          </button>
        `,
      )
    : nothing;
}

export function renderWorkspaceUploadNotice(upload: SessionWorkspaceUploadController | undefined) {
  const notice = upload?.notice;
  if (!notice) {
    return nothing;
  }
  const current = notice.names[notice.completed];
  const failed = notice.state === "failed" || notice.state === "unconfirmed";
  const title =
    notice.state === "uploading"
      ? t("chat.workspaceFiles.uploadProgress", {
          current: String(notice.completed + 1),
          total: String(notice.names.length),
        })
      : notice.state === "complete"
        ? t("chat.workspaceFiles.uploadComplete", { count: String(notice.completed) })
        : notice.state === "stopped"
          ? t("chat.workspaceFiles.uploadStopped")
          : notice.state === "unconfirmed"
            ? t("chat.workspaceFiles.uploadUnconfirmed")
            : t("chat.workspaceFiles.uploadFailed");
  return html`
    <div
      class="chat-workspace-upload ${failed ? "chat-workspace-upload--failed" : ""}"
      role=${failed ? "alert" : "status"}
      aria-live="polite"
    >
      <strong>${title}</strong>
      <div>
        ${t("chat.workspaceFiles.uploadDestination", {
          path: notice.path || t("chat.workspaceFiles.root"),
        })}
      </div>
      <div>
        ${t("chat.workspaceFiles.uploadCompletedCount", {
          count: String(notice.completed),
          total: String(notice.names.length),
        })}
      </div>
      ${current && notice.state !== "complete" ? html`<div>${current}</div>` : nothing}
      ${notice.completed > 0
        ? html`<div class="chat-workspace-upload__names">
            ${notice.names.slice(0, notice.completed).join(", ")}
          </div>`
        : nothing}
      ${notice.error ? html`<div>${notice.error}</div>` : nothing}
      ${notice.state === "uploading"
        ? html` <progress
              max=${notice.names.length}
              value=${notice.completed}
              aria-label=${title}
            ></progress>
            <button class="btn btn--ghost btn--sm" type="button" @click=${upload?.stop}>
              ${t("chat.workspaceFiles.stopUpload")}
            </button>`
        : nothing}
      ${upload?.retryable
        ? html`<button class="btn btn--ghost btn--sm" type="button" @click=${upload.retry}>
            ${t("terminal.retryUpload")}
          </button>`
        : nothing}
      ${notice.state === "stopped"
        ? html`<div>${t("chat.workspaceFiles.uploadStoppedHint")}</div>`
        : nothing}
      ${notice.state === "unconfirmed"
        ? html`<div>${t("chat.workspaceFiles.uploadUnconfirmedHint")}</div>`
        : nothing}
    </div>
  `;
}
