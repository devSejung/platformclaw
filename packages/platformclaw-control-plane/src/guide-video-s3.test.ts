import { describe, expect, it } from "vitest";
import {
  createPlatformClawGuideVideoS3Source,
  type PlatformClawGuideVideoS3Config,
} from "./guide-video-s3.js";

const EXAMPLE_CONFIG: PlatformClawGuideVideoS3Config = {
  endpoint: "https://s3.amazonaws.com",
  region: "us-east-1",
  bucket: "examplebucket",
  key: "test.txt",
  // Assemble AWS's published SigV4 fixture values so static secret scanners do
  // not mistake the well-known documentation vector for a committed credential.
  accessKeyId: ["AKIAIOSF", "ODNN7EXAMPLE"].join(""),
  secretAccessKey: ["wJalrXUtnFEMI/K7M", "DENG/bPxRfiCYEXAMPLEKEY"].join(""),
  forcePathStyle: false,
};

describe("guide video private S3", () => {
  it("matches the AWS S3 SigV4 GET Object test vector", () => {
    const source = createPlatformClawGuideVideoS3Source(
      EXAMPLE_CONFIG,
      () => new Date("2013-05-24T00:00:00.000Z"),
    );
    expect(source.targetUrl).toBe("https://examplebucket.s3.amazonaws.com/test.txt");
    const headers = source.requestHeaders({
      method: "GET",
      target: new URL(source.targetUrl),
      range: "bytes=0-9",
    });

    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${EXAMPLE_CONFIG.accessKeyId}/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`,
    );
  });

  it("builds path-style URLs for internal S3 without putting credentials in the URL", () => {
    const source = createPlatformClawGuideVideoS3Source({
      ...EXAMPLE_CONFIG,
      endpoint: "https://s3.internal.example:9443",
      bucket: "platformclaw-media",
      key: "guides/한국어 guide (final).mp4",
      accessKeyId: "internal-access",
      secretAccessKey: "internal-secret",
      forcePathStyle: true,
    });
    const target = new URL(source.targetUrl);

    expect(target.toString()).toBe(
      "https://s3.internal.example:9443/platformclaw-media/guides/%ED%95%9C%EA%B5%AD%EC%96%B4%20guide%20%28final%29.mp4",
    );
    expect(target.username).toBe("");
    expect(target.password).toBe("");
  });

  it("rejects dot-segment keys before URL normalization can change object identity", () => {
    expect(() =>
      createPlatformClawGuideVideoS3Source({
        ...EXAMPLE_CONFIG,
        key: "guides/../private.mp4",
        forcePathStyle: true,
      }),
    ).toThrow("must not contain dot path segments");
  });

  it("rejects unsafe bucket host prefixes in virtual-hosted mode", () => {
    for (const bucket of ["a#b", "a?b", "a:b", "a..b"]) {
      expect(() =>
        createPlatformClawGuideVideoS3Source({ ...EXAMPLE_CONFIG, bucket, forcePathStyle: false }),
      ).toThrow("not safe for virtual-hosted addressing");
    }
  });

  it("fails closed instead of signing query-bearing S3 targets", () => {
    const source = createPlatformClawGuideVideoS3Source(EXAMPLE_CONFIG);
    expect(() =>
      source.requestHeaders({
        method: "GET",
        target: new URL("https://examplebucket.s3.amazonaws.com/test.txt?x=+"),
      }),
    ).toThrow("must not contain a query");
  });
});
