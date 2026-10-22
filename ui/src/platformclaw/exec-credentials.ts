import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, render as renderTemplate } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../components/settings-ui.ts";
import { i18n } from "../i18n/index.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH,
  PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH,
} from "./web-contract.ts";
import "./exec-credentials.css";

type Definition = { envName: string; configured?: boolean; revision?: number };
type CredentialMutation = { action: "add" | "remove" | "replace"; envName: string; value?: string };
export type CredentialTarget = { requestId: string; envName: string; expectedAccountId: string };
export type PersonalCredentialSaved = { requestId: string; envName: string; revision: number };
type SaveAcknowledgement = { envName: string; revision: number; requestId?: string };

class CredentialRequestError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(key);
    this.key = key;
  }
}

function readDefinitions(value: unknown): Definition[] {
  if (!Array.isArray(value)) {
    throw new CredentialRequestError("platformClaw.execCredentials.failed");
  }
  return value.map((item) => {
    const definition = asRecord(item);
    if (!definition || typeof definition.envName !== "string") {
      throw new CredentialRequestError("platformClaw.execCredentials.failed");
    }
    return {
      envName: definition.envName,
      configured: definition.configured === true,
      revision: Number.isSafeInteger(definition.revision)
        ? (definition.revision as number)
        : undefined,
    };
  });
}

export class PlatformClawExecCredentialsElement extends HTMLElement {
  private definitions: Definition[] = [];
  private adminDefinitions: Definition[] = [];
  private accountId: string | null = null;
  private accountInvalid = false;
  private loading = true;
  private busy = "";
  private messageKey = "";
  private generation = 0;
  private cancelled = false;
  private focusedTarget = false;
  private currentTarget?: CredentialTarget;
  private pendingAcknowledgement?: SaveAcknowledgement;
  private readonly secretDrafts = new Map<string, string>();
  private unsubscribeLocale = () => {};
  admin = false;
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  onUnauthenticated: () => void = () => {};
  onPersonalSaved?: (ack: PersonalCredentialSaved) => void;
  onCancelFlow?: () => void;

  get target(): CredentialTarget | undefined {
    return this.currentTarget;
  }

  set target(value: CredentialTarget | undefined) {
    const previous = this.currentTarget;
    if (
      previous?.requestId === value?.requestId &&
      previous?.envName === value?.envName &&
      previous?.expectedAccountId === value?.expectedAccountId
    ) {
      return;
    }
    this.generation++;
    this.currentTarget = value ? { ...value } : undefined;
    this.secretDrafts.clear();
    this.pendingAcknowledgement = undefined;
    this.focusedTarget = false;
    this.cancelled = false;
    this.accountInvalid = false;
    this.busy = "";
    this.messageKey = "";
    if (this.isConnected) {
      void this.refresh();
    }
  }

  connectedCallback(): void {
    this.generation++;
    this.cancelled = false;
    this.unsubscribeLocale = i18n.subscribe(() => void this.initialize(false));
    void this.initialize(true);
  }

  disconnectedCallback(): void {
    this.generation++;
    this.unsubscribeLocale();
    this.secretDrafts.clear();
    this.pendingAcknowledgement = undefined;
    this.busy = "";
    // The detached password DOM must lose the value along with the volatile map.
    this.querySelectorAll<HTMLInputElement>("[data-value]").forEach((input) => {
      input.value = "";
    });
    renderTemplate(nothing, this);
  }

  private current(generation: number): boolean {
    return this.isConnected && !this.cancelled && this.generation === generation;
  }

  private async initialize(load: boolean): Promise<void> {
    const generation = this.generation;
    await loadPlatformClawLocale();
    if (!this.current(generation)) {
      return;
    }
    this.render();
    if (load) {
      await this.refresh();
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(path, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      throw new CredentialRequestError("platformClaw.execCredentials.sessionExpired");
    }
    if (response.status === 409) {
      throw new CredentialRequestError("platformClaw.credentialFlow.accountChanged");
    }
    // Never display server error text or JSON fragments: either could echo input.
    if (!response.ok) {
      throw new CredentialRequestError("platformClaw.execCredentials.failed");
    }
    const body = asRecord(await response.json());
    if (!body) {
      throw new CredentialRequestError("platformClaw.execCredentials.failed");
    }
    return body;
  }

  private fail(error: unknown, fallback = "platformClaw.execCredentials.failed"): void {
    this.messageKey = error instanceof CredentialRequestError ? error.key : fallback;
    if (
      this.messageKey === "platformClaw.credentialFlow.accountChanged" ||
      this.messageKey === "platformClaw.execCredentials.sessionExpired"
    ) {
      this.accountInvalid = true;
      this.secretDrafts.clear();
      this.pendingAcknowledgement = undefined;
      if (this.messageKey === "platformClaw.execCredentials.sessionExpired") {
        this.onUnauthenticated();
      }
    }
  }

  private async refresh(clearMessage = true): Promise<void> {
    const generation = this.generation;
    this.loading = true;
    this.render();
    try {
      const [personal, admin] = await Promise.all([
        this.request(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH),
        this.admin
          ? this.request(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH)
          : Promise.resolve({ definitions: [] }),
      ]);
      if (!this.current(generation)) {
        return;
      }
      if (typeof personal.accountId !== "string" || !personal.accountId) {
        throw new CredentialRequestError("platformClaw.execCredentials.failed");
      }
      if (
        (this.accountId !== null && this.accountId !== personal.accountId) ||
        (this.target && this.target.expectedAccountId !== personal.accountId)
      ) {
        throw new CredentialRequestError("platformClaw.credentialFlow.accountChanged");
      }
      this.accountId = personal.accountId;
      this.definitions = readDefinitions(personal.definitions);
      this.adminDefinitions = readDefinitions(admin.definitions);
      const allowedNames = new Set(this.definitions.map((definition) => definition.envName));
      for (const envName of this.secretDrafts.keys()) {
        if (!allowedNames.has(envName)) {
          this.secretDrafts.delete(envName);
        }
      }
      if (clearMessage) {
        this.messageKey = "";
      }
      const acknowledgement = this.pendingAcknowledgement;
      if (acknowledgement) {
        const definition = this.definitions.find(
          (item) => item.envName === acknowledgement.envName,
        );
        this.pendingAcknowledgement = undefined;
        if (!definition?.configured || definition.revision !== acknowledgement.revision) {
          this.messageKey = "platformClaw.credentialFlow.stateChanged";
        } else if (
          acknowledgement.requestId &&
          this.target?.requestId === acknowledgement.requestId
        ) {
          const confirmed = {
            requestId: acknowledgement.requestId,
            envName: acknowledgement.envName,
            revision: acknowledgement.revision,
          };
          // The confirmed save completes this handoff in place. Retire the
          // target without its setter's refresh so the saved status survives.
          this.currentTarget = undefined;
          this.focusedTarget = false;
          this.messageKey = "platformClaw.credentialFlow.saved";
          this.onPersonalSaved?.(confirmed);
        } else {
          this.messageKey = "platformClaw.execCredentials.saved";
        }
      }
    } catch (error) {
      if (this.current(generation)) {
        this.fail(error);
        if (this.pendingAcknowledgement && !this.accountInvalid) {
          this.messageKey = "platformClaw.credentialFlow.statusUnconfirmed";
        }
      }
    } finally {
      if (this.current(generation)) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async mutate(path: string, body: CredentialMutation): Promise<void> {
    if (
      this.loading ||
      this.busy ||
      this.accountInvalid ||
      this.cancelled ||
      this.pendingAcknowledgement
    ) {
      return;
    }
    const personal = path === PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH;
    const expectedAccountId = this.target?.expectedAccountId ?? this.accountId;
    if (
      personal &&
      (!expectedAccountId || !this.definitions.some((item) => item.envName === body.envName))
    ) {
      this.messageKey = "platformClaw.execCredentials.failed";
      this.render();
      return;
    }
    const generation = this.generation;
    this.busy = body.envName;
    this.messageKey = "";
    this.render();
    try {
      const result = await this.request(path, {
        method: "POST",
        body: JSON.stringify({ ...body, ...(personal ? { expectedAccountId } : {}) }),
      });
      if (!this.current(generation)) {
        return;
      }
      if (personal && body.action === "replace") {
        if (
          result.envName !== body.envName ||
          !Number.isSafeInteger(result.revision) ||
          (result.revision as number) < 1
        ) {
          throw new CredentialRequestError("platformClaw.credentialFlow.unconfirmed");
        }
        // An ACK clears the secret immediately; a failed GET cannot resurrect it.
        this.secretDrafts.delete(body.envName);
        const definition = this.definitions.find((item) => item.envName === body.envName);
        if (definition) {
          definition.configured = true;
        }
        this.pendingAcknowledgement = {
          envName: body.envName,
          revision: result.revision as number,
          ...(this.target?.envName === body.envName ? { requestId: this.target.requestId } : {}),
        };
      } else {
        this.messageKey = "platformClaw.execCredentials.saved";
        if (personal && body.action === "remove") {
          this.secretDrafts.delete(body.envName);
          const definition = this.definitions.find((item) => item.envName === body.envName);
          if (definition) {
            definition.configured = false;
          }
        }
      }
      await this.refresh(false);
    } catch (error) {
      if (this.current(generation)) {
        this.fail(error, personal ? "platformClaw.credentialFlow.unconfirmed" : undefined);
      }
    } finally {
      if (this.current(generation)) {
        this.busy = "";
        this.render();
      }
    }
  }

  private cancelFlow(): void {
    if (this.cancelled) {
      return;
    }
    this.generation++;
    this.cancelled = true;
    this.secretDrafts.clear();
    this.pendingAcknowledgement = undefined;
    this.busy = "";
    this.loading = false;
    this.render();
    this.onCancelFlow?.();
  }

  private renderCredential(item: Definition) {
    const draft = this.secretDrafts.get(item.envName) ?? "";
    const blocked = this.controlsBlocked;
    const inputBlocked =
      this.accountInvalid ||
      this.cancelled ||
      this.targetMissing ||
      this.busy === item.envName ||
      this.pendingAcknowledgement?.envName === item.envName;
    const status = draft
      ? "platformClaw.execCredentials.unsaved"
      : item.configured
        ? "platformClaw.execCredentials.configured"
        : "platformClaw.execCredentials.notConfigured";
    return renderSettingsRow({
      stacked: true,
      title: html`<span class="platformclaw-credential-heading"
        ><span>${item.envName}</span>${renderSettingsStatus({
          kind: draft ? "warn" : item.configured ? "ok" : "muted",
          label: t(status),
        })}</span
      >`,
      description:
        this.target?.envName === item.envName
          ? t("platformClaw.credentialFlow.targetHint", { envName: item.envName })
          : undefined,
      control: html`
        <form
          class="platformclaw-credential-form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            this.saveCredential(item.envName);
          }}
        >
          <input
            class="settings-input"
            data-value=${item.envName}
            aria-label=${item.envName}
            type="password"
            autocomplete="new-password"
            maxlength="32768"
            required
            placeholder=${item.configured
              ? "••••••••"
              : t("platformClaw.execCredentials.valuePlaceholder")}
            .value=${live(draft)}
            ?disabled=${inputBlocked}
            @input=${(event: Event) => {
              if (!this.cancelled && !this.accountInvalid) {
                this.secretDrafts.set(
                  item.envName,
                  (event.currentTarget as HTMLInputElement).value,
                );
                this.render();
              }
            }}
          />
          <button
            class="btn primary"
            data-action="save"
            data-env=${item.envName}
            ?disabled=${blocked || !draft.trim()}
          >
            ${t("platformClaw.execCredentials.save")}
          </button>
          ${item.configured
            ? html`<button
                type="button"
                class="btn"
                data-action="remove"
                data-env=${item.envName}
                ?disabled=${this.controlsBlocked}
                @click=${() =>
                  void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
                    action: "remove",
                    envName: item.envName,
                  })}
              >
                ${t("platformClaw.execCredentials.remove")}
              </button>`
            : nothing}
        </form>
      `,
    });
  }

  private saveCredential(envName: string): void {
    const value = this.secretDrafts.get(envName);
    if (!this.controlsBlocked && value?.trim()) {
      void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
        action: "replace",
        envName,
        value,
      });
    }
  }

  private renderAdministration() {
    return renderSettingsSection(
      {
        title: t("platformClaw.execCredentials.adminTitle"),
        description: t("platformClaw.execCredentials.adminIntro"),
      },
      html`
        ${renderSettingsRow({
          title: t("platformClaw.execCredentials.add"),
          stacked: true,
          control: html`
            <form
              class="platformclaw-credential-definition-form"
              data-admin-form
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                const form = event.currentTarget as HTMLFormElement;
                const envName = (form.elements.namedItem("envName") as HTMLInputElement).value;
                void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
                  action: "add",
                  envName,
                });
              }}
            >
              <input
                class="settings-input"
                name="envName"
                aria-label=${t("platformClaw.execCredentials.adminTitle")}
                autocomplete="off"
                maxlength="128"
                placeholder="OPENAI_API_KEY"
                required
                ?disabled=${this.controlsBlocked}
              />
              <button class="btn primary" ?disabled=${this.controlsBlocked}>
                ${t("platformClaw.execCredentials.add")}
              </button>
            </form>
          `,
        })}
        ${repeat(
          this.adminDefinitions,
          (item) => item.envName,
          (item) =>
            renderSettingsRow({
              title: item.envName,
              control: html`
                <button
                  class="btn"
                  data-action="remove-definition"
                  data-env=${item.envName}
                  ?disabled=${this.controlsBlocked}
                  @click=${() =>
                    void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
                      action: "remove",
                      envName: item.envName,
                    })}
                >
                  ${t("platformClaw.execCredentials.remove")}
                </button>
              `,
            }),
        )}
      `,
    );
  }

  private get targetMissing(): boolean {
    return (
      Boolean(this.target) &&
      !this.loading &&
      !this.definitions.some((item) => item.envName === this.target?.envName)
    );
  }

  private get controlsBlocked(): boolean {
    return (
      this.loading ||
      Boolean(this.busy) ||
      this.accountInvalid ||
      this.cancelled ||
      Boolean(this.pendingAcknowledgement) ||
      this.targetMissing
    );
  }

  private renderFlow() {
    return this.target
      ? renderSettingsSection(
          {},
          renderSettingsRow({
            title: t(
              this.targetMissing || this.cancelled
                ? "platformClaw.credentialFlow.expired"
                : "platformClaw.credentialFlow.targetHint",
              { envName: this.target.envName },
            ),
            control: html`
              <button
                type="button"
                class="btn"
                data-flow-cancel
                ?disabled=${this.cancelled}
                @click=${() => this.cancelFlow()}
              >
                ${t("platformClaw.credentialFlow.later")}
              </button>
            `,
          }),
        )
      : nothing;
  }

  private render(): void {
    if (!this.isConnected) {
      return;
    }
    // Keyed Lit rows retain the actual input nodes and caret while sibling saves complete.
    renderTemplate(
      html`
        ${this.renderFlow()}
        ${renderSettingsSection(
          {
            title: t("platformClaw.execCredentials.title"),
            description: html`${t("platformClaw.execCredentials.intro")}
            ${t("platformClaw.execCredentials.replaceHelp")}`,
          },
          this.definitions.length
            ? repeat(
                this.definitions,
                (item) => item.envName,
                (item) => this.renderCredential(item),
              )
            : renderSettingsEmpty(
                t(this.loading ? "common.loading" : "platformClaw.execCredentials.empty"),
              ),
        )}
        ${this.admin ? this.renderAdministration() : nothing}
        ${this.pendingAcknowledgement && !this.loading && !this.busy
          ? html`<button
              type="button"
              class="btn"
              data-recheck
              @click=${() => void this.refresh(false)}
            >
              ${t("platformClaw.credentialFlow.recheckStatus")}
            </button>`
          : nothing}
        ${this.messageKey
          ? html`<p class="settings-page__intro" role="status" aria-live="polite">
              ${t(this.messageKey)}
            </p>`
          : nothing}
      `,
      this,
    );
    if (!this.focusedTarget && !this.controlsBlocked && this.target) {
      const input = [...this.querySelectorAll<HTMLInputElement>("[data-value]")].find(
        (candidate) => candidate.dataset.value === this.target?.envName,
      );
      if (input) {
        input.scrollIntoView?.({ block: "center" });
        input.focus();
        this.focusedTarget = true;
      }
    }
  }
}

if (!customElements.get("platformclaw-exec-credentials")) {
  customElements.define("platformclaw-exec-credentials", PlatformClawExecCredentialsElement);
}
