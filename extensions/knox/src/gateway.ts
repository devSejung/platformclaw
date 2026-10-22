import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveKnoxAccount } from "./accounts.js";
import { createKnoxInboundIdentityGuard } from "./inbound-identity.js";
import { dispatchKnoxInbound, sendKnoxQueuedNotice } from "./inbound.js";
import { createKnoxIngress } from "./ingress.js";
import { resolveKnoxQuestionAnswerBinding } from "./input-routing.js";
import { createKnoxMyDelivery } from "./my-delivery.js";
import { KnoxRoutingClient, knoxRequestFingerprint } from "./routing-client.js";
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
    resolveQuestionAnswerBinding: async (message) =>
      await resolveKnoxQuestionAnswerBinding({ account, message }),
    notifyQueued: async (message, context) => {
      await sendKnoxQueuedNotice({ account, message, ...context });
    },
    dispatch: async (message, lifecycle, questionAnswerBinding) => {
      await dispatchKnoxInbound({
        account,
        message,
        lifecycle,
        questionAnswerBinding,
        log: ctx.log,
      });
    },
  });
  const personalShutdown = new AbortController();
  const personalSignal = AbortSignal.any([ctx.abortSignal, personalShutdown.signal]);
  const personalDelivery = createKnoxMyDelivery({
    account,
    log: ctx.log,
    abortSignal: personalSignal,
  });
  const personalIngress = createKnoxIngress({
    accountId: account.accountId,
    executionMode: "self_in_space",
    abortSignal: personalSignal,
    log: (message) => ctx.log?.error?.(message),
    notifyQueued: async (message, context) => {
      await sendKnoxQueuedNotice({ account, message, ...context });
    },
    resolveSelfInSpaceRoute: async (message) => {
      const route = await new KnoxRoutingClient({
        url: account.controlPlaneUrl,
        token: account.serviceToken,
      }).resolve({
        accountId: account.accountId,
        conversationType: message.conversation.type,
        conversationId: message.conversation.conversationId,
        knoxUserId: message.sender.knoxUserId,
        executionMode: "self_in_space",
        requestId: message.messageId,
        requestFingerprint: knoxRequestFingerprint(message),
        operation: "reserve",
      });
      await personalDelivery.admit(message, route);
      return route;
    },
    dispatch: async (message, lifecycle, _questionAnswerBinding, route) => {
      if (!route) {
        throw new Error("Knox personal request is missing its admitted target");
      }
      await personalDelivery.withRequest({
        message,
        route,
        lifecycle,
        run: async (scope) =>
          await dispatchKnoxInbound({
            account,
            message,
            lifecycle: { ...lifecycle, abortSignal: scope.abortSignal },
            selfInSpace: { route, ...scope },
            log: ctx.log,
          }),
      });
    },
  });
  const identityGuard = createKnoxInboundIdentityGuard({
    hasLegacyReceipt: ingress.has,
    hasPersonalReceipt: personalIngress.has,
  });
  ingress.start();
  let personalAvailable = false;
  try {
    personalIngress.start();
    personalAvailable = true;
  } catch (error) {
    ctx.log?.error?.(`Knox personal ingress unavailable: ${String(error)}`);
  }
  let recoveryTask: Promise<void> | undefined;
  const recover = (): Promise<void> => {
    if (personalSignal.aborted) {
      return Promise.resolve();
    }
    return (recoveryTask ??= personalDelivery
      .recover()
      .catch((error: unknown) =>
        ctx.log?.error?.(`Knox personal delivery recovery failed: ${String(error)}`),
      )
      .finally(() => {
        recoveryTask = undefined;
      }));
  };
  // Slow recovery must not delay ordinary webhook availability.
  void recover();
  const recoveryTimer = setInterval(() => {
    void recover();
  }, 10_000);
  recoveryTimer.unref?.();
  const stop = async () => {
    clearInterval(recoveryTimer);
    personalShutdown.abort();
    await recoveryTask;
    await ingress.stop();
    await personalIngress.stop();
  };
  let unregister: (() => void) | undefined;
  try {
    unregister = registerPluginHttpRoute({
      path: account.webhookPath,
      auth: "plugin",
      pluginId: "knox",
      accountId: account.accountId,
      handler: createKnoxWebhookHandler({
        account,
        admit: async (message) => {
          await identityGuard.assertInboundIdentity(message, account.accountId);
          if (message.schemaVersion === 2) {
            if (!personalAvailable) {
              throw new Error("Knox personal ingress is unavailable");
            }
            return await personalIngress.admit(message);
          }
          return await ingress.admit(message);
        },
        log: ctx.log,
      }),
      log: (message) => ctx.log?.info?.(message),
    });
  } catch (error) {
    await stop();
    throw error;
  }
  ctx.log?.info?.(`Knox relay route active: ${account.webhookPath}`);
  await waitUntilAbort(ctx.abortSignal, async () => {
    unregister?.();
    await stop();
  });
}
