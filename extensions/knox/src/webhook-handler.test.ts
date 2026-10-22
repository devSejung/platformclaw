import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKnoxAccount } from "./accounts.js";
import { KnoxInboundIdentityConflictError } from "./inbound-identity.js";
import type { KnoxInboundMessage } from "./types.js";
import { createKnoxWebhookHandler } from "./webhook-handler.js";

const rawFixture = readFileSync(
  new URL("../test-fixtures/my/self-in-space.json", import.meta.url),
  "utf8",
);
const fixture = JSON.parse(rawFixture) as Extract<KnoxInboundMessage, { schemaVersion: 2 }>;
const invalidFixtures = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/invalid-inbound.json", import.meta.url), "utf8"),
) as Array<{ name: string; request: unknown }>;
const responses = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/inbound-responses.json", import.meta.url), "utf8"),
) as Record<string, { status: number; body: unknown }>;
const secret = "w".repeat(32);
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(
  options: {
    enabled?: boolean;
    duplicate?: boolean;
    admissionUnavailable?: boolean;
    identityConflict?: boolean;
  } = {},
) {
  const account = resolveKnoxAccount({
    channels: {
      knox: {
        webhookSecret: secret,
        serviceToken: "s".repeat(32),
        outboundUrl: "http://cdep.example/outbound/send",
        controlPlaneUrl: "http://control.example/route",
        ...(options.enabled === undefined ? {} : { selfInSpaceEnabled: options.enabled }),
      },
    },
  });
  const admit = vi.fn(async (_message: KnoxInboundMessage) => {
    if (options.identityConflict) {
      throw new KnoxInboundIdentityConflictError();
    }
    if (options.admissionUnavailable) {
      throw new Error("synthetic admission failure");
    }
    return { duplicate: options.duplicate === true };
  });
  const handler = createKnoxWebhookHandler({ account, admit });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind TCP");
  }
  return { admit, url: `http://127.0.0.1:${address.port}${account.webhookPath}` };
}

async function post(url: string, body: string, timestamp = String(Date.now()), signedBody = body) {
  const signature = createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(signedBody, "utf8")
    .digest("hex");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-platformclaw-timestamp": timestamp,
      "x-platformclaw-signature": `sha256=${signature}`,
    },
    body,
  });
  return { status: response.status, body: await response.json() };
}

describe("createKnoxWebhookHandler personal Space contract", () => {
  it("authenticates v2 and rejects the default OFF state before durable admission", async () => {
    const { url, admit } = await listen();
    expect(await post(url, rawFixture)).toEqual(responses.disabled);
    expect(admit).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", -300_001, rawFixture],
    ["mutated signed bytes", 0, JSON.stringify(fixture)],
  ] as const)(
    "rejects %s authentication before disclosing feature state",
    async (_name, age, signedBody) => {
      const { url, admit } = await listen();
      expect(await post(url, rawFixture, String(Date.now() + age), signedBody)).toEqual(
        responses.unauthorized,
      );
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it.each(invalidFixtures)(
    "rejects $name before OFF handling or admission",
    async ({ request }) => {
      const { url, admit } = await listen();
      expect(await post(url, JSON.stringify(request))).toEqual(responses.invalid);
      expect(admit).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "acknowledges enabled v2 after admission (duplicate=%s)",
    async (duplicate) => {
      const { url, admit } = await listen({ enabled: true, duplicate });
      expect(await post(url, rawFixture)).toEqual(
        duplicate ? responses.duplicate : responses.accepted,
      );
      expect(admit).toHaveBeenCalledExactlyOnceWith(fixture);
    },
  );

  it("preserves v1 room and DM admission while v2 remains OFF", async () => {
    const { executionMode: _executionMode, ...common } = fixture;
    const { url, admit } = await listen();
    for (const conversation of [
      common.conversation,
      { ...common.conversation, type: "dm", providerType: "SINGLE" },
    ]) {
      const request = { ...common, schemaVersion: 1, conversation };
      expect(await post(url, JSON.stringify(request))).toEqual(responses.accepted);
      expect(admit).toHaveBeenLastCalledWith(request);
    }
    expect(admit).toHaveBeenCalledTimes(2);
  });

  it("returns 503 when enabled v2 cannot be durably accepted", async () => {
    const { url, admit } = await listen({ enabled: true, admissionUnavailable: true });
    expect(await post(url, rawFixture)).toEqual(responses.admissionUnavailable);
    expect(admit).toHaveBeenCalledOnce();
  });

  it("returns the permanent conflict fixture for a reused identity", async () => {
    const { url, admit } = await listen({ enabled: true, identityConflict: true });
    expect(await post(url, rawFixture)).toEqual(responses.identityConflict);
    expect(admit).toHaveBeenCalledOnce();
  });
});
