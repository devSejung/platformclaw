import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OrganizationMemoryClient, VaultTurnScope } from "./client.js";

const NAMESPACE = "vault-connections";

function readScope(value: unknown): VaultTurnScope {
  const scope = asOptionalRecord(value);
  if (
    !scope ||
    !Number.isSafeInteger(scope.revision) ||
    (scope.revision as number) < 0 ||
    !Array.isArray(scope.vaultIds) ||
    scope.vaultIds.length > 256 ||
    new Set(scope.vaultIds).size !== scope.vaultIds.length ||
    !scope.vaultIds.every(
      (id): id is string =>
        typeof id === "string" && id.length <= 512 && /^[a-zA-Z0-9:._-]+$/u.test(id),
    )
  ) {
    throw new Error("Invalid vault connection snapshot");
  }
  return { revision: scope.revision as number, vaultIds: scope.vaultIds };
}

/** The host owns run-state cleanup; retries reuse the first prepared selection. */
export function createVaultTurnScopeController(
  api: Pick<OpenClawPluginApi, "runContext" | "logger">,
  client: Pick<OrganizationMemoryClient, "captureScope">,
) {
  return {
    async prepare(context: { runId?: string; agentId?: string }) {
      const { runId, agentId } = context;
      if (
        !runId ||
        !agentId ||
        api.runContext.getRunContext({ runId, namespace: NAMESPACE }) !== undefined
      ) {
        return;
      }
      // Reserve before awaiting so retries cannot observe a newer connection list.
      if (
        !api.runContext.setRunContext({
          runId,
          namespace: NAMESPACE,
          value: { agentId, status: "pending" },
        })
      ) {
        return;
      }
      try {
        const scope = readScope(await client.captureScope({ agentId }));
        api.runContext.setRunContext({
          runId,
          namespace: NAMESPACE,
          value: { agentId, status: "ready", scope },
        });
      } catch (error) {
        api.runContext.setRunContext({
          runId,
          namespace: NAMESPACE,
          value: { agentId, status: "failed" },
        });
        api.logger.warn(
          `Vault connections unavailable for this turn: ${formatErrorMessage(error).slice(0, 500)}`,
        );
      }
    },
    get(this: void, context: { runId?: string; agentId: string }): VaultTurnScope | undefined {
      if (!context.runId) {
        // Direct gateway/UI reads have no model turn and use current server selection.
        return undefined;
      }
      const state = asOptionalRecord(
        api.runContext.getRunContext({ runId: context.runId, namespace: NAMESPACE }),
      );
      if (!state) {
        const error = "Vault connections are unavailable for this turn.";
        const action =
          "Retry in your next message. If this persists, enable hooks.allowPromptInjection and hooks.allowConversationAccess for the platformclaw-org-memory plugin, then restart the gateway.";
        throw Object.assign(new Error(`${error} ${action}`), {
          memoryCorpusFailure: { error, action },
        });
      }
      if (state.status !== "ready" || state.agentId !== context.agentId) {
        const error = "Vault connections are unavailable for this turn.";
        const action = "Retry in your next message.";
        throw Object.assign(new Error(`${error} ${action}`), {
          memoryCorpusFailure: { error, action },
        });
      }
      return readScope(state.scope);
    },
  };
}
