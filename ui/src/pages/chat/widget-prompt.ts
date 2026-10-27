import type { ChatPageHost } from "./chat-state-host.ts";

/** The outbox owns delivery and Retry as soon as it admits this message. */
export function admitWidgetPrompt(state: ChatPageHost, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    void state
      .handleSendChat(text, {
        literalMessage: true,
        ignoreReplyTarget: true,
        onAdmitted: () => resolve(true),
      })
      .then(
        () => resolve(false),
        () => resolve(false),
      );
  });
}
