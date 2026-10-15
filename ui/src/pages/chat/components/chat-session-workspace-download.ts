import type { SessionsFilesDownloadResult } from "../../../../../packages/gateway-protocol/src/index.js";
import {
  MAX_TERMINAL_UPLOAD_BASE64_LENGTH,
  MAX_TERMINAL_UPLOAD_BYTES,
} from "../../../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";

type DownloadTarget = { client: GatewayBrowserClient; sessionKey: string; agentId: string };

export class SessionWorkspaceDownloadController {
  busy = false;
  error: string | null = null;
  private generation = 0;

  constructor(
    private readonly host: {
      capture: () => DownloadTarget | null;
      isCurrent: (target: DownloadTarget) => boolean;
      requestUpdate: () => void;
    },
  ) {}

  dispose() {
    this.generation += 1;
    this.busy = false;
    this.error = null;
  }

  async download(path: string) {
    const target = this.host.capture();
    if (!target || this.busy) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const result = await target.client.request<SessionsFilesDownloadResult>(
        "sessions.files.download",
        { sessionKey: target.sessionKey, agentId: target.agentId, path },
      );
      // Never save a completed response after its pane changes session or client.
      if (generation !== this.generation || !this.host.isCurrent(target)) {
        return;
      }
      const file = result?.file;
      if (
        !file ||
        result.sessionKey !== target.sessionKey ||
        file.path !== path ||
        file.size < 0 ||
        file.size > MAX_TERMINAL_UPLOAD_BYTES ||
        file.contentBase64.length > MAX_TERMINAL_UPLOAD_BASE64_LENGTH
      ) {
        throw new Error(t("chat.workspaceFiles.downloadFailed"));
      }
      const binary = atob(file.contentBase64);
      if (binary.length !== file.size) {
        throw new Error(t("chat.workspaceFiles.downloadFailed"));
      }
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const leaf = file.name
        .split(/[\\/]/)
        .at(-1)
        ?.split("")
        .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
        .join("");
      const filename = leaf && leaf !== "." && leaf !== ".." ? leaf : "download";
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.append(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
        }
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (error) {
      if (generation === this.generation && this.host.isCurrent(target)) {
        const details = error instanceof GatewayRequestError ? error.details : null;
        this.error =
          details &&
          typeof details === "object" &&
          (details as { type?: unknown }).type === "session_file_too_large"
            ? t("chat.workspaceFiles.downloadTooLarge", { file: path })
            : `${t("chat.workspaceFiles.downloadFailed")}: ${error instanceof Error ? error.message : String(error)}`;
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
      this.host.requestUpdate();
    }
  }
}
