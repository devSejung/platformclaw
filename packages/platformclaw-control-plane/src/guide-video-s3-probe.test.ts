import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probePlatformClawGuideVideoS3 } from "./guide-video-s3-probe.js";
import type { PlatformClawGuideVideoS3Config } from "./guide-video-s3.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function config(endpoint: string): PlatformClawGuideVideoS3Config {
  return {
    endpoint,
    region: "us-east-1",
    bucket: "guide-media",
    key: "guides/platformclaw.mp4",
    accessKeyId: "fixture-access-key",
    secretAccessKey: "fixture-secret-key",
    forcePathStyle: true,
  };
}

describe("guide video S3 deployment probe", () => {
  it("uses the real SigV4 Range GET path and accepts a partial response", async () => {
    let observedRange = "";
    let observedAuthorization = "";
    const endpoint = await listen((req, res) => {
      observedRange = req.headers.range ?? "";
      observedAuthorization = req.headers.authorization ?? "";
      res.writeHead(206, {
        "content-range": "bytes 0-0/42",
        "content-length": "1",
      });
      res.end("x");
    });

    await expect(probePlatformClawGuideVideoS3(config(endpoint))).resolves.toEqual({
      ok: true,
      status: 206,
    });
    expect(observedRange).toBe("bytes=0-0");
    expect(observedAuthorization).toMatch(/^AWS4-HMAC-SHA256 Credential=fixture-access-key\//u);
  });

  it("surfaces a bounded S3 error code without credentials", async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end(
        "<Error><Code>InvalidAccessKeyId</Code><Message>The Access Key Id does not exist.</Message></Error>",
      );
    });

    const result = await probePlatformClawGuideVideoS3(config(endpoint));
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: "InvalidAccessKeyId",
      message: "The Access Key Id does not exist.",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-secret-key");
  });

  it("rejects signed redirects during preflight", async () => {
    const endpoint = await listen((_req, res) => {
      res.writeHead(307, { location: "http://example.test/elsewhere" });
      res.end();
    });

    await expect(probePlatformClawGuideVideoS3(config(endpoint))).resolves.toMatchObject({
      ok: false,
      status: 307,
    });
  });
});
