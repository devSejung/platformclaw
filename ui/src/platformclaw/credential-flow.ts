import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { html, nothing } from "lit";
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
import { showToast } from "../lib/toast.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history.ts";
import type { PlatformClawExecCredentialsElement } from "./exec-credentials.ts";
import { platformClawT as t } from "./i18n.ts";
import type { PlatformClawSessionIdentity } from "./web-contract.ts";
import { PLATFORMCLAW_EXEC_CREDENTIALS_API_PATH } from "./web-contract.ts";

const FLOW_TTL_MS = 30 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type FlowIdentity = {
  requestId: string;
  targetKey: string;
  agentId: string;
  sessionKey: string;
  sourceUserTurnId: string;
  expiresAt: number;
};

type PendingFlow = FlowIdentity &
  (
    | { phase: "awaiting-source"; sessionId?: string }
    | { phase: "required" | "editing"; sessionId: string; expectedLeafEntryId: string }
  );

type FlowState =
  | PendingFlow
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
    return readSessionMessageIdentity(message)?.runId ?? null;
  }
  return null;
}

function credentialAction(details: unknown): { requestId: string; targetKey: string } | null {
  const action = record(record(details)?.uiAction);
  if (
    !action ||
    Object.keys(action).length !== 5 ||
    action.version !== 1 ||
    action.kind !== "settings" ||
    action.feature !== "platformclaw.exec-credentials" ||
    typeof action.requestId !== "string" ||
    !UUID_RE.test(action.requestId) ||
    typeof action.targetKey !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(action.targetKey)
  ) {
    return null;
  }
  return { requestId: action.requestId, targetKey: action.targetKey };
}

/** One in-memory handoff. Secret values belong exclusively to the existing form. */
export class PlatformClawCredentialFlow {
  private application: ApplicationContext<RouteId> | null = null;
  private stopGateway: (() => void) | null = null;
  private owner: { client: object; hello: object } | null = null;
  private host: ChatAccessoryHost | null = null;
  private state: FlowState | null = null;
  private busy = false;
  private error: "unconfirmed" | null = null;
  private probeKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private route: RouteId = "chat";
  private form: PlatformClawExecCredentialsElement | null = null;
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
    const action = credentialAction(result.details);
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
      // The pending user row can still live only in the chat projection here.
      // Shared message identity maps its persisted `:user` key back to this run.
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
    return state?.phase === "editing"
      ? {
          requestId: state.requestId,
          envName: state.targetKey,
          expectedAccountId: this.identity.accountId,
        }
      : undefined;
  }

  saved = (ack: { requestId: string; envName: string; revision: number }): void => {
    const state = this.pending();
    if (
      state?.phase !== "editing" ||
      ack.requestId !== state.requestId ||
      ack.envName !== state.targetKey ||
      !Number.isSafeInteger(ack.revision) ||
      ack.revision <= 0 ||
      !this.connectionCurrent()
    ) {
      return;
    }
    this.state = null;
    this.owner = null;
    this.generation++;
    this.busy = false;
    this.error = null;
    this.probeKey = null;
    this.clearTimer();
    if (this.form) {
      this.form.target = undefined;
    }
    this.host?.requestUpdate?.();
    const generation = this.generation;
    // Saving ends the handoff; this optional shortcut only restores its source route.
    showToast({
      message: t("platformClaw.execCredentials.saved"),
      actionLabel: t("platformClaw.credentialFlow.return"),
      placement: "bottom-right",
      durationMs: 15_000,
      onAction: () => {
        if (this.generation === generation && this.route === "credentials") {
          this.navigateToConversation(state);
        }
      },
    });
  };

  cancel = (): void => {
    const state = this.pending();
    this.invalidate("expired");
    if (state && this.route === "credentials") {
      this.navigateToConversation(state);
    }
  };

  private navigateToConversation(state: Pick<FlowIdentity, "agentId" | "sessionKey">): void {
    if (this.application) {
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
  }

  render(host: ChatAccessoryHost): unknown {
    const state = this.state;
    if (!state) {
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
    if (!current) {
      return nothing;
    }
    if (current.phase === "awaiting-source" && !host.chatRunId && !host.chatLoading && !this.busy) {
      const probeKey = `${host.currentSessionId}:${host.chatDisplayedLeafEntryId ?? ""}:${latestUserTurn(host.chatMessages) ?? ""}`;
      if (this.probeKey !== probeKey) {
        this.probeKey = probeKey;
        void this.confirmSource(current);
      }
    }
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
          >${t(
            `platformClaw.credentialFlow.${inactive ? current.reason : "requiredTitle"}`,
          )}</strong
        >
        ${inactive
          ? nothing
          : html`<p>
                ${t("platformClaw.credentialFlow.requiredBody", { envName: current.targetKey })}
              </p>
              <code>${current.targetKey}</code>`}
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
    return state && state.phase !== "inactive" ? state : null;
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

  private async targetAvailable(state: PendingFlow): Promise<boolean> {
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
    return true;
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
        (await this.targetAvailable(state)) &&
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
