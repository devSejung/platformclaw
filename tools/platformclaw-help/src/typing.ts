// Character counts need a constant cadence; motion easing leaves the last letter waiting.
export function typedPrefix(text: string, frame: number, from: number, to: number) {
  if (frame <= from) return "";
  if (frame >= to) return text;
  const characters = Array.from(text);
  const count = Math.floor(((frame - from) * characters.length) / (to - from));
  return characters.slice(0, count).join("");
}
