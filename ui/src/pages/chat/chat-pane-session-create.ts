import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionCreateParams } from "../../lib/sessions/create.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  resolveAgentIdFromSessionKey,
} from "../../lib/sessions/session-key.ts";
import { clearChatHistory } from "./chat-history.ts";
import { ChatPaneBoard } from "./chat-pane-board.ts";
import {
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_CREATE_FAILED_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
} from "./chat-pane-shared.ts";
import { renderChatResetConfirmation } from "./chat-reset-confirmation.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { applyCreatedSessionInitialRun } from "./chat-session-create-completion.ts";
import { canCreateChatSession } from "./chat-state-route.ts";

export abstract class ChatPaneSessionCreation extends ChatPaneBoard {
  protected confirmConversationReset(): Promise<boolean> {
    const board = this.resolveBoardView();
    const sessionKey = this.resolveBoardSessionKey(board.snapshot.sessionKey);
    const pending = this.resetConfirmation;
    if (pending && !areUiSessionKeysEquivalent(pending.sessionKey, sessionKey)) {
      this.settleResetConfirmation(false);
    }
    if (!board.hasBoard) {
      return Promise.resolve(true);
    }
    if (this.resetConfirmation) {
      return this.resetConfirmation.promise;
    }
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((next) => {
      resolve = next;
    });
    this.resetConfirmation = { sessionKey, promise, resolve };
    this.resetConfirmationOpen = true;
    return promise;
  }

  protected cancelResetConfirmationForSessionChange(): void {
    const pending = this.resetConfirmation;
    if (pending && !areUiSessionKeysEquivalent(pending.sessionKey, this.resolveBoardSessionKey())) {
      this.settleResetConfirmation(false);
    }
  }

  protected settleResetConfirmation(confirmed: boolean): void {
    const pending = this.resetConfirmation;
    if (!pending) {
      return;
    }
    this.resetConfirmation = undefined;
    this.resetConfirmationOpen = false;
    pending.resolve(confirmed);
  }

  protected renderResetConfirmation() {
    return renderChatResetConfirmation(this.resetConfirmationOpen, (confirmed) =>
      this.settleResetConfirmation(confirmed),
    );
  }

  protected readonly createSession = async (initialMessage?: string): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
    const previousSessionKey = state.sessionKey;
    const preservesBoard = this.resolveBoardView().hasBoard;
    const createParams = {
      currentSessionKey: previousSessionKey,
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
      ...(initialMessage ? { message: initialMessage } : {}),
    };
    const createRequestParams = {
      ...resolveSessionCreateParams(createParams.currentSessionKey, createParams.agentId),
    };
    const readCreateAccess = () =>
      readSessionMethodAccess(context.gateway.snapshot, {
        method: preservesBoard ? "sessions.reset" : "sessions.create",
        ...(preservesBoard
          ? { requiredScope: "operator.admin" as const }
          : { params: createRequestParams }),
      });
    const publishCreateAccessError = (reason: string) => {
      state.lastError = reason;
      state.chatError = reason;
      state.requestUpdate?.();
    };
    const connectionGeneration = this.connectionGeneration;
    const isCurrent = () =>
      this.isConnected &&
      this.state === state &&
      this.context === context &&
      this.context.sessions === sessions &&
      state.client === client &&
      state.connected &&
      this.connectedClient === client &&
      context.gateway.snapshot.client === client &&
      context.gateway.snapshot.phase === "connected" &&
      this.connectionGeneration === connectionGeneration;
    if (!canCreateChatSession(state)) {
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    if (state.sessionsLoading) {
      setChatError(state, NEW_SESSION_LIST_LOADING_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    if (this.embedded) {
      // The container creates a bound session before any prompt is sent. Never
      // fall through to an unbound normal-chat session from an embedded pane.
      const nextSessionKey = await this.onCreateSession?.();
      if (!nextSessionKey || !isCurrent()) {
        return false;
      }
      this.sessionKey = nextSessionKey;
      if (state.sessionKey !== nextSessionKey) {
        this.switchPaneSession(nextSessionKey);
      }
      this.onPaneSessionChange?.(this.paneId, nextSessionKey);
      if (initialMessage) {
        await handleSendChat(state, initialMessage);
      }
      return true;
    }
    const initialAccess = readCreateAccess();
    if (!initialAccess.allowed) {
      publishCreateAccessError(initialAccess.reason);
      return false;
    }
    if (
      !(await this.confirmConversationReset()) ||
      !isCurrent() ||
      !areUiSessionKeysEquivalent(state.sessionKey, previousSessionKey)
    ) {
      return false;
    }
    if (!canCreateChatSession(state)) {
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    const currentAccess = readCreateAccess();
    if (!currentAccess.allowed) {
      publishCreateAccessError(currentAccess.reason);
      return false;
    }

    setChatError(state, null);
    if (preservesBoard) {
      // Captured before the await: the reset can land and refresh session rows
      // mid-flight, and invalidating the post-reset id would eat fresh digests.
      const preResetSessionId = state.sessionsResult?.sessions.find((row) =>
        areUiSessionKeysEquivalent(row.key, previousSessionKey),
      )?.sessionId;
      const resetResult = await clearChatHistory(state);
      const resetIsCurrent =
        isCurrent() && areUiSessionKeysEquivalent(state.sessionKey, previousSessionKey);
      if (resetResult === "completed" && resetIsCurrent) {
        // A reset reuses the session key; prior-run digests must not survive
        // into the fresh conversation or keep injecting the observer card.
        this.observerDigestHistory.markReset(
          this.resolveObserverDigestHistoryKey(previousSessionKey),
          preResetSessionId,
        );
        // Recompute rather than null: the builtin snapshot also carries the
        // swarm card, which must survive an observer-only invalidation.
        this.refreshBuiltinBoardSnapshot();
        if (initialMessage) {
          await handleSendChat(state, initialMessage);
        }
      } else if (initialMessage) {
        state.chatMessage = initialMessage;
        setChatError(
          state,
          resetResult === "uncertain"
            ? "The thread reset could not be confirmed. Your message was not sent."
            : !resetIsCurrent
              ? "The selected thread changed. Your message was not sent."
              : "The thread could not be reset. Your message was not sent.",
        );
        state.requestUpdate?.();
      }
      return resetResult === "completed" && resetIsCurrent;
    }
    const submittedAt = Date.now();
    const created = initialMessage ? await sessions.createResult(createParams) : null;
    const nextSessionKey = initialMessage
      ? (created?.key ?? null)
      : await sessions.create(createParams);
    if (!isCurrent()) {
      return false;
    }
    if (
      !nextSessionKey ||
      state.sessionKey !== previousSessionKey ||
      !canCreateChatSession(state)
    ) {
      if (!nextSessionKey) {
        setChatError(
          state,
          state.sessionsError ??
            (state.sessionsLoading
              ? NEW_SESSION_LIST_LOADING_MESSAGE
              : NEW_SESSION_CREATE_FAILED_MESSAGE),
        );
        state.requestUpdate?.();
      }
      return false;
    }
    applyCreatedSessionInitialRun({
      state,
      initialMessage,
      created,
      submittedAt,
      handoff: context.initialUserMessage,
      client,
      nextSessionKey,
    });
    this.chatState.captureCreatedSessionComposer(nextSessionKey);
    this.onPaneSessionChange?.(this.paneId, nextSessionKey);
    return true;
  };
}
