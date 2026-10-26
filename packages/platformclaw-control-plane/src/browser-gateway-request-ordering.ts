import { PLATFORMCLAW_WEB_TALK_METHODS } from "./browser-gateway-talk-policy.js";

const MUTATING_BROWSER_METHODS = new Set([
  ...PLATFORMCLAW_WEB_TALK_METHODS.filter(
    (method) => method !== "talk.catalog" && method !== "talk.config" && method !== "agent.wait",
  ),
  "approval.resolve",
  "agents.files.set",
  "chat.abort",
  "chat.send",
  "platformclaw.spaces.create",
  "platformclaw.spaces.member.set",
  "platformclaw.spaces.member.remove",
  "platformclaw.spaces.page.create",
  "platformclaw.spaces.page.save",
  "platformclaw.spaces.conversation.create",
  "platformclaw.baseball.plateAppearance",
  "platformclaw.baseball.purchaseBat",
  "platformclaw.baseball.equipBat",
  "controlUi.sessionPullRequests.subscribe",
  "cron.add",
  "cron.remove",
  "cron.run",
  "cron.update",
  "question.resolve",
  "sessions.abort",
  "sessions.branches.switch",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.create",
  "sessions.delete",
  "sessions.observer.visibility",
  "sessions.patch",
  "sessions.reset",
  "sessions.rewind",
  "sessions.send",
  "sessions.steer",
  "skills.proposals.apply",
  "skills.proposals.evaluate",
  "skills.proposals.historyScan",
  "skills.proposals.reject",
  "skills.proposals.requestRevision",
  "taskSuggestions.accept",
  "taskSuggestions.dismiss",
  "terminal.attach",
  "terminal.close",
  "terminal.input",
  "terminal.open",
  "terminal.resize",
]);

export function isMutatingBrowserGatewayMethod(method: string): boolean {
  return (
    MUTATING_BROWSER_METHODS.has(method) ||
    (method.startsWith("platformclaw.vault.") &&
      method !== "platformclaw.vault.snapshot" &&
      method !== "platformclaw.vault.document.get")
  );
}
