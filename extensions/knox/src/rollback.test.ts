import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { expect, it } from "vitest";
import { parseKnoxRoute } from "./routing-client.js";

const message = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/self-in-space.json", import.meta.url), "utf8"),
);
const route = parseKnoxRoute(
  JSON.parse(
    readFileSync(new URL("../test-fixtures/my/resolved-route.json", import.meta.url), "utf8"),
  ),
);
const admitted = { ...message, selfInSpaceRoute: route };
const { rollback } = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/lifecycle.json", import.meta.url), "utf8"),
) as {
  rollback: { queueNamespace: string; payloadVersion: number; legacyConsumerMayRead: boolean };
};

it("preserves accepted v2 in a separate SQLite queue across restart and consumer downgrade", async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "knox-my-rollback-")));
  const open = (accountId: string, queueNamespace?: string) =>
    createChannelIngressQueueForTests({ channelId: "knox", accountId, queueNamespace, stateDir });
  try {
    const personal = open("default", rollback.queueNamespace);
    const suffixAccountId = `default:${rollback.queueNamespace}`;
    const { executionMode: _executionMode, ...legacyMessage } = message;
    const legacyPayload = {
      version: 1,
      rawEvent: JSON.stringify({
        ...legacyMessage,
        schemaVersion: 1,
        messageId: "another-account-message",
      }),
    };
    await open(suffixAccountId).enqueue("another-account-message", legacyPayload);
    await personal.enqueue(message.messageId, {
      version: rollback.payloadVersion,
      rawEvent: JSON.stringify(admitted),
    });
    closeOpenClawStateDatabaseForTest();
    // Old binaries open only two-part queue identities, including account IDs
    // containing the namespace text. They cannot read the third-part namespace.
    const legacy = open("default");
    expect(rollback.legacyConsumerMayRead).toBe(false);
    expect(await legacy.listPending()).toEqual([]);
    expect(await legacy.claimNext()).toBeNull();
    const suffixAccount = open(suffixAccountId);
    expect(await suffixAccount.has?.(message.messageId)).toBe(false);
    expect((await suffixAccount.claimNext())?.payload).toEqual(legacyPayload);
    const restored = await open("default", rollback.queueNamespace).listPending();
    expect(restored).toHaveLength(1);
    expect(route?.status).toBe("resolved");
    expect(restored[0]!.payload).toEqual({ version: 2, rawEvent: JSON.stringify(admitted) });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await rm(stateDir, { recursive: true, force: true });
  }
});
