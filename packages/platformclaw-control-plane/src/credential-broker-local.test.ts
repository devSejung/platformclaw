import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OneShotCredentialGrantStore } from "./credential-broker-grants.js";
import {
  LocalCredentialBrokerServer,
  redeemLocalCredentialGrant,
} from "./credential-broker-local.js";

const servers: LocalCredentialBrokerServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

function brokerAddress(): { address: string; parent?: string } {
  if (process.platform === "win32") {
    return { address: String.raw`\\.\pipe\platformclaw-credential-${process.pid}-${randomUUID()}` };
  }
  const parent = mkdtempSync(join(tmpdir(), "platformclaw-credential-broker-"));
  return { address: join(parent, "broker.sock"), parent };
}

describe("LocalCredentialBrokerServer", () => {
  it("transfers password bytes through one local one-shot grant", async () => {
    const target = brokerAddress();
    const grants = new OneShotCredentialGrantStore();
    const server = new LocalCredentialBrokerServer({
      address: target.address,
      grants,
      maxConnections: 1,
    });
    servers.push(server);
    await server.listen();
    const grant = grants.issue(async () => ({
      password: Buffer.from("AD password with spaces 한글", "utf8"),
      revision: 7,
    }));

    const credential = await redeemLocalCredentialGrant({
      address: target.address,
      token: grant.token,
    });
    expect(credential.password.toString("utf8")).toBe("AD password with spaces 한글");
    expect(credential.revision).toBe(7);
    credential.password.fill(0);
    await expect(
      redeemLocalCredentialGrant({ address: target.address, token: grant.token }),
    ).rejects.toThrow("rejected the grant");

    if (process.platform !== "win32") {
      expect(statSync(target.address).mode & 0o777).toBe(0o600);
      expect(statSync(target.parent!).mode & 0o777).toBe(0o700);
    }
  });

  it("does not expose vault errors across the IPC boundary", async () => {
    const target = brokerAddress();
    const grants = new OneShotCredentialGrantStore();
    const server = new LocalCredentialBrokerServer({ address: target.address, grants });
    servers.push(server);
    await server.listen();
    const grant = grants.issue(async () => {
      throw new Error("sensitive database detail");
    });

    await expect(
      redeemLocalCredentialGrant({ address: target.address, token: grant.token }),
    ).rejects.toThrow("rejected the grant");
  });

  it("bounds server responses and handles post-listen errors without process failure", async () => {
    const target = brokerAddress();
    const grants = new OneShotCredentialGrantStore();
    const server = new LocalCredentialBrokerServer({ address: target.address, grants });
    servers.push(server);
    await server.listen();
    const oversizedPassword = Buffer.alloc(8 * 1024 + 1, 1);
    const oversized = grants.issue(async () => ({
      password: oversizedPassword,
      revision: 1,
    }));
    await expect(
      redeemLocalCredentialGrant({ address: target.address, token: oversized.token }),
    ).rejects.toThrow("rejected the grant");
    expect(oversizedPassword.every((byte) => byte === 0)).toBe(true);

    const runtimeServer = (server as unknown as { server?: Server }).server;
    expect(runtimeServer).toBeDefined();
    expect(() => runtimeServer?.emit("error", new Error("simulated accept failure"))).not.toThrow();
    expect(() => server.assertAvailable()).toThrow("unavailable");
  });

  it.runIf(process.platform !== "win32")(
    "refuses shared parent directories and existing broker sockets",
    async () => {
      const weakParent = brokerAddress();
      chmodSync(weakParent.parent!, 0o755);
      const weakServer = new LocalCredentialBrokerServer({
        address: weakParent.address,
        grants: new OneShotCredentialGrantStore(),
      });
      await expect(weakServer.listen()).rejects.toThrow("owner-only directory");

      const target = brokerAddress();
      const firstGrants = new OneShotCredentialGrantStore();
      const first = new LocalCredentialBrokerServer({
        address: target.address,
        grants: firstGrants,
      });
      servers.push(first);
      await first.listen();
      const second = new LocalCredentialBrokerServer({
        address: target.address,
        grants: new OneShotCredentialGrantStore(),
      });
      await expect(second.listen()).rejects.toThrow("path already exists");

      const grant = firstGrants.issue(async () => ({
        password: Buffer.from("first broker remains live"),
        revision: 1,
      }));
      const credential = await redeemLocalCredentialGrant({
        address: target.address,
        token: grant.token,
      });
      expect(credential.password.toString("utf8")).toBe("first broker remains live");
      credential.password.fill(0);
    },
  );
});
