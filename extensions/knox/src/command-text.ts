/** Resolve a Knox text-command candidate without changing the Agent-visible message. */
export function resolveKnoxCommandText(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && !lines.at(-1)?.trim()) {
    lines.pop();
  }
  const finalLine = lines.at(-1)?.trim();
  if (!finalLine) {
    return "";
  }
  if (/^\/\S/u.test(finalLine)) {
    return finalLine;
  }
  // Knox may render an optional bot mention before the actual slash command.
  // Only a standalone final-line mention prefix is structural; prose stays Agent input.
  const mentionedCommand = /^@\S+\s+(\/\S(?:.*)?)$/u.exec(finalLine)?.[1]?.trim();
  return mentionedCommand || finalLine;
}
