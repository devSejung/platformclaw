const MUTATING_BROWSER_METHODS = new Set([
  "approval.resolve",
  "agents.files.set",
  "chat.abort",
  "chat.send",
  "controlUi.sessionPullRequests.subscribe",
  "cron.add",
  "cron.remove",
  "cron.run",
  "cron.update",
  "question.resolve",
  "sessions.abort",
  "sessions.create",
  "sessions.delete",
  "sessions.observer.visibility",
  "sessions.patch",
  "taskSuggestions.accept",
  "taskSuggestions.dismiss",
]);

export function isMutatingBrowserGatewayMethod(method: string): boolean {
  return MUTATING_BROWSER_METHODS.has(method);
}
