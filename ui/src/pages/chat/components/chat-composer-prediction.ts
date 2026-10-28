import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import {
  ComposerPredictionController,
  webComposerRunSession,
} from "../../../platformclaw/composer-predictions.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { commitComposerDraft } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function syncComposerPrediction(
  props: ChatComposerProps,
  state: ChatComposerState,
  idle: boolean,
  eligible: boolean,
  requestUpdate: () => void,
): void {
  if (!document.querySelector('meta[name="platformclaw-web-descriptor"]')) {
    return;
  }
  state.prediction ??= new ComposerPredictionController(requestUpdate);
  const runId = props.runStatus?.runId;
  const submittedSession =
    props.gatewayClient && runId ? webComposerRunSession(props.gatewayClient, runId) : undefined;
  const completedWebRun = Boolean(
    props.runStatus?.phase === "done" &&
    props.runStatus.sessionKey === props.sessionKey &&
    submittedSession &&
    areUiSessionKeysEquivalent(submittedSession, props.sessionKey),
  );
  state.prediction.sync({
    sessionKey: props.sessionKey,
    completedRunId: completedWebRun ? (runId ?? null) : null,
    idle,
    eligible: eligible && (props.runStatus?.phase !== "done" || completedWebRun),
  });
}

export function handleComposerPredictionKeydown(
  event: KeyboardEvent,
  state: ChatComposerState,
  props: ChatComposerProps,
  requestUpdate: () => void,
): boolean {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) || target.value || !state.prediction?.text) {
    return false;
  }
  if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const text = state.prediction.take();
    if (text) {
      target.setRangeText(text, 0, 0, "end");
      commitComposerDraft(props, text);
      adjustTextareaHeight(target);
      requestUpdate();
    }
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    state.prediction.dismiss();
    requestUpdate();
    return true;
  }
  return false;
}
