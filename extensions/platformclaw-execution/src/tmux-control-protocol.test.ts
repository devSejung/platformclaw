import { describe, expect, it } from "vitest";
import {
  decodeTmuxOutput,
  TmuxControlParser,
  type TmuxControlEvent,
} from "./tmux-control-protocol.js";

describe("tmux 3.2a control framing", () => {
  it("preserves escaped bytes and UTF-8 across arbitrary SSH chunks", () => {
    const events: TmuxControlEvent[] = [];
    const parser = new TmuxControlParser((event) => events.push(event));
    const bytes = Buffer.from("%output %12 한글\\015\\012\\033[31m\\134\n");
    for (const byte of bytes) {
      parser.push(Buffer.from([byte]));
    }
    expect(events).toEqual([
      { kind: "output", paneId: "%12", data: Buffer.from("한글\r\n\x1b[31m\\") },
    ]);
    expect(decodeTmuxOutput(Buffer.from("\\000\\377"))).toEqual(Buffer.from([0, 255]));
  });
  it("correlates full command guards and keeps response text distinct from pane output", () => {
    const events: TmuxControlEvent[] = [];
    new TmuxControlParser((event) => events.push(event)).push(
      Buffer.from("%begin 123 8 1\n%output %1 response text\n%error 123 8 1\n%window-close @2\n"),
    );
    expect(events).toEqual([
      {
        kind: "response",
        id: "123 8 1",
        flags: 1,
        error: true,
        lines: ["%output %1 response text"],
      },
      { kind: "notification", line: "%window-close @2" },
    ]);
  });
  it("rejects malformed escapes, mismatched guards and oversized frames", () => {
    expect(() => decodeTmuxOutput(Buffer.from("\\12"))).toThrow("escape");
    expect(() =>
      new TmuxControlParser(() => {}).push(Buffer.from("%begin 1 2 1\n%end 1 3 1\n")),
    ).toThrow("Mismatched");
    expect(() => new TmuxControlParser(() => {}).push(Buffer.alloc(256 * 1024 + 1, 97))).toThrow(
      "limit",
    );
    expect(() =>
      new TmuxControlParser(() => {}).push(Buffer.from(`%begin 1 2 1\n${"x\n".repeat(33 * 1024)}`)),
    ).toThrow("limit");
  });
});
