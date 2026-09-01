type ProjectionFailure = (message: string) => never;

const MAX_PATH_CHARS = 1_024;
const WIKI_ROOTS = new Set(["entities", "concepts", "sources", "syntheses", "reports"]);
const DREAMING_SESSION_CORPUS_TEXT_PATH_RE =
  /^memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.txt$/u;

function relativePath(value: unknown, label: string, fail: ProjectionFailure): string {
  if (typeof value !== "string" || value.length > MAX_PATH_CHARS) {
    return fail(`Gateway returned invalid ${label}`);
  }
  const candidate = value.replaceAll("\\", "/");
  if (
    candidate.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(candidate) ||
    candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return fail(`Gateway returned unsafe ${label}`);
  }
  return candidate;
}

export function wikiPath(value: unknown, label: string, fail: ProjectionFailure): string {
  const candidate = relativePath(value, label, fail);
  const [root] = candidate.split("/");
  return root && WIKI_ROOTS.has(root) && candidate.endsWith(".md")
    ? candidate
    : fail(`Gateway returned invalid ${label}`);
}

function isDreamingSessionCorpusTextPath(candidate: string): boolean {
  const match = DREAMING_SESSION_CORPUS_TEXT_PATH_RE.exec(candidate);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function dreamingEntryPath(value: unknown, label: string, fail: ProjectionFailure): string {
  const candidate = relativePath(value, label, fail);
  // Memory-core status can reference its bounded session corpus. This is provenance only;
  // pin the producer's exact shape here instead of broadening general browser file access.
  return candidate === "MEMORY.md" ||
    (candidate.startsWith("memory/") && candidate.endsWith(".md")) ||
    isDreamingSessionCorpusTextPath(candidate)
    ? candidate
    : fail(`Gateway returned invalid ${label}`);
}
