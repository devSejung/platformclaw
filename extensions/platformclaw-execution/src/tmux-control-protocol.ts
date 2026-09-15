const MAX_LINE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type TmuxControlEvent =
  | { kind: "response"; id: string; flags: number; error: boolean; lines: string[] }
  | { kind: "output"; paneId: string; data: Buffer }
  | { kind: "notification"; line: string };

/** tmux 3.2a control.c escapes bytes below space and backslash as three octal digits. */
function decodeTmuxOutput(value: Buffer): Buffer {
  const output = Buffer.allocUnsafe(value.length);
  let size = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== 92) {
      output[size++] = value[i]!;
      continue;
    }
    const octal = value.subarray(i + 1, i + 4).toString("ascii");
    if (!/^[0-3][0-7]{2}$/u.test(octal)) {
      throw new Error("Invalid tmux control output escape.");
    }
    output[size++] = Number.parseInt(octal, 8);
    i += 3;
  }
  return output.subarray(0, size);
}

/** Owns byte framing: UTF-8 is decoded only after each pane's escapes are removed. */
export class TmuxControlParser {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private block?: { id: string; flags: number; lines: string[]; size: number };

  constructor(private readonly emit: (event: TmuxControlEvent) => void) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const piece = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (this.pendingBytes + piece.length > MAX_LINE_BYTES) {
        throw new Error("Tmux control line exceeded the limit.");
      }
      this.pending.push(piece);
      this.pendingBytes += piece.length;
      if (end < 0) {
        return;
      }
      const line = Buffer.concat(this.pending, this.pendingBytes);
      this.pending = [];
      this.pendingBytes = 0;
      this.readLine(line);
      offset = end + 1;
    }
  }

  private readLine(bytes: Buffer): void {
    const line = bytes.toString("utf8");
    const guard = /^%(begin|end|error) (\d{1,20}) (\d{1,20}) ([01])$/u.exec(line);
    if (guard) {
      const id = `${guard[2]} ${guard[3]} ${guard[4]}`;
      if (guard[1] === "begin") {
        if (this.block) {
          throw new Error("Nested tmux control response.");
        }
        this.block = { id, flags: Number(guard[4]), lines: [], size: 0 };
      } else {
        if (!this.block || this.block.id !== id) {
          throw new Error("Mismatched tmux control response.");
        }
        const block = this.block;
        this.block = undefined;
        this.emit({
          kind: "response",
          id,
          flags: block.flags,
          error: guard[1] === "error",
          lines: block.lines,
        });
      }
      return;
    }
    if (this.block) {
      this.block.size += bytes.length + 1;
      if (this.block.size > MAX_RESPONSE_BYTES) {
        throw new Error("Tmux control response exceeded the limit.");
      }
      this.block.lines.push(line);
      return;
    }
    const output = /^%output (%\d{1,10}) /u.exec(bytes.toString("latin1"));
    if (output) {
      this.emit({
        kind: "output",
        paneId: output[1]!,
        data: decodeTmuxOutput(bytes.subarray(output[0].length)),
      });
      return;
    }
    if (!line.startsWith("%")) {
      throw new Error("Invalid tmux control notification.");
    }
    this.emit({ kind: "notification", line });
  }
}
