import type { ApplicationInitialUserMessageHandoff } from "../../app/context.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { prepareInitialUserMessageHandoff } from "./initial-turn-handoff.ts";

export function applyCreatedSessionInitialRun(params: {
  state: ChatPageHost;
  initialMessage?: string;
  created: SessionCreateOutcome | null;
  submittedAt: number;
  handoff: ApplicationInitialUserMessageHandoff;
  client: object;
  nextSessionKey: string;
}): void {
  const { created, initialMessage } = params;
  if (initialMessage && created?.initialRun.status === "started") {
    prepareInitialUserMessageHandoff(
      params.handoff,
      params.nextSessionKey,
      { text: initialMessage, createdAt: params.submittedAt },
      params.client,
      {
        messageId: created.initialRun.messageId,
        messageSeq: created.initialRun.messageSeq,
      },
    );
  } else if (initialMessage && created?.initialRun.status !== "started") {
    params.state.chatMessage = initialMessage;
    setChatError(
      params.state,
      created?.initialRun.status === "rejected"
        ? created.initialRun.error
        : "The thread was created, but its first message was not sent.",
    );
  }
}
