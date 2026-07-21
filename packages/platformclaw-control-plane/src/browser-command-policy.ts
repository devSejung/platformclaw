type JsonObject = Record<string, unknown>;

// These commands cross the personal-agent boundary into Gateway administration,
// host execution, credentials, device control, or channel-owned bindings.
const BLOCKED_BROWSER_COMMANDS = new Set([
  "acp",
  "activation",
  "agents",
  "allowlist",
  "approve",
  "bash",
  "codex",
  "config",
  "debug",
  "diagnostics",
  "elev",
  "elevated",
  "exec",
  "focus",
  "login",
  "mcp",
  "openclaw",
  "pair",
  "phone",
  "plugin",
  "plugins",
  "restart",
  "send",
  "tts",
  "unfocus",
]);
const SAFE_MANAGEMENT_COMMANDS = new Set(["steer", "subagents", "tell"]);
const SAFE_NATIVE_CATEGORIES = new Set(["options", "session", "status", "tools"]);

function commandNames(command: JsonObject): string[] {
  const values = [command.name, command.nativeName];
  if (Array.isArray(command.textAliases)) {
    values.push(...command.textAliases);
  }
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/^\//, "").toLowerCase())
    .filter(Boolean);
}

function isBrowserSafeCommand(command: JsonObject): boolean {
  const names = commandNames(command);
  if (names.length === 0 || names.some((name) => BLOCKED_BROWSER_COMMANDS.has(name))) {
    return false;
  }
  if (command.source === "skill") {
    return true;
  }
  if (command.source !== "native") {
    return false;
  }
  if (command.category === "management") {
    return names.every((name) => SAFE_MANAGEMENT_COMMANDS.has(name));
  }
  return typeof command.category === "string" && SAFE_NATIVE_CATEGORIES.has(command.category);
}

function browserCommandTokens(message: string): string[] {
  return Array.from(message.matchAll(/(?:^|\s)\/([^\s:@]+)(?:@[^\s:]+)?(?=\s|:|$)/g), (match) =>
    match[1]?.toLowerCase(),
  ).filter((name): name is string => Boolean(name));
}

export function hasBlockedBrowserDirective(message: unknown): boolean {
  return (
    typeof message === "string" &&
    browserCommandTokens(message.trim()).some((name) => BLOCKED_BROWSER_COMMANDS.has(name))
  );
}

export function resolveBrowserCommandPolicy(
  message: unknown,
  advertisedCommands: unknown,
): "allow" | "block" | "suppress" {
  if (typeof message !== "string") {
    return "suppress";
  }
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) {
    return "suppress";
  }
  const tokens = browserCommandTokens(trimmed);
  if (tokens.length === 0 || hasBlockedBrowserDirective(trimmed)) {
    return "block";
  }
  const leading = tokens[0];
  if (!leading) {
    return "block";
  }
  return projectBrowserCommands(advertisedCommands).some((command) =>
    commandNames(command).includes(leading),
  )
    ? "allow"
    : "block";
}

export function projectBrowserCommands(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is JsonObject =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      isBrowserSafeCommand(entry as JsonObject),
  );
}
