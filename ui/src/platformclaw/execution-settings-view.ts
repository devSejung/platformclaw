import type { CodingAgentId } from "@platformclaw/coding-agent-contract";
import { platformClawT as t } from "./i18n.ts";

export type ClaudeEnvironmentKey =
  | "ANTHROPIC_BASE_URL"
  | "ADMIN_API_URL"
  | "OIDC_ISSUER_URL"
  | "OIDC_CLIENT_ID";

export const AGENT_LABELS: Record<CodingAgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export const DEFAULT_EXECUTABLES: Record<CodingAgentId, string> = {
  claude: "/home/me/.local/bin/claude",
  codex: "/usr/local/bin/codex",
  opencode: "/usr/local/bin/opencode",
};

export function localizedRequestError(value: unknown, fallbackKey: string): string {
  if (value === "AD password was not accepted") {
    return t("platformClaw.execution.passwordRejected");
  }
  return typeof value === "string" ? value : t(fallbackKey);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    if (character === "&") {
      return "&amp;";
    }
    if (character === "<") {
      return "&lt;";
    }
    if (character === ">") {
      return "&gt;";
    }
    if (character === "'") {
      return "&#39;";
    }
    return "&quot;";
  });
}

export function formatCheckTime(value?: number): string {
  if (!value) {
    return t("platformClaw.execution.neverChecked");
  }
  const date = new Date(value);
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export function hasLiteralSurroundingQuotes(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  );
}
