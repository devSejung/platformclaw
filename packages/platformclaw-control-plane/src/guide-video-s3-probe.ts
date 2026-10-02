import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  createPlatformClawGuideVideoS3Source,
  type PlatformClawGuideVideoS3Config,
} from "./guide-video-s3.js";

const PROBE_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_BYTES = 8 * 1024;

type PlatformClawGuideVideoS3ProbeResult =
  | { ok: true; status: number }
  | {
      ok: false;
      status?: number;
      code?: string;
      message: string;
    };

function xmlField(body: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]{1,512})</${name}>`, "u").exec(body);
  return match?.[1]?.trim() || undefined;
}

function collectFailure(
  upstream: IncomingMessage,
  status: number,
  resolve: (result: PlatformClawGuideVideoS3ProbeResult) => void,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    const body = Buffer.concat(chunks).toString("utf8");
    const code = xmlField(body, "Code");
    const upstreamMessage = xmlField(body, "Message");
    resolve({
      ok: false,
      status,
      ...(code ? { code } : {}),
      message: upstreamMessage || `HTTP ${status}`,
    });
  };
  upstream.on("data", (chunk: Buffer | string) => {
    if (settled) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_ERROR_BODY_BYTES - bytes;
    if (remaining > 0) {
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(buffer.length, remaining);
    }
    if (bytes >= MAX_ERROR_BODY_BYTES) {
      upstream.destroy();
      finish();
    }
  });
  upstream.once("end", finish);
  upstream.once("error", finish);
}

export async function probePlatformClawGuideVideoS3(
  config: PlatformClawGuideVideoS3Config,
): Promise<PlatformClawGuideVideoS3ProbeResult> {
  const source = createPlatformClawGuideVideoS3Source(config);
  const target = new URL(source.targetUrl);
  const headers = source.requestHeaders({
    method: "GET",
    target,
    range: "bytes=0-0",
  });
  return await new Promise<PlatformClawGuideVideoS3ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: PlatformClawGuideVideoS3ProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const onResponse = (upstream: IncomingMessage): void => {
      clearTimeout(openTimeout);
      const status = upstream.statusCode ?? 502;
      if (status >= 200 && status < 300) {
        upstream.destroy();
        finish({ ok: true, status });
        return;
      }
      collectFailure(upstream, status, finish);
    };
    const requestOptions = {
      method: "GET",
      agent: false as const,
      headers,
    };
    const request =
      target.protocol === "https:"
        ? httpsRequest(target, requestOptions, onResponse)
        : httpRequest(target, requestOptions, onResponse);
    const onError = (error: Error): void => {
      clearTimeout(openTimeout);
      finish({ ok: false, message: error.message || "upstream request failed" });
    };
    const openTimeout = setTimeout(() => {
      request.destroy(new Error("upstream open timed out"));
    }, PROBE_TIMEOUT_MS);
    openTimeout.unref();
    request.setTimeout(PROBE_TIMEOUT_MS, () => {
      request.destroy(new Error("upstream request timed out"));
    });
    request.once("error", onError);
    request.end();
  });
}
