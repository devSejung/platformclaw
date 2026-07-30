import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveKnoxAccount } from "./accounts.js";
import { createKnoxIngress } from "./ingress.js";
import { dispatchKnoxInbound } from "./inbound.js";
import { createKnoxWebhookHandler } from "./webhook-handler.js";

export async function startKnoxGatewayAccount(ctx: {
  cfg: OpenClawConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
}): Promise<void> {
  const account = resolveKnoxAccount(ctx.cfg, ctx.accountId);
  if (!account.enabled) {
    return await waitUntilAbort(ctx.abortSignal);
  }
  if (!account.configured) {
    throw new Error(`Knox account ${account.accountId} is missing relay configuration`);
  }
  const ingress = createKnoxIngress({
    accountId: account.accountId,
    abortSignal: ctx.abortSignal,
    log: (message) => ctx.log?.error?.(message),
    dispatch: async (message, lifecycle) => {
      await dispatchKnoxInbound({ account, message, lifecycle, log: ctx.log });
    },
  });
  ingress.start();
  let unregister: (() => void) | undefined;
  try {
    unregister = registerPluginHttpRoute({
      path: account.webhookPath,
      auth: "plugin",
      pluginId: "knox",
      accountId: account.accountId,
      handler: createKnoxWebhookHandler({ account, admit: ingress.admit, log: ctx.log }),
      log: (message) => ctx.log?.info?.(message),
    });
  } catch (error) {
    await ingress.stop();
    throw error;
  }
  ctx.log?.info?.(`Knox relay route active: ${account.webhookPath}`);
  await waitUntilAbort(ctx.abortSignal, async () => {
    unregister?.();
    await ingress.stop();
  });
}
