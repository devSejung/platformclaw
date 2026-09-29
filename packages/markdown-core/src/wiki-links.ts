/** Browser-safe syntax helpers; resolution and authorization stay with the Wiki owner. */
export function formatWikiDocumentLink(target: string, title?: string): string {
  if (
    !target ||
    target.length > 512 ||
    target.split("").some((character) => character.charCodeAt(0) < 32 || character === "\\") ||
    target.startsWith("/") ||
    target.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Use a bounded, relative Wiki document target.");
  }
  const encoded = target
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  // Wiki labels have no portable delimiter escaping. Fall back to the exact
  // target rather than alter the user's title or emit malformed markup.
  const label = title && title.length <= 240 && !/[\]|\r\n]/u.test(title) ? `|${title}` : "";
  return `[[${encoded}${label}]]`;
}

export function normalizeWikiDocumentTarget(target: string): string {
  return target
    .trim()
    .replaceAll("\\", "/")
    .replace(/\.md$/iu, "")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}
