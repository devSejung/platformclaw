import { html } from "lit";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";

/** Load one global recovery owner independently of the lazy work-location settings. */
export function loadExecutionCredentialRecovery(options: {
  fetchImpl: typeof fetch;
  onUnauthenticated: () => void;
}) {
  return Promise.all([
    import("./execution-credential-recovery-element.ts"),
    loadPlatformClawLocale(),
  ])
    .then(
      () => html`<platformclaw-vm-recovery
        .fetchImpl=${options.fetchImpl}
        .onUnauthenticated=${options.onUnauthenticated}
      ></platformclaw-vm-recovery>`,
    )
    .catch(() => html`<p role="alert">${t("platformClaw.execution.recoveryLoadFailed")}</p>`);
}
