import { createHash, createHmac } from "node:crypto";

export type PlatformClawGuideVideoS3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type PlatformClawGuideVideoRequestHeaders = (params: {
  method: "GET" | "HEAD";
  target: URL;
  range?: string;
}) => Record<string, string>;

const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeS3Key(key: string): string {
  return key.split("/").map(awsEncode).join("/");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function amzDate(date: Date): { shortDate: string; timestamp: string } {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return { shortDate: timestamp.slice(0, 8), timestamp };
}

function resolvePlatformClawGuideVideoS3Url(config: PlatformClawGuideVideoS3Config): URL {
  if (config.key.split("/").some((segment) => segment === "." || segment === "..")) {
    // WHATWG URL parsing normalizes dot segments, while S3 object-key paths are
    // byte-sensitive. Fail closed rather than signing/fetching another object.
    throw new Error("PlatformClaw guide video S3 key must not contain dot path segments");
  }
  const endpoint = new URL(config.endpoint);
  const target = new URL(endpoint.toString());
  const encodedKey = encodeS3Key(config.key);
  if (config.forcePathStyle) {
    target.pathname = `/${awsEncode(config.bucket)}/${encodedKey}`;
  } else {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(config.bucket) ||
      config.bucket.includes("..")
    ) {
      throw new Error(
        "PlatformClaw guide video S3 bucket is not safe for virtual-hosted addressing",
      );
    }
    const expectedHostname = `${config.bucket}.${target.hostname}`.toLowerCase();
    target.hostname = `${config.bucket}.${target.hostname}`;
    if (target.hostname !== expectedHostname) {
      throw new Error(
        "PlatformClaw guide video S3 bucket is not safe for virtual-hosted addressing",
      );
    }
    target.pathname = `/${encodedKey}`;
  }
  return target;
}

function createPlatformClawGuideVideoS3RequestHeaders(
  config: PlatformClawGuideVideoS3Config,
  now: () => Date = () => new Date(),
): PlatformClawGuideVideoRequestHeaders {
  return ({ method, target, range }) => {
    if (target.search) {
      throw new Error("PlatformClaw guide video signed S3 target must not contain a query");
    }
    const { shortDate, timestamp } = amzDate(now());
    const canonicalHeaderValues = new Map<string, string>([
      ["host", target.host],
      ["x-amz-content-sha256", EMPTY_PAYLOAD_SHA256],
      ["x-amz-date", timestamp],
    ]);
    if (range) {
      canonicalHeaderValues.set("range", range.trim());
    }
    const signedHeaderNames = [...canonicalHeaderValues.keys()].toSorted();
    const canonicalHeaders = `${signedHeaderNames
      .map(
        (name) => `${name}:${canonicalHeaderValues.get(name)?.trim().replace(/\s+/gu, " ") ?? ""}`,
      )
      .join("\n")}\n`;
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      method,
      target.pathname || "/",
      "",
      canonicalHeaders,
      signedHeaders,
      EMPTY_PAYLOAD_SHA256,
    ].join("\n");
    const scope = `${shortDate}/${config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join(
      "\n",
    );
    const dateKey = hmac(`AWS4${config.secretAccessKey}`, shortDate);
    const regionKey = hmac(dateKey, config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    return {
      host: target.host,
      ...(range ? { range: range.trim() } : {}),
      "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
      "x-amz-date": timestamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    };
  };
}

export function createPlatformClawGuideVideoS3Source(
  config: PlatformClawGuideVideoS3Config,
  now?: () => Date,
): { targetUrl: string; requestHeaders: PlatformClawGuideVideoRequestHeaders } {
  return {
    targetUrl: resolvePlatformClawGuideVideoS3Url(config).toString(),
    requestHeaders: createPlatformClawGuideVideoS3RequestHeaders(config, now),
  };
}
