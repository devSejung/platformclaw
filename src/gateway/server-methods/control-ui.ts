import { GATEWAY_CLIENT_MODES } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { ControlUiGitHubError } from "../control-ui-github-api.js";
import {
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
  type ControlUiGitHubPreviewTarget,
} from "../control-ui-github-preview.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscriptions.js";
import type { GatewayRequestHandlers } from "./types.js";

type LoadGitHubPreview = (
  target: ControlUiGitHubPreviewTarget,
) => ReturnType<typeof loadControlUiGitHubPreview>;

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = loadControlUiGitHubPreview,
): GatewayRequestHandlers {
  return {
    "controlUi.githubPreview": async ({ params, respond }) => {
      const target = parseControlUiGitHubPreviewTarget(params);
      if (!target) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.githubPreview params"),
        );
        return;
      }
      try {
        respond(true, await loadGitHubPreview(target), undefined);
      } catch (error) {
        const statusCode = error instanceof ControlUiGitHubError ? error.statusCode : undefined;
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub preview unavailable", {
            retryable: statusCode === 429 || statusCode === 502,
          }),
        );
      }
    },
    "controlUi.sessionPullRequests.subscribe": async ({ params, client, context, respond }) => {
      const parsed = parseControlUiSessionPullRequestsSubscribeParams(params);
      if (!parsed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "invalid controlUi.sessionPullRequests.subscribe params",
          ),
        );
        return;
      }
      const connId = client?.connId?.trim();
      const subscriptions = context.controlUiSessionPullRequests;
      if (!connId || !subscriptions) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "session pull request subscriptions unavailable"),
        );
        return;
      }
      if (
        parsed.subscriptionId &&
        (client?.connect?.client?.mode !== GATEWAY_CLIENT_MODES.BACKEND ||
          !client.connect.scopes?.includes("operator.admin"))
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.FORBIDDEN,
            "session pull request subscription multiplexing requires a trusted backend",
          ),
        );
        return;
      }
      if (parsed.refreshSessionKeys.length > 0) {
        const refreshSessionKeys = new Set(parsed.refreshSessionKeys);
        if (parsed.subscriptionId) {
          await subscriptions.replace(
            connId,
            parsed.sessionKeys,
            refreshSessionKeys,
            parsed.subscriptionId,
          );
        } else {
          await subscriptions.replace(connId, parsed.sessionKeys, refreshSessionKeys);
        }
      } else if (parsed.subscriptionId) {
        await subscriptions.replace(connId, parsed.sessionKeys, undefined, parsed.subscriptionId);
      } else {
        await subscriptions.replace(connId, parsed.sessionKeys);
      }
      respond(true, { subscribed: parsed.sessionKeys.length > 0 }, undefined);
    },
  };
}

export const controlUiHandlers = createControlUiHandlers();
