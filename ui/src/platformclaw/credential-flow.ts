import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { isSpaceConversationSession } from "../../../packages/platformclaw-control-plane/src/space-contracts.js";
import type { RouteId } from "../app-route-paths.ts";
import { selectApplicationSession } from "../app/agent-selection.ts";
import type { ApplicationChatToolResult, ApplicationContext } from "../app/context.ts";
import type { ChatAccessoryHost } from "../lib/chat/chat-types.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import {
  parseAgentSessionKey,
  resolveUiSelectedSessionAgentId,
} from "../lib/sessions/session-key.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history.ts";
import { readCredentialFlowAction } from "./exec-credentials-model.ts";
import type {
  PersonalCredentialSaved,
  PlatformClawExecCredentialsElement,
} from "./exec-credentials.ts";
import { platformClawT as t } from "./i18n.ts";
import type { PlatformClawSessionIdentity } from "./web-contract.ts";
import { PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH } from "./web-contract.ts";

const FLOW_TTL_MS = 30 * 60_000;

type FlowIdentity = {
  requestId: string;
  targetKey: string;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
  sourceUserTurnId: string;
  expiresAt: number;
};

type PendingFlow = FlowIdentity &
  (
    | { phase: "awaiting-source"; sessionId?: string }
    | { phase: "required" | "editing"; sessionId: string; expectedLeafEntryId: string }
    | {
        phase: "saved" | "submitting";
        sessionId: string;
        expectedLeafEntryId: string;
        revision: number;
        definitionToken: string;
        credentialToken: string;
      }
  );

type FlowState =
  | PendingFlow
  | { phase: "submitted"; requestId: string }
  | {
      phase: "inactive";
      reason: "expired" | "accountChanged";
      sessionKey: string;
      agentId: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function latestUserTurn(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = record(messages[i]);
    if (message?.role !== "user") {
      continue;
    }
    const meta = record(message["__openclaw"]);
    for (const id of [meta?.idempotencyKey, message.messageId, meta?.id, message.id]) {
      if (typeof id === "string" && id.trim()) {
        return id.trim();
      }
    }
    return typeof message.timestamp === "number" ? `timestamp:${message.timestamp}` : null;
  }
  return null;
}

/** One in-memory handoff. Secret values belong exclusively to the existing form. */
export class PlatformClawCredentialFlow {
  private application: ApplicationContext<RouteId> | null = null;
  private stopGateway: (() => void) | null = null;
  private owner: { client: object; hello: object } | null = null;
  private host: ChatAccessoryHost | null = null;
  private state: FlowState | null = null;
  private busy = false;
  private error: "unconfirmed" | "expired" | null = null;
  private probeKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private route: RouteId = "chat";
  private form: PlatformClawExecCredentialsElement | null = null;
  private focusOnReturn = false;
  private generation = 0;
  private lastRequestId: string | null = null;

  constructor(
    private readonly identity: PlatformClawSessionIdentity,
    private readonly fetchImpl: typeof fetch,
    private readonly loadIdentity: () => Promise<PlatformClawSessionIdentity | null>,
  ) {}

  attach(application: ApplicationContext<RouteId>): void {
    if (this.application === application) {
      return;
    }
    this.stopGateway?.();
    this.application = application;
    this.stopGateway = application.gateway.subscribe((snapshot) => {
      if (
        this.owner &&
        (snapshot.phase !== "connected" ||
          snapshot.client !== this.owner.client ||
          snapshot.hello !== this.owner.hello)
      ) {
        this.invalidate("expired");
      }
    });
  }

  visit(route: RouteId): void {
    if (route === this.route) {
      return;
    }
    this.route = route;
    const state = this.pending();
    if (!state) {
      return;
    }
    if (
      (route !== "chat" && route !== "credentials") ||
      (route === "chat" && state.phase === "editing")
    ) {
      this.invalidate("expired");
    }
  }

  visitConversation(data: unknown): void {
    const state = this.pending();
    const route = record(data);
    if (
      state &&
      route?.kind === "session" &&
      (route.sessionKey !== state.sessionKey || (route.agentId && route.agentId !== state.agentId))
    ) {
      this.invalidate("expired");
    }
  }

  bindForm = (element: Element | undefined): void => {
    this.form = (element as PlatformClawExecCredentialsElement | undefined) ?? null;
    if (this.form) {
      this.form.target = this.target;
    }
  };

  capture(host: ChatAccessoryHost, result: ApplicationChatToolResult): void {
    const action = readCredentialFlowAction(result.details);
    const agentId = resolveUiSelectedSessionAgentId(host);
    const parsed = parseAgentSessionKey(host.sessionKey);
    const gateway = this.application?.gateway.snapshot;
    if (
      !action ||
      result.name !== "platformclaw_credentials" ||
      host.chatRunId !== result.runId ||
      result.sessionKey !== host.sessionKey ||
      !host.connected ||
      !result.runId ||
      agentId !== this.identity.agentId ||
      (parsed && parsed.agentId !== agentId) ||
      (result.agentId && result.agentId !== agentId) ||
      isSpaceConversationSession(host.sessionKey) ||
      /:(?:subagent|acp|cron):/iu.test(host.sessionKey) ||
      host.sessionKey.startsWith("catalog:") ||
      !gateway?.client ||
      !gateway.hello
    ) {
      return;
    }
    if (this.lastRequestId === action.requestId) {
      return;
    }
    this.clearTimer();
    this.generation++;
    this.busy = false;
    this.host = host;
    this.lastRequestId = action.requestId;
    this.owner = { client: gateway.client, hello: gateway.hello };
    this.state = {
      ...action,
      phase: "awaiting-source",
      agentId,
      sessionKey: host.sessionKey,
      ...(host.currentSessionId ? { sessionId: host.currentSessionId } : {}),
      sourceRunId: result.runId,
      // The pending user row can still live only in the chat projection here.
      // chat.send's run id is the persisted user turn's idempotency key.
      sourceUserTurnId: result.runId,
      expiresAt: Date.now() + FLOW_TTL_MS,
    };
    this.error = null;
    this.probeKey = null;
    this.timer = setTimeout(() => this.invalidate("expired"), FLOW_TTL_MS);
    host.requestUpdate?.();
  }

  get target(): { requestId: string; envName: string; expectedAccountId: string } | undefined {
    const state = this.pending();
    return state && (state.phase === "editing" || state.phase === "saved")
      ? {
          requestId: state.requestId,
          envName: state.targetKey,
          expectedAccountId: this.identity.accountId,
        }
      : undefined;
  }

  saved = (ack: PersonalCredentialSaved): void => {
    const state = this.pending();
    if (
      (state?.phase !== "editing" && state?.phase !== "saved") ||
      ack.requestId !== state.requestId ||
      ack.envName !== state.targetKey ||
      !Number.isSafeInteger(ack.revision) ||
      ack.revision <= 0 ||
      !ack.definitionToken ||
      !ack.credentialToken ||
      !this.connectionCurrent()
    ) {
      return;
    }
    this.state = {
      ...state,
      phase: "saved",
      revision: ack.revision,
      definitionToken: ack.definitionToken,
      credentialToken: ack.credentialToken,
    };
    this.host?.requestUpdate?.();
  };

  cancel = (): void => {
    const state = this.pending();
    this.invalidate("expired");
    if (state && this.route === "credentials" && this.application) {
      selectApplicationSession({
        selection: this.application.agentSelection,
        gateway: this.application.gateway,
        agentId: state.agentId,
        sessionKey: state.sessionKey,
      });
      this.application.navigate(
        "chat",
        sessionNavigationTarget({
          context: this.application,
          face: "chat",
          sessionKey: state.sessionKey,
          agentId: state.agentId,
        }).options,
      );
    }
  };

  returnToConversation = async (): Promise<void> => {
    const state = this.pending();
    if (!state || this.busy || !this.application) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    try {
      if (!(await this.checkIdentity(state)) || !(await this.readSource(state))) {
        return;
      }
      if (this.state !== state) {
        return;
      }
      selectApplicationSession({
        selection: this.application.agentSelection,
        gateway: this.application.gateway,
        agentId: state.agentId,
        sessionKey: state.sessionKey,
      });
      this.focusOnReturn = true;
      this.application.navigate(
        "chat",
        sessionNavigationTarget({
          context: this.application,
          face: "chat",
          sessionKey: state.sessionKey,
          agentId: state.agentId,
        }).options,
      );
    } catch {
      if (generation === this.generation) {
        this.error = "unconfirmed";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
      this.host?.requestUpdate?.();
    }
  };

  render(host: ChatAccessoryHost): unknown {
    const state = this.state;
    if (!state || state.phase === "submitted") {
      return nothing;
    }
    if (
      state.sessionKey !== host.sessionKey ||
      state.agentId !== resolveUiSelectedSessionAgentId(host)
    ) {
      return nothing;
    }
    this.host = host;
    const pending = this.pending();
    if (pending && !host.chatLoading && host.currentSessionId && !this.hostCurrent(host, pending)) {
      this.invalidate("expired");
    }
    const current = this.state;
    if (!current || current.phase === "submitted") {
      return nothing;
    }
    if (current.phase === "awaiting-source" && !host.chatRunId && !host.chatLoading && !this.busy) {
      const probeKey = `${host.currentSessionId}:${host.chatDisplayedLeafEntryId ?? ""}:${latestUserTurn(host.chatMessages) ?? ""}`;
      if (this.probeKey !== probeKey) {
        this.probeKey = probeKey;
        void this.confirmSource(current);
      }
    }
    const saved = current.phase === "saved" || current.phase === "submitting";
    const inactive = current.phase === "inactive";
    const disabled =
      this.busy ||
      host.chatLoading ||
      !host.currentSessionId ||
      Boolean(host.chatRunId) ||
      host.chatSending ||
      host.chatQueue.length > 0;
    return html`
      <section
        class="card pc-credential-flow"
        data-credential-flow=${current.phase}
        aria-live="polite"
      >
        <style>
          .pc-credential-flow {
            margin: 0 0 12px;
            padding: 14px 16px;
            border: 1px solid var(--border);
            border-radius: 12px;
          }
          .pc-credential-flow p {
            margin: 6px 0 10px;
          }
          .pc-credential-flow__actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }
          .pc-credential-flow code {
            overflow-wrap: anywhere;
          }
        </style>
        <strong
          tabindex="-1"
          ${ref((element) => {
            if (element instanceof HTMLElement && this.focusOnReturn && saved) {
              this.focusOnReturn = false;
              element.focus();
            }
          })}
          >${t(
            `platformClaw.credentialFlow.${inactive ? current.reason : saved ? "saved" : "requiredTitle"}`,
          )}</strong
        >
        ${inactive
          ? nothing
          : html`<p>
                ${t("platformClaw.credentialFlow.requiredBody", { envName: current.targetKey })}
              </p>
              <code>${current.targetKey}</code>`}
        ${saved
          ? html`<p class="muted">${t("platformClaw.credentialFlow.continueHint")}</p>`
          : nothing}
        ${this.error
          ? html`<p role="status">${t(`platformClaw.credentialFlow.${this.error}`)}</p>`
          : nothing}
        <div class="pc-credential-flow__actions">
          ${current.phase === "required" || current.phase === "editing"
            ? html`<button
                class="btn primary"
                ?disabled=${disabled}
                @click=${() => void this.configure(current)}
              >
                ${t("platformClaw.credentialFlow.configure")}
              </button>`
            : nothing}
          ${current.phase === "awaiting-source"
            ? html`<button
                class="btn"
                ?disabled=${disabled}
                @click=${() => void this.confirmSource(current)}
              >
                ${t("platformClaw.credentialFlow.recheckStatus")}
              </button>`
            : nothing}
          ${saved
            ? html`<button
                class="btn primary"
                ?disabled=${disabled || current.phase === "submitting"}
                @click=${() => void this.continueConversation(host)}
              >
                ${t("platformClaw.credentialFlow.continue")}
              </button>`
            : nothing}
          ${inactive
            ? nothing
            : html`<button class="btn" ?disabled=${this.busy} @click=${this.cancel}>
                ${t("platformClaw.credentialFlow.later")}
              </button>`}
        </div>
      </section>
    `;
  }

  dispose(): void {
    this.generation++;
    this.busy = false;
    this.stopGateway?.();
    this.stopGateway = null;
    this.clearTimer();
    this.state = null;
    this.owner = null;
    this.host = null;
    if (this.form) {
      this.form.target = undefined;
      this.form = null;
    }
  }

  private pending(): PendingFlow | null {
    const state = this.state;
    return state && state.phase !== "inactive" && state.phase !== "submitted" ? state : null;
  }

  private connectionCurrent(): boolean {
    const gateway = this.application?.gateway.snapshot;
    return Boolean(
      this.owner &&
      gateway?.phase === "connected" &&
      gateway.client === this.owner.client &&
      gateway.hello === this.owner.hello,
    );
  }

  private hostCurrent(host: ChatAccessoryHost, state: PendingFlow): boolean {
    return (
      this.connectionCurrent() &&
      Date.now() < state.expiresAt &&
      host.connected &&
      (state.sessionId === undefined || host.currentSessionId === state.sessionId) &&
      !host.selectedChatSessionArchived &&
      (state.phase === "awaiting-source" ||
        latestUserTurn(host.chatMessages) === state.sourceUserTurnId) &&
      (state.phase === "awaiting-source" ||
        host.chatLoading ||
        host.chatDisplayedLeafEntryId === state.expectedLeafEntryId)
    );
  }

  private async checkIdentity(state: PendingFlow): Promise<boolean> {
    const identity = await this.loadIdentity();
    if (this.state !== state) {
      return false;
    }
    if (identity?.accountId !== this.identity.accountId || identity.agentId !== state.agentId) {
      this.invalidate("accountChanged");
      return false;
    }
    return this.connectionCurrent();
  }

  private async readSource(
    state: PendingFlow,
  ): Promise<{ leaf: string; sessionId: string } | null> {
    const client = this.application?.gateway.snapshot.client;
    if (!client || !this.connectionCurrent()) {
      return null;
    }
    const history = await client.request<ChatHistoryResult>("chat.history", {
      sessionKey: state.sessionKey,
      agentId: state.agentId,
    });
    if (this.state !== state || !this.connectionCurrent()) {
      return null;
    }
    const sessionId = history.sessionInfo?.sessionId ?? history.sessionId;
    const leaf = history.sessionInfo?.activeLeafEntryId;
    if (
      (state.sessionId !== undefined && sessionId !== state.sessionId) ||
      latestUserTurn(history.messages ?? []) !== state.sourceUserTurnId ||
      history.sessionInfo?.archived
    ) {
      this.invalidate("expired");
      return null;
    }
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      history.inFlightRun ||
      isSessionRunActive(history.sessionInfo ?? {}) ||
      typeof leaf !== "string" ||
      !leaf
    ) {
      return null;
    }
    if (state.phase !== "awaiting-source" && state.expectedLeafEntryId !== leaf) {
      this.invalidate("expired");
      return null;
    }
    return { leaf, sessionId };
  }

  private async confirmSource(state: PendingFlow): Promise<void> {
    if (this.busy || state.phase !== "awaiting-source") {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    try {
      await this.host?.refreshCurrentChat?.({ awaitHistory: true });
      const source = await this.readSource(state);
      const host = this.host;
      if (
        source &&
        this.state === state &&
        host &&
        host.currentSessionId === source.sessionId &&
        latestUserTurn(host.chatMessages) === state.sourceUserTurnId &&
        host.chatDisplayedLeafEntryId === source.leaf
      ) {
        this.state = {
          ...state,
          phase: "required",
          sessionId: source.sessionId,
          expectedLeafEntryId: source.leaf,
        };
        this.error = null;
      }
    } catch {
      if (generation === this.generation) {
        this.error = "unconfirmed";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
      this.host?.requestUpdate?.();
    }
  }

  private async configured(state: PendingFlow): Promise<boolean> {
    const response = await this.fetchImpl(PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error("credential-status-unavailable");
    }
    const value: unknown = await response.json();
    const snapshot = record(value);
    if (this.state !== state) {
      return false;
    }
    if (snapshot?.accountId !== this.identity.accountId) {
      this.invalidate("accountChanged");
      return false;
    }
    const definition = Array.isArray(snapshot.definitions)
      ? snapshot.definitions.map(record).find((entry) => entry?.envName === state.targetKey)
      : null;
    if (!definition) {
      this.invalidate("expired");
      return false;
    }
    // Numeric revisions restart after deletion. The stored generation tokens
    // must still identify the exact value acknowledged for this conversation.
    return (
      (state.phase !== "saved" && state.phase !== "submitting") ||
      (definition.configured === true &&
        definition.revision === state.revision &&
        definition.definitionToken === state.definitionToken &&
        definition.credentialToken === state.credentialToken)
    );
  }

  private async configure(state: PendingFlow): Promise<void> {
    if (
      (state.phase !== "required" && state.phase !== "editing") ||
      this.busy ||
      !this.application
    ) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.host?.requestUpdate?.();
    try {
      if (
        (await this.checkIdentity(state)) &&
        (await this.readSource(state)) &&
        (await this.configured(state)) &&
        this.state === state
      ) {
        this.state = { ...state, phase: "editing" };
        this.application.navigate("credentials");
      }
    } catch {
      if (generation === this.generation) {
        this.error = "unconfirmed";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
      this.host?.requestUpdate?.();
    }
  }

  private async continueConversation(host: ChatAccessoryHost): Promise<void> {
    const state = this.pending();
    if (
      state?.phase !== "saved" ||
      this.busy ||
      !this.hostCurrent(host, state) ||
      host.chatRunId ||
      host.chatSending ||
      host.chatQueue.length
    ) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.host = host;
    host.requestUpdate?.();
    try {
      if (
        !(await this.checkIdentity(state)) ||
        !(await this.readSource(state)) ||
        !(await this.configured(state)) ||
        this.state !== state ||
        !this.hostCurrent(host, state)
      ) {
        if (generation === this.generation) {
          this.error = "expired";
        }
        return;
      }
      this.state = { ...state, phase: "submitting" };
      await host.handleSendChat(
        t("platformClaw.credentialFlow.continueMessage", { envName: state.targetKey }),
        {
          runId: state.requestId,
          actionScope: {
            agentId: state.agentId,
            sessionKey: state.sessionKey,
            sessionId: state.sessionId,
            expectedLeafEntryId: state.expectedLeafEntryId,
          },
          ignoreReplyTarget: true,
          onAdmitted: () => {
            if (
              generation === this.generation &&
              this.state?.phase === "submitting" &&
              this.state.requestId === state.requestId
            ) {
              this.state = { phase: "submitted", requestId: state.requestId };
              this.clearTimer();
            }
          },
        },
      );
      if (this.state?.phase === "submitting") {
        this.state = state;
        this.error = "unconfirmed";
      }
    } catch {
      if (this.state?.phase === "submitting") {
        this.state = state;
      }
      if (generation === this.generation) {
        this.error = "unconfirmed";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
      this.host?.requestUpdate?.();
    }
  }

  private invalidate(reason: "expired" | "accountChanged"): void {
    const state = this.pending();
    if (!state) {
      return;
    }
    this.state = {
      phase: "inactive",
      reason,
      sessionKey: state.sessionKey,
      agentId: state.agentId,
    };
    this.generation++;
    this.busy = false;
    if (this.form) {
      this.form.target = undefined;
    }
    this.clearTimer();
    this.host?.requestUpdate?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
