import { html, nothing, type ReactiveControllerHost } from "lit";
import { t } from "../../i18n/index.ts";
import { platformClawT } from "../../platformclaw/i18n.ts";
import {
  createPlatformClawSkillHubNamespace,
  loadPlatformClawSkillHubNamespaceScopes,
  PlatformClawSkillHubRequestError,
  type PlatformClawSkillHubConfig,
  type PlatformClawSkillHubMessage,
  type PlatformClawSkillHubNamespaceCreation,
  type PlatformClawSkillHubNamespaceScope,
} from "../../platformclaw/skill-hub.ts";
import { skillHubScopeKindLabel } from "./labels.ts";

export class SkillHubNamespaceController {
  private pending: {
    namespace: string;
    scopes: PlatformClawSkillHubNamespaceScope[];
    scope: PlatformClawSkillHubNamespaceScope | null;
    creations: PlatformClawSkillHubNamespaceCreation[];
  } | null = null;
  private loading = false;
  private saving = false;
  private error: string | null = null;
  private generation = 0;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      refresh: () => Promise<void>;
      setMessage: (message: PlatformClawSkillHubMessage | null) => void;
    },
  ) {}

  renderAction(config: PlatformClawSkillHubConfig | null) {
    return config?.capabilities?.namespaceCreate
      ? html`<button class="btn" @click=${() => this.open()}>
          ${platformClawT("platformClaw.skillHub.namespace.create")}
        </button>`
      : nothing;
  }

  private open() {
    if (this.saving) {
      return;
    }
    this.pending = { namespace: "", scopes: [], scope: null, creations: [] };
    this.options.setMessage(null);
    void this.loadScopes();
  }

  private close() {
    if (this.saving) {
      return;
    }
    this.generation += 1;
    this.pending = null;
    this.host.requestUpdate();
  }

  private async loadScopes() {
    const generation = ++this.generation;
    this.loading = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const { scopes, creations } = await loadPlatformClawSkillHubNamespaceScopes();
      if (this.pending && generation === this.generation) {
        this.pending.scopes = scopes;
        this.pending.creations = creations;
        this.pending.scope = scopes.find((scope) => scope.scopeKind === "global") ?? null;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = this.errorMessage(error);
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  private errorMessage(error: unknown) {
    if (error instanceof PlatformClawSkillHubRequestError) {
      if (error.details?.code === "skill-hub-namespace-invalid") {
        return platformClawT("platformClaw.skillHub.namespace.invalidName");
      }
      if (error.details?.code === "skill-hub-namespace-in-progress") {
        return platformClawT("platformClaw.skillHub.namespace.inProgress");
      }
      const errors: Partial<Record<number, string>> = {
        403: "forbidden",
        409: "conflict",
        503: "unavailable",
      };
      const key = errors[error.status];
      if (key) {
        return platformClawT(`platformClaw.skillHub.namespace.${key}`);
      }
    }
    if (error instanceof TypeError) {
      return platformClawT("platformClaw.skillHub.namespace.unavailable");
    }
    return error instanceof Error ? error.message : String(error);
  }

  renderDialog() {
    if (!this.pending) {
      return nothing;
    }
    const { namespace, scopes, scope, creations } = this.pending;
    const busy = this.loading || this.saving;
    return html`<openclaw-modal-dialog
      label=${platformClawT("platformClaw.skillHub.namespace.create")}
      @modal-cancel=${(event: Event) => {
        if (this.saving) {
          event.preventDefault();
        } else {
          this.close();
        }
      }}
    >
      <form
        class="skill-hub-dialog skill-hub-namespace"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void this.create();
        }}
      >
        <header class="skill-hub-dialog__header">
          <div>
            <h2>${platformClawT("platformClaw.skillHub.namespace.create")}</h2>
            <p>${platformClawT("platformClaw.skillHub.namespace.description")}</p>
          </div>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${this.saving}
            @click=${() => this.close()}
          >
            ${t("skillsPage.close")}
          </button>
        </header>
        <label class="field">
          <span>${t("skillsPage.skillHub.namespace")}</span>
          <input
            name="namespace"
            autofocus
            required
            .value=${namespace}
            ?disabled=${this.saving}
            @input=${(event: Event) => {
              this.pending!.namespace = (event.target as HTMLInputElement).value;
              this.host.requestUpdate();
            }}
          />
          <small>${platformClawT("platformClaw.skillHub.namespace.nameHelp")}</small>
        </label>
        <label class="field">
          <span>${platformClawT("platformClaw.skillHub.namespace.scope")}</span>
          <select
            name="scope"
            .value=${scope ? String(scopes.indexOf(scope)) : ""}
            ?disabled=${busy}
            @change=${(event: Event) => {
              this.pending!.scope =
                scopes[Number((event.target as HTMLSelectElement).value)] ?? null;
              this.host.requestUpdate();
            }}
          >
            <option value="" disabled ?selected=${scope === null}>
              ${platformClawT("platformClaw.skillHub.publish.chooseDestination")}
            </option>
            ${scopes.map(
              (item, index) => html`<option value=${index} ?selected=${item === scope}>
                ${item.scopeKind === "global"
                  ? platformClawT("platformClaw.skillHub.publish.global")
                  : `${skillHubScopeKindLabel(item.scopeKind)}: ${item.scopeName ?? item.scopeId}`}
              </option>`,
            )}
          </select>
        </label>
        ${this.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
        ${this.error ? html`<div class="callout danger" role="alert">${this.error}</div>` : nothing}
        ${!this.loading && !this.error && scopes.length === 0
          ? html`<p role="status">${platformClawT("platformClaw.skillHub.namespace.noScopes")}</p>`
          : nothing}
        ${creations.length
          ? html`<section>
              <h3>${platformClawT("platformClaw.skillHub.namespace.incomplete")}</h3>
              <ul>
                ${creations.map((creation) => {
                  const creationScope = scopes.find(
                    (item) =>
                      item.scopeKind === creation.scopeKind && item.scopeId === creation.scopeId,
                  );
                  return html`<li>
                    <strong>${creation.namespace}</strong>
                    <span
                      >${platformClawT(
                        creation.state === "failed"
                          ? "platformClaw.skillHub.namespace.failed"
                          : "platformClaw.skillHub.namespace.pending",
                      )}</span
                    >
                    <button
                      type="button"
                      class="btn btn--sm"
                      ?disabled=${busy || !creationScope}
                      @click=${() => {
                        this.pending!.namespace = creation.namespace;
                        this.pending!.scope = creationScope!;
                        this.error = null;
                        this.host.requestUpdate();
                      }}
                    >
                      ${platformClawT("platformClaw.skillHub.namespace.resume")}
                    </button>
                  </li>`;
                })}
              </ul>
            </section>`
          : nothing}
        ${!this.loading && scopes.length === 0
          ? html`<button type="button" class="btn" @click=${() => void this.loadScopes()}>
              ${t("common.reload")}
            </button>`
          : nothing}
        <button class="btn primary" type="submit" ?disabled=${busy || !scope || !namespace.trim()}>
          ${platformClawT(
            this.saving
              ? "platformClaw.skillHub.namespace.creating"
              : "platformClaw.skillHub.namespace.create",
          )}
        </button>
      </form>
    </openclaw-modal-dialog>`;
  }

  private async create() {
    if (!this.pending?.scope || !this.pending.namespace.trim() || this.loading || this.saving) {
      return;
    }
    const namespace = this.pending.namespace.trim().toLowerCase();
    const { scopeKind, scopeId } = this.pending.scope;
    this.saving = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      await createPlatformClawSkillHubNamespace({
        namespace,
        scopeKind,
        ...(scopeId ? { scopeId } : {}),
      });
      this.pending = null;
      // Creation succeeded before refreshing options. A refresh failure must not
      // invite another create request for a namespace that already exists.
      try {
        await this.options.refresh();
        this.options.setMessage({
          kind: "success",
          text: platformClawT("platformClaw.skillHub.namespace.created", { namespace }),
        });
      } catch {
        this.options.setMessage({
          kind: "warning",
          text: platformClawT("platformClaw.skillHub.namespace.createdReloadFailed", { namespace }),
        });
      }
    } catch (error) {
      this.error = this.errorMessage(error);
    } finally {
      this.saving = false;
      this.host.requestUpdate();
    }
  }
}
