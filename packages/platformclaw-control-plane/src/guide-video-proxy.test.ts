import {
  createServer,
  request as httpRequest,
  setGlobalProxyFromEnv,
  type IncomingHttpHeaders,
  type RequestListener,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PLATFORMCLAW_GUIDE_VIDEO_PATH, proxyPlatformClawGuideVideo } from "./guide-video-proxy.js";

type TestServer = { origin: string; close(): Promise<void> };

const servers: TestServer[] = [];
const originalProxyEnv = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
  NO_PROXY: process.env.NO_PROXY,
};

async function listen(handler: RequestListener): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const fixture = {
    origin: `http://127.0.0.1:${port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
  servers.push(fixture);
  return fixture;
}

async function directRequest(
  url: string,
  options: { method?: "GET" | "HEAD"; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  for (const server of servers.splice(0).toReversed()) {
    await server.close();
  }
  for (const [key, value] of Object.entries(originalProxyEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  setGlobalProxyFromEnv();
});

describe("guide video proxy", () => {
  it("streams Range requests directly even when process proxy variables point elsewhere", async () => {
    let proxyRequests = 0;
    const fakeProxy = await listen((_req, res) => {
      proxyRequests += 1;
      res.statusCode = 502;
      res.end("proxy must not be used");
    });
    let upstreamRange: string | undefined;
    const upstream = await listen((req, res) => {
      upstreamRange = req.headers.range;
      res.statusCode = 206;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", "bytes 2-5/10");
      res.setHeader("Content-Length", "4");
      res.end("2345");
    });
    process.env.HTTP_PROXY = fakeProxy.origin;
    process.env.HTTPS_PROXY = fakeProxy.origin;
    process.env.ALL_PROXY = fakeProxy.origin;
    process.env.NO_PROXY = "";
    setGlobalProxyFromEnv();

    const ingress = await listen((req, res) => {
      if (new URL(req.url ?? "/", "http://localhost").pathname !== PLATFORMCLAW_GUIDE_VIDEO_PATH) {
        res.statusCode = 404;
        res.end();
        return;
      }
      void proxyPlatformClawGuideVideo(req, res, `${upstream.origin}/guide.mp4`);
    });
    const response = await directRequest(`${ingress.origin}${PLATFORMCLAW_GUIDE_VIDEO_PATH}`, {
      headers: { Range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    expect(response.headers["content-type"]).toBe("video/mp4");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.body).toBe("2345");
    expect(upstreamRange).toBe("bytes=2-5");
    expect(proxyRequests).toBe(0);
  });

  it("follows same-origin redirects without waiting for redirect bodies", async () => {
    const upstream = await listen((req, res) => {
      if (req.url === "/redirect") {
        res.statusCode = 307;
        res.setHeader("Location", "/final.mp4");
        res.write("redirect body intentionally left open");
        return;
      }
      expect(req.headers.cookie).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      res.setHeader("Content-Type", "video/mp4");
      res.end("video");
    });
    const ingress = await listen((req, res) => {
      void proxyPlatformClawGuideVideo(req, res, `${upstream.origin}/redirect`);
    });

    const response = await directRequest(ingress.origin, {
      headers: { Cookie: "browser-session=do-not-forward", Authorization: "Bearer browser" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe("video");
  });

  it("blocks cross-origin redirects before contacting the redirected host", async () => {
    let redirectedRequests = 0;
    const redirected = await listen((_req, res) => {
      redirectedRequests += 1;
      res.end("must not be reached");
    });
    const upstream = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", `${redirected.origin}/internal-admin`);
      res.end();
    });
    const ingress = await listen((req, res) => {
      void proxyPlatformClawGuideVideo(req, res, `${upstream.origin}/guide.mp4`);
    });

    const response = await directRequest(ingress.origin);
    expect(response.status).toBe(502);
    expect(response.body).toContain("cross-origin redirect is blocked");
    expect(redirectedRequests).toBe(0);
  });

  it("forwards HEAD Range and If-Range without a response body", async () => {
    let seenMethod = "";
    let seenRange: string | undefined;
    let seenIfRange: string | undefined;
    const upstream = await listen((req, res) => {
      seenMethod = req.method ?? "";
      seenRange = req.headers.range;
      seenIfRange =
        typeof req.headers["if-range"] === "string" ? req.headers["if-range"] : undefined;
      res.statusCode = 206;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Range", "bytes 0-99/1000");
      res.end();
    });
    const ingress = await listen((req, res) => {
      void proxyPlatformClawGuideVideo(req, res, `${upstream.origin}/guide.mp4`);
    });

    const response = await directRequest(ingress.origin, {
      method: "HEAD",
      headers: { Range: "bytes=0-99", "If-Range": '"etag-1"' },
    });
    expect(response.status).toBe(206);
    expect(response.body).toBe("");
    expect(seenMethod).toBe("HEAD");
    expect(seenRange).toBe("bytes=0-99");
    expect(seenIfRange).toBe('"etag-1"');
  });
});
