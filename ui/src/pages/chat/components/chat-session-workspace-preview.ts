import type { SessionWorkspaceGetResult } from "../../../api/types.ts";
import type { SidebarContent } from "./chat-sidebar.ts";

function formatMarkdownCodeSpan(value: string): string {
  // Markdown finds block boundaries before inline spans, so filenames must stay on one logical line.
  const singleLineValue = value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const longestBacktickRun = Math.max(
    0,
    ...(singleLineValue.match(/`+/g)?.map((run) => run.length) ?? []),
  );
  const delimiter = "`".repeat(longestBacktickRun + 1);
  const hasBoundarySpaces = singleLineValue.startsWith(" ") && singleLineValue.endsWith(" ");
  const isOnlySpaces = /^ +$/.test(singleLineValue);
  const padding =
    singleLineValue.startsWith("`") ||
    singleLineValue.endsWith("`") ||
    (hasBoundarySpaces && !isOnlySpaces)
      ? " "
      : "";
  return `${delimiter}${padding}${singleLineValue}${padding}${delimiter}`;
}

function formatFileUpdatedAt(updatedAtMs: number | undefined): string | null {
  if (typeof updatedAtMs !== "number") {
    return null;
  }
  const updatedAt = new Date(updatedAtMs);
  return Number.isNaN(updatedAt.getTime()) ? null : updatedAt.toISOString();
}

export function unsupportedFileSidebarContent(
  file: SessionWorkspaceGetResult["file"],
  fallbackPath: string,
): SidebarContent {
  const filePath = file.workspacePath || file.path || fallbackPath;
  const updatedAt = formatFileUpdatedAt(file.updatedAtMs);
  const lines = [
    "This file is not previewable inline.",
    "",
    `- Path: ${formatMarkdownCodeSpan(filePath)}`,
    file.mimeType ? `- Type: ${formatMarkdownCodeSpan(file.mimeType)}` : null,
    typeof file.size === "number" ? `- Size: ${file.size.toLocaleString()} bytes` : null,
    updatedAt ? `- Updated: ${updatedAt}` : null,
  ].filter((line): line is string => line !== null);
  const content = lines.join("\n");
  return { kind: "markdown", content, rawText: content };
}

export function artifactSidebarContent(params: {
  data?: string;
  encoding?: string;
  mimeType: string;
  title: string;
  url?: string;
}): SidebarContent {
  const { data, encoding, mimeType, title, url } = params;
  if (encoding === "base64" && data && mimeType.startsWith("image/")) {
    return {
      kind: "image",
      title,
      src: `data:${mimeType};base64,${data}`,
      mimeType,
      rawText: url ?? null,
    };
  }
  if (
    encoding === "base64" &&
    data &&
    (mimeType === "application/json" || mimeType.startsWith("text/"))
  ) {
    const bytes = Uint8Array.from(globalThis.atob(data), (char) => char.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const language = mimeType === "application/json" ? "json" : "";
    return {
      kind: "markdown",
      content: `# ${title}\n\n\`\`\`${language}\n${decoded}\n\`\`\``,
      rawText: decoded,
    };
  }
  if (url) {
    const content = `# ${title}\n\n[Open artifact](${url})`;
    return { kind: "markdown", content, rawText: content };
  }
  const content = `# ${title}\n\nArtifact download is not previewable in the sidebar.`;
  return { kind: "markdown", content, rawText: content };
}
