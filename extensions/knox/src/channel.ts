import { randomUUID } from "node:crypto";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { listAccountIds, resolveKnoxAccount } from "./accounts.js";
import { KnoxChannelConfigSchema } from "./config-schema.js";
import { startKnoxGatewayAccount } from "./gateway.js";
import { parseKnoxTarget, sendKnoxOutbound } from "./outbound.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

const CHANNEL_ID = "knox";

const configAdapter = createHybridChannelConfigAdapter<ResolvedKnoxAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds,
  resolveAccount: resolveKnoxAccount,
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: [
    "accountId",
    "webhookSecret",
    "webhookSecretFile",
    "outboundUrl",
    "serviceToken",
    "serviceTokenFile",
    "controlPlaneUrl",
    "progressDelayMs",
  ],
  resolveAllowFrom: () => [],
  formatAllowFrom: (allowFrom) => allowFrom.map(String),
});

async function sendProactiveText(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
}) {
  const target = parseKnoxTarget(params.to);
  if (!target) {
    throw new Error("Knox target must use dm:<chatroomId> or room:<chatroomId>");
  }
  const account = resolveKnoxAccount(params.cfg, params.accountId);
  if (!account.configured) {
    throw new Error("Knox relay is not configured");
  }
  const id = randomUUID();
  const inbound: KnoxInboundMessage = {
    schemaVersion: 1,
    eventId: id,
    messageId: id,
    occurredAt: new Date().toISOString(),
    sender: { knoxUserId: "platformclaw", displayName: "PlatformClaw" },
    conversation: {
      type: target.type,
      providerType: target.type === "dm" ? "SINGLE" : "GROUP",
      conversationId: target.conversationId,
    },
    message: { type: "text", text: params.text },
  };
  const messageId = await sendKnoxOutbound({
    context: {
      account,
      inbound,
      agentId: "platformclaw",
      sessionKey: "",
      runId: `knox:proactive:${id}`,
    },
    status: "final",
    text: params.text,
    final: true,
    requestId: `proactive:${id}`,
  });
  return {
    channel: CHANNEL_ID,
    messageId,
    chatId: target.conversationId,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: CHANNEL_ID, messageId }],
      kind: "text",
    }),
  };
}

const messageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: { text: true, messageSendingHooks: true },
  },
  send: {
    text: async (ctx) =>
      await sendProactiveText({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
      }),
  },
});

export const knoxPlugin: ChannelPlugin<ResolvedKnoxAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Knox Teams",
      selectionLabel: "Samsung Knox Teams",
      detailLabel: "Samsung Knox Teams (CDEP relay)",
      docsPath: "/channels/knox",
      blurb: "Connect Samsung Knox Teams through the CDEP relay.",
      order: 75,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: ["channels.knox"] },
    configSchema: KnoxChannelConfigSchema,
    config: configAdapter,
    messaging: {
      targetPrefixes: ["knox"],
      normalizeTarget: (target) => {
        const unprefixed = target.replace(/^knox:/iu, "");
        const parsed = parseKnoxTarget(unprefixed);
        return parsed ? `${parsed.type}:${parsed.conversationId}` : undefined;
      },
      inferTargetChatType: ({ to }) => (parseKnoxTarget(to)?.type === "room" ? "group" : "direct"),
      targetResolver: {
        looksLikeId: (id) => parseKnoxTarget(id) !== null,
        hint: "<dm:chatroomId|room:chatroomId>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const parsed = parseKnoxTarget(target);
        if (!parsed) {
          return null;
        }
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          recipientSessionExact: parsed.type === "dm",
          peer: {
            kind: parsed.type === "dm" ? "direct" : "channel",
            id: `${parsed.type}:${parsed.conversationId}`,
          },
          chatType: parsed.type === "dm" ? "direct" : "group",
          from: `knox:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: `${parsed.type}:${parsed.conversationId}`,
        });
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    status: createComputedAccountStatusAdapter<ResolvedKnoxAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ snapshot }) => ({
        ok: snapshot.configured,
        label: snapshot.configured ? "configured" : "missing relay config",
        detail: snapshot.webhookPath ?? "",
      }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        webhookPath: account.webhookPath,
      }),
    }),
    gateway: { startAccount: startKnoxGatewayAccount },
    message: messageAdapter,
  },
  outbound: {
    base: { deliveryMode: "gateway", textChunkLimit: 3_000 },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, accountId, to, text }) =>
        await sendProactiveText({ cfg, accountId, to, text }),
    },
  },
});
