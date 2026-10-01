import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";

export const PLATFORMCLAW_GUIDE_VIDEO_PATH = "/platformclaw/guide/video";

const MAX_REDIRECTS = 5;
const UPSTREAM_IDLE_TIMEOUT_MS = 30_000;
const RESPONSE_HEADERS = [
  "accept-ranges",
  "content-encoding",
  "content-length",
  "content-range",
  "etag",
  "last-modified",
] as const;

function validateTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PlatformClaw guide video upstream URL is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("PlatformClaw guide video upstream URL is invalid");
  }
  return url;
}

function copyResponseHeaders(upstream: IncomingMessage, res: ServerResponse): void {
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers[name];
    if (value !== undefined) {
      res.setHeader(name, value);
    }
  }
}

async function proxyOnce(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  allowedOrigin: string,
  redirectsRemaining: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const headers: Record<string, string> = {};
    if (typeof req.headers.range === "string") {
      headers.range = req.headers.range;
    }
    if (typeof req.headers["if-range"] === "string") {
      headers["if-range"] = req.headers["if-range"];
    }
    const onResponse = (upstream: IncomingMessage): void => {
      clearTimeout(openTimeout);
      const status = upstream.statusCode ?? 502;
      const location = upstream.headers.location;
      if (status >= 300 && status < 400) {
        cleanup();
        // A redirect body is irrelevant and may never terminate. This request
        // uses agent:false, so discard the old socket before opening the next hop.
        upstream.destroy();
        if (!location) {
          res.statusCode = 502;
          res.end("Guide video upstream redirect is missing a location");
          resolve();
          return;
        }
        if (redirectsRemaining <= 0) {
          res.statusCode = 502;
          res.end("Guide video upstream exceeded redirect limit");
          resolve();
          return;
        }
        let redirected: URL;
        try {
          redirected = validateTarget(new URL(location, target).toString());
        } catch {
          res.statusCode = 502;
          res.end("Guide video upstream redirect is invalid");
          resolve();
          return;
        }
        if (redirected.origin !== allowedOrigin) {
          res.statusCode = 502;
          res.end("Guide video upstream cross-origin redirect is blocked");
          resolve();
          return;
        }
        void proxyOnce(req, res, redirected, allowedOrigin, redirectsRemaining - 1).then(resolve);
        return;
      }

      res.statusCode = status;
      copyResponseHeaders(upstream, res);
      // This relay is a narrow MP4-only product surface. Never promote an
      // upstream HTML/SVG response into active same-origin PlatformClaw content.
      res.setHeader("Content-Type", "video/mp4");
      if (req.method === "HEAD") {
        cleanup();
        upstream.resume();
        res.end();
        resolve();
        return;
      }
      upstream.once("end", cleanup);
      upstream.once("error", () => {
        cleanup();
        res.destroy();
      });
      upstream.pipe(res);
      resolve();
    };
    const requestOptions = {
      method: req.method,
      // Node core http(s).request does not consume HTTP(S)_PROXY/ALL_PROXY.
      // agent:false also avoids any process-global agent that an embedding runtime may replace.
      // The guide-video hop is therefore always a direct socket to the configured S3/media host.
      agent: false as const,
      headers,
    };
    const upstreamRequest =
      target.protocol === "https:"
        ? httpsRequest(target, requestOptions, onResponse)
        : httpRequest(target, requestOptions, onResponse);
    const openTimeout = setTimeout(() => {
      upstreamRequest.destroy(new Error("guide video upstream open timed out"));
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    openTimeout.unref();
    function onRequestError(): void {
      cleanup();
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Guide video upstream is unavailable");
      } else {
        res.destroy();
      }
      resolve();
    }
    function cleanup(): void {
      clearTimeout(openTimeout);
      req.off("aborted", abortUpstream);
      res.off("close", abortUpstream);
      upstreamRequest.off("error", onRequestError);
      upstreamRequest.setTimeout(0);
    }
    function abortUpstream(): void {
      cleanup();
      upstreamRequest.destroy();
    }
    req.once("aborted", abortUpstream);
    res.once("close", abortUpstream);
    upstreamRequest.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
      upstreamRequest.destroy(new Error("guide video upstream timed out"));
    });
    upstreamRequest.once("error", onRequestError);
    upstreamRequest.end();
  });
}

export async function proxyPlatformClawGuideVideo(
  req: IncomingMessage,
  res: ServerResponse,
  targetUrl: string,
): Promise<void> {
  const target = validateTarget(targetUrl);
  await proxyOnce(req, res, target, target.origin, MAX_REDIRECTS);
}
