import { describe, expect, it } from "vitest";
import {
  boundKnoxProgressLine,
  describeKnoxProgressCall,
  formatKnoxProgressCall,
} from "./progress-format.js";

const graphemes = (value: string) =>
  [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)].map(
    ({ segment }) => segment,
  );

describe("Knox factual progress rendering", () => {
  it.each([
    [{ command: "python audit.py" }, "python audit.py"],
    [{ cmd: "pnpm check" }, "pnpm check"],
    [{ path: "/private/team/notes.md" }, "notes.md"],
    [{ file_path: "C:\\private\\team\\notes.md" }, "notes.md"],
    [
      { action: "open", url: "https://user:password@example.com/private?q=SECRET#fragment" },
      "open example.com",
    ],
    [{ url: "https://example.com/private?q=SECRET" }, "example.com"],
    [{ command: "curl https://example.com/private?q=SECRET#fragment" }, "curl example.com"],
  ])("uses literal permitted invocation facts from %j", (args, detail) => {
    expect(describeKnoxProgressCall({ name: "tool", args }).detail).toBe(detail);
  });

  it("does not treat arbitrary descriptions, query text, prompt, meta or output as a task explanation", () => {
    const call = describeKnoxProgressCall({
      name: "plugin_tool",
      title: "PRIVATE",
      meta: "PRIVATE",
      description: "PRIVATE",
      args: {
        query: "PRIVATE",
        prompt: "PRIVATE",
        text: "PRIVATE",
        description: "PRIVATE",
        password: "PRIVATE",
      },
      result: { output: "PRIVATE" },
    });
    expect(formatKnoxProgressCall(call)).toBe("⏳ plugin_tool");
  });

  it("redacts secrets before truncation and flattens all item content to one line", () => {
    const call = describeKnoxProgressCall({
      name: "exec",
      args: { command: "TOKEN=super-secret-token-123456789\npython audit.py" },
    });
    const text = formatKnoxProgressCall(call);
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toMatch(/[\r\n]/u);
    expect(graphemes(text).length).toBeLessThanOrEqual(50);
  });

  it("caps the entire item, preserving emoji and combining sequences and the parallel suffix", () => {
    const emoji = "👨‍👩‍👧‍👦";
    const text = formatKnoxProgressCall(
      { name: "exec", detail: `${emoji}é`.repeat(80), state: "running" },
      " (+3 running)",
    );
    expect(graphemes(text)).toHaveLength(50);
    expect(text).toContain(emoji);
    expect(text).toContain("é");
    expect(text.endsWith(" (+3 running)")).toBe(true);
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/u);
  });

  it("keeps six bounded items plus DM prefix below the total grapheme budget", () => {
    const item = formatKnoxProgressCall({
      name: "exec",
      detail: "👨‍👩‍👧‍👦".repeat(100),
      state: "completed",
    });
    const text = `🟠 Using PlatformClaw server\n\n${Array(6).fill(item).join("\n")}`;
    expect(graphemes(text).length).toBeLessThan(400);
    expect(boundKnoxProgressLine("plain")).toBe("plain");
  });
});
