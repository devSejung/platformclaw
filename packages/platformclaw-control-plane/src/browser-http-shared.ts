import type { ServerResponse } from "node:http";
import type { JsonBodyReader } from "./browser-auth-http.js";

export const readBrowserJsonBody: JsonBodyReader = async (req, maxBytes) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > maxBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) {
    return { ok: false, error: "request body too large" };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }
};

export function sendBrowserJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
