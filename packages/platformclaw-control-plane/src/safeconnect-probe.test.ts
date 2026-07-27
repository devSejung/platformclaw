import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { probeSafeConnectEndpoint } from "./safeconnect-probe.js";

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

const hostKeyBlob = Buffer.concat([
  sshString(Buffer.from("ssh-ed25519")),
  sshString(Buffer.alloc(32, 9)),
]);
const hostKey = hostKeyBlob.toString("base64");
const otherHostKeyBlob = Buffer.concat([
  sshString(Buffer.from("ssh-ed25519")),
  sshString(Buffer.alloc(32, 10)),
]);
const otherHostKey = otherHostKeyBlob.toString("base64");

describe("SafeConnect endpoint preflight", () => {
  it("checks DNS, the SSH banner, and derives the ED25519 fingerprint", async () => {
    const readSshBanner = vi.fn(async () => "SSH-2.0-SafeConnect");
    const scanHostKey = vi.fn(async () =>
      [
        "# safeconnect.example.test:44422 SSH-2.0-SafeConnect",
        `safeconnect.example.test ssh-ed25519 ${hostKey} root@server`,
      ].join("\n"),
    );
    const result = await probeSafeConnectEndpoint(
      { host: "SafeConnect.Example.Test", port: 44_422 },
      {
        lookupAll: vi.fn(async () => [
          { address: "192.0.2.20", family: 4 as const },
          { address: "192.0.2.20", family: 4 as const },
        ]) as never,
        readSshBanner,
        scanHostKey,
      },
    );

    expect(result).toEqual({
      host: "safeconnect.example.test",
      port: 44_422,
      resolvedAddresses: ["192.0.2.20"],
      sshBanner: "SSH-2.0-SafeConnect",
      algorithm: "ssh-ed25519",
      publicKey: hostKey,
      fingerprint: `SHA256:${createHash("sha256")
        .update(hostKeyBlob)
        .digest("base64")
        .replace(/=+$/u, "")}`,
    });
    expect(readSshBanner).toHaveBeenCalledWith("192.0.2.20", 44_422);
    expect(scanHostKey).toHaveBeenCalledWith("192.0.2.20", 44_422);
  });

  it("returns an actionable DNS failure", async () => {
    await expect(
      probeSafeConnectEndpoint(
        { host: "missing.example.test", port: 44_422 },
        {
          lookupAll: vi.fn(async () => {
            throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
          }) as never,
        },
      ),
    ).rejects.toThrow("DNS lookup failed");
  });

  it("rejects DNS addresses that expose different ED25519 host keys", async () => {
    await expect(
      probeSafeConnectEndpoint(
        { host: "safeconnect.example.test", port: 44_422 },
        {
          lookupAll: vi.fn(async () => [
            { address: "192.0.2.20", family: 4 },
            { address: "192.0.2.21", family: 4 },
          ]),
          readSshBanner: vi.fn(async () => "SSH-2.0-SafeConnect"),
          scanHostKey: vi.fn(
            async (address) =>
              `${address} ssh-ed25519 ${address === "192.0.2.20" ? hostKey : otherHostKey}`,
          ),
        },
      ),
    ).rejects.toThrow("different ED25519 host keys");
  });

  it("rejects clean EOF when incidental text contains SSH- but no valid banner", async () => {
    const server = createServer((socket) => {
      socket.end("proxy mentioned SSH- without sending a banner\n");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("test server did not bind a TCP port");
    }

    try {
      await expect(
        probeSafeConnectEndpoint(
          { host: "127.0.0.1", port: address.port },
          {
            lookupAll: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
            scanHostKey: vi.fn(async () => `127.0.0.1 ssh-ed25519 ${hostKey}`),
          },
        ),
      ).rejects.toThrow("closed before sending an SSH banner");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });
});
