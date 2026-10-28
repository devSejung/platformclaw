import { render } from "lit";
import "../components/modal-dialog.ts";
import { i18n } from "../i18n/index.ts";
import { ExecutionCredentialRecovery } from "./execution-credential-recovery.ts";
import { requestExecutionSettings } from "./execution-settings-actions.ts";
import { loadPlatformClawLocale } from "./i18n.ts";

class PlatformClawVmRecoveryElement extends HTMLElement {
  private readonly root = this.attachShadow({ mode: "open" });
  private ready = false;
  private unsubscribeLocale = () => {};
  private readonly recovery = new ExecutionCredentialRecovery({
    root: this.root,
    request: <T>(path: string, init?: RequestInit) =>
      requestExecutionSettings<T>(
        (url, options) => this.fetchImpl(url, options),
        () => this.onUnauthenticated(),
        path,
        init,
      ),
    applySettings: (settings) => this.recovery.observe(settings),
    isBusy: () => !this.ready,
    render: () => this.render(),
  });

  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};

  connectedCallback(): void {
    this.recovery.connect();
    this.unsubscribeLocale = i18n.subscribe(() => void this.initialize(false));
    void this.initialize(true);
  }

  disconnectedCallback(): void {
    this.ready = false;
    this.unsubscribeLocale();
    this.recovery.disconnect();
  }

  private async initialize(refresh: boolean): Promise<void> {
    await loadPlatformClawLocale();
    if (!this.isConnected) {
      return;
    }
    this.ready = true;
    this.render();
    if (refresh) {
      await this.recovery.refresh();
    }
  }

  private render(): void {
    render(this.recovery.render(), this.root);
  }
}

if (!customElements.get("platformclaw-vm-recovery")) {
  customElements.define("platformclaw-vm-recovery", PlatformClawVmRecoveryElement);
}
