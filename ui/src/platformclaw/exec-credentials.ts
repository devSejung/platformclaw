import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, render as renderTemplate } from "lit";
import { renderSettingsRow, renderSettingsSection } from "../components/settings-ui.ts";
import { i18n } from "../i18n/index.ts";
import {
  createCredentialDraft,
  createCredentialSelection,
  readCredentialDefinitions,
  readPersonalCredentialDefinitions,
  type CredentialDefinition,
  type CredentialDraft,
  type PersonalCredentialDefinition,
} from "./exec-credentials-model.ts";
import { renderCredentialWorkspace } from "./exec-credentials-view.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import {
  PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH,
  PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH,
} from "./web-contract.ts";
import "./exec-credentials.css";

export type CredentialTarget = { requestId: string; envName: string; expectedAccountId: string };
export type PersonalCredentialSaved = {
  requestId: string;
  envName: string;
  revision: number;
  definitionToken: string;
  credentialToken: string;
};
type SaveAcknowledgement = Omit<PersonalCredentialSaved, "requestId"> & { requestId?: string };
type CredentialMutation = {
  action: "add" | "remove" | "replace";
  envName: string;
  value?: string;
  expectedDefinitionToken?: string;
  expectedCredentialToken?: string | null;
};

class CredentialRequestError extends Error {
  constructor(
    readonly key: string,
    readonly conflict = false,
  ) {
    super(key);
  }
}

export class PlatformClawExecCredentialsElement extends HTMLElement {
  private definitions: PersonalCredentialDefinition[] = [];
  private adminDefinitions: CredentialDefinition[] = [];
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
  private readonly drafts = new Map<string, CredentialDraft>();
  private readonly selections = {
    personal: createCredentialSelection(),
    administration: createCredentialSelection(),
  };
  private tab: "personal" | "administration" = "personal";
  private definitionName = "";
  private creatingDefinition = false;
  private confirmation: CredentialDefinition | null = null;
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
    this.clearSecrets();
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
    this.clearSecrets();
    this.confirmation = null;
    this.busy = "";
    this.definitionName = "";
    renderTemplate(nothing, this);
  }
  private clearSecrets(): void {
    this.drafts.clear();
    this.pendingAcknowledgement = undefined;
    // Retained editor nodes must lose plaintext when their account/request owner ends.
    this.querySelectorAll<HTMLInputElement>("[data-value]").forEach((input) => {
      input.value = "";
    });
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
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...init,
    });
    if (response.status === 401) {
      throw new CredentialRequestError("platformClaw.execCredentials.sessionExpired");
    }
    const body = asRecord(await response.json());
    if (response.status === 409) {
      if (body?.code === "credential-changed") {
        throw new CredentialRequestError("platformClaw.execCredentials.conflict", true);
      }
      throw new CredentialRequestError("platformClaw.credentialFlow.accountChanged");
    }
    // Server messages may echo a supplied secret. Render only owner-held translation keys.
    if (!response.ok || !body) {
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
      this.clearSecrets();
      this.confirmation = null;
      if (this.messageKey === "platformClaw.execCredentials.sessionExpired") {
        this.onUnauthenticated();
      }
    }
  }
  private draft(envName: string): CredentialDraft {
    let draft = this.drafts.get(envName);
    if (!draft) {
      const definition = this.definitions.find((item) => item.envName === envName);
      if (!definition) {
        throw new Error("credential definition unavailable");
      }
      draft = createCredentialDraft(definition);
      this.drafts.set(envName, draft);
    }
    return draft;
  }
  private adoptDefinitions(definitions: PersonalCredentialDefinition[], reloadEnv?: string): void {
    const allowed = new Set(definitions.map((item) => item.envName));
    for (const envName of this.drafts.keys()) {
      if (!allowed.has(envName) || envName === reloadEnv) {
        this.drafts.delete(envName);
      }
    }
    this.definitions = definitions;
    for (const item of definitions) {
      const draft = this.drafts.get(item.envName);
      if (!draft || (!draft.value && !draft.conflict)) {
        const next = createCredentialDraft(item);
        if (draft) {
          next.message = draft.message;
          next.error = draft.error;
        }
        this.drafts.set(item.envName, next);
      } else if (
        draft.definitionToken !== item.definitionToken ||
        draft.credentialToken !== item.credentialToken
      ) {
        // The user's draft keeps the snapshot it was edited against, including delete/recreate.
        draft.conflict = true;
        draft.error = "platformClaw.execCredentials.conflict";
      }
    }
    const selection = this.selections.personal;
    if (!selection.selected || !allowed.has(selection.selected)) {
      selection.selected = definitions[0]?.envName ?? null;
    }
    if (this.target && !this.focusedTarget && allowed.has(this.target.envName)) {
      this.tab = "personal";
      this.selections.personal = {
        ...createCredentialSelection(),
        selected: this.target.envName,
        page: Math.floor(
          definitions.findIndex((item) => item.envName === this.target?.envName) / 8,
        ),
      };
    }
  }
  private matchesAcknowledgement(ack: SaveAcknowledgement): boolean {
    const definition = this.definitions.find((item) => item.envName === ack.envName);
    return (
      definition?.configured === true &&
      definition.revision === ack.revision &&
      definition.definitionToken === ack.definitionToken &&
      definition.credentialToken === ack.credentialToken
    );
  }
  private async refresh(clearMessage = true, reloadEnv?: string): Promise<void> {
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
      const definitions = readPersonalCredentialDefinitions(personal.definitions);
      const adminDefinitions = readCredentialDefinitions(admin.definitions);
      this.accountId = personal.accountId;
      this.adoptDefinitions(definitions, reloadEnv);
      this.adminDefinitions = adminDefinitions;
      if (
        !adminDefinitions.some((item) => item.envName === this.selections.administration.selected)
      ) {
        this.selections.administration.selected = adminDefinitions[0]?.envName ?? null;
      }
      if (clearMessage) {
        this.messageKey = "";
      }
      const acknowledgement = this.pendingAcknowledgement;
      if (acknowledgement) {
        this.pendingAcknowledgement = undefined;
        const draft = this.drafts.get(acknowledgement.envName);
        if (!this.matchesAcknowledgement(acknowledgement)) {
          if (draft) {
            draft.conflict = true;
            draft.error = "platformClaw.credentialFlow.stateChanged";
          }
        } else if (
          acknowledgement.requestId &&
          this.target?.requestId === acknowledgement.requestId
        ) {
          const confirmed = { ...acknowledgement, requestId: acknowledgement.requestId };
          // Retire the handoff without its setter refresh so the confirmed status survives.
          this.currentTarget = undefined;
          this.focusedTarget = false;
          if (draft) {
            draft.message = "platformClaw.credentialFlow.saved";
          }
          this.onPersonalSaved?.(confirmed);
        } else if (draft) {
          draft.message = "platformClaw.execCredentials.saved";
        }
      }
    } catch (error) {
      if (this.current(generation)) {
        this.fail(error);
        if (this.pendingAcknowledgement && !this.accountInvalid) {
          this.messageKey = "";
        }
      }
    } finally {
      if (this.current(generation)) {
        this.loading = false;
        this.render();
      }
    }
  }
  private async reloadCredential(envName: string): Promise<void> {
    if (this.controlsBlocked) {
      return;
    }
    const generation = this.generation;
    // Reload discards this editor only. Block its input until the awaited snapshot is adopted.
    this.busy = envName;
    try {
      await this.refresh(true, envName);
    } finally {
      if (this.current(generation)) {
        this.busy = "";
        this.render();
      }
    }
  }
  private async mutate(path: string, body: CredentialMutation): Promise<boolean> {
    if (this.controlsBlocked) {
      return false;
    }
    const expectedAccountId = this.target?.expectedAccountId ?? this.accountId;
    const personal = path === PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH;
    if (
      !expectedAccountId ||
      (personal && !this.definitions.some((item) => item.envName === body.envName))
    ) {
      this.messageKey = "platformClaw.execCredentials.failed";
      this.render();
      return false;
    }
    const generation = this.generation;
    this.busy = body.envName;
    this.messageKey = "";
    const draft = personal ? this.draft(body.envName) : undefined;
    if (draft) {
      draft.error = "";
      draft.message = "";
    }
    this.render();
    try {
      const result = await this.request(path, {
        method: "POST",
        body: JSON.stringify({ ...body, expectedAccountId }),
      });
      if (!this.current(generation)) {
        return false;
      }
      if (personal && body.action === "replace") {
        if (
          result.envName !== body.envName ||
          !Number.isSafeInteger(result.revision) ||
          (result.revision as number) < 1 ||
          typeof result.definitionToken !== "string" ||
          typeof result.credentialToken !== "string"
        ) {
          throw new CredentialRequestError("platformClaw.credentialFlow.unconfirmed");
        }
        // A confirmed POST clears only its own plaintext. Other editor drafts and target ACK survive.
        if (draft) {
          draft.value = "";
        }
        this.pendingAcknowledgement = {
          envName: body.envName,
          revision: result.revision as number,
          definitionToken: result.definitionToken,
          credentialToken: result.credentialToken,
          ...(this.target?.envName === body.envName ? { requestId: this.target.requestId } : {}),
        };
      } else {
        if (personal) {
          this.drafts.delete(body.envName);
        }
        if (!personal && body.action === "add") {
          this.definitionName = "";
        }
        this.messageKey = "platformClaw.execCredentials.saved";
      }
      await this.refresh(false);
      return true;
    } catch (error) {
      if (this.current(generation)) {
        if (
          personal &&
          !(
            error instanceof CredentialRequestError &&
            (error.key === "platformClaw.credentialFlow.accountChanged" ||
              error.key === "platformClaw.execCredentials.sessionExpired")
          )
        ) {
          if (draft) {
            draft.error =
              error instanceof CredentialRequestError
                ? error.key
                : "platformClaw.credentialFlow.unconfirmed";
            draft.conflict = error instanceof CredentialRequestError && error.conflict;
          }
        } else if (!personal && error instanceof CredentialRequestError && error.conflict) {
          this.messageKey = "platformClaw.execCredentials.definitionConflict";
        } else {
          this.fail(error, personal ? "platformClaw.credentialFlow.unconfirmed" : undefined);
        }
      }
      return false;
    } finally {
      if (this.current(generation)) {
        this.busy = "";
        this.render();
      }
    }
  }
  private saveCredential(envName: string): void {
    const draft = this.draft(envName);
    if (!draft.conflict && draft.value.trim()) {
      void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
        action: "replace",
        envName,
        value: draft.value,
        expectedDefinitionToken: draft.definitionToken,
        expectedCredentialToken: draft.credentialToken,
      });
    }
  }
  private removeCredential(envName: string): void {
    const draft = this.draft(envName);
    if (!draft.conflict) {
      void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
        action: "remove",
        envName,
        expectedDefinitionToken: draft.definitionToken,
        expectedCredentialToken: draft.credentialToken,
      });
    }
  }
  private cancelFlow(): void {
    if (this.cancelled) {
      return;
    }
    this.generation++;
    this.cancelled = true;
    this.clearSecrets();
    this.busy = "";
    this.loading = false;
    this.render();
    this.onCancelFlow?.();
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
            control: html`<button
              type="button"
              class="btn"
              data-flow-cancel
              ?disabled=${this.cancelled}
              @click=${() => this.cancelFlow()}
            >
              ${t("platformClaw.credentialFlow.later")}
            </button>`,
          }),
        )
      : nothing;
  }
  private render(): void {
    if (!this.isConnected) {
      return;
    }
    const selection = this.selections[this.tab];
    renderTemplate(
      renderCredentialWorkspace({
        admin: this.admin,
        tab: this.tab,
        definitions: this.definitions,
        adminDefinitions: this.adminDefinitions,
        selection,
        blocked: this.controlsBlocked,
        inputBlocked: this.accountInvalid || this.cancelled || this.targetMissing,
        loading: this.loading,
        busy: this.busy,
        pendingEnv: this.pendingAcknowledgement?.envName,
        message: this.messageKey,
        flow: this.renderFlow(),
        definitionName: this.definitionName,
        creating: this.creatingDefinition,
        confirmation: this.confirmation,
        draft: (envName) => this.draft(envName),
        onTab: (tab) => {
          this.tab = tab;
          this.render();
        },
        onSelect: (envName) => {
          selection.selected = envName;
          selection.picking = false;
          if (this.tab === "administration") {
            this.creatingDefinition = false;
          }
          this.render();
        },
        onFilter: (patch) => {
          Object.assign(selection, patch);
          this.render();
        },
        onInput: (envName, value) => {
          if (!this.cancelled && !this.accountInvalid) {
            const draft = this.draft(envName);
            draft.value = value;
            draft.message = "";
            if (!draft.conflict) {
              draft.error = "";
            }
            this.render();
          }
        },
        onSave: (envName) => this.saveCredential(envName),
        onRemove: (envName) => this.removeCredential(envName),
        onReload: (envName) => void this.reloadCredential(envName),
        onRecheck: () => void this.refresh(false),
        onCreate: () => {
          this.creatingDefinition = true;
          selection.picking = false;
          this.render();
        },
        onDefinitionName: (value) => {
          this.definitionName = value;
          this.render();
        },
        onAddDefinition: () =>
          void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
            action: "add",
            envName: this.definitionName.trim(),
          }),
        onRemoveDefinition: (envName) => {
          const definition = this.adminDefinitions.find((item) => item.envName === envName);
          this.confirmation = definition ? { ...definition } : null;
          this.messageKey = "";
          this.render();
        },
        onConfirmRemoval: () => {
          const confirmation = this.confirmation;
          if (confirmation) {
            void this.mutate(PLATFORMCLAW_EXEC_CREDENTIALS_ADMIN_API_PATH, {
              action: "remove",
              envName: confirmation.envName,
              expectedDefinitionToken: confirmation.definitionToken,
            }).then((removed) => {
              if (removed && this.confirmation === confirmation) {
                this.confirmation = null;
                this.render();
              }
            });
          }
        },
        onCancelRemoval: () => {
          if (!this.busy) {
            this.confirmation = null;
            this.render();
          }
        },
        onReloadDefinitions: () => {
          if (this.controlsBlocked) {
            return;
          }
          const generation = this.generation;
          const confirmation = this.confirmation;
          void this.refresh().then(() => {
            // A new definition needs a new destructive confirmation, not an updated old token.
            if (
              this.current(generation) &&
              !this.messageKey &&
              this.confirmation === confirmation
            ) {
              this.confirmation = null;
              this.render();
            }
          });
        },
      }),
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
