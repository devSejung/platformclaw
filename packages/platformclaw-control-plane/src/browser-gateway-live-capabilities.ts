import {
  BrowserGatewayProxyError,
  type BrowserGatewayEvent,
  type BrowserGatewayProxyErrorCode,
  type BrowserGatewayRpc,
  type BrowserGatewayRequestContext,
} from "./browser-gateway-contracts.js";
import {
  type BrowserCronContext,
  requestSpecialCronResult,
} from "./browser-gateway-cron-controller.js";
import { projectBrowserGatewayEvent } from "./browser-gateway-event-policy.js";
import { BrowserGatewayInteractiveOwnership } from "./browser-gateway-interactive-ownership.js";
import { BrowserGatewaySessionMessageSubscriptions } from "./browser-gateway-session-message-subscriptions.js";
import { BrowserGatewaySessionPullRequestSubscriptions } from "./browser-gateway-session-pull-requests.js";

type JsonObject = Record<string, unknown>;
type SpecialRequestResult = { handled: false } | { handled: true; result: unknown };

const INTERACTIVE_METHOD_PREFIXES = ["approval.", "question.", "taskSuggestions."];

export class BrowserGatewayLiveCapabilities {
  private readonly interactiveOwnership: BrowserGatewayInteractiveOwnership;
  private readonly messageSubscriptions: BrowserGatewaySessionMessageSubscriptions;
  private readonly pullRequestSubscriptions: BrowserGatewaySessionPullRequestSubscriptions;

  constructor(
    gateway: BrowserGatewayRpc,
    private readonly resolveAgentIdFromSessionKey: (sessionKey: string) => string | null,
    private readonly fail: (code: BrowserGatewayProxyErrorCode, message: string) => never,
  ) {
    this.interactiveOwnership = new BrowserGatewayInteractiveOwnership(gateway, fail);
    this.messageSubscriptions = new BrowserGatewaySessionMessageSubscriptions(gateway, () =>
      fail("invalid-params", "browser connection is no longer active"),
    );
    this.pullRequestSubscriptions = new BrowserGatewaySessionPullRequestSubscriptions(
      gateway,
      (sessionKey) => resolveAgentIdFromSessionKey(sessionKey),
      () => fail("invalid-params", "browser connection is no longer active"),
    );
  }

  prepareRequest(
    method: string,
    params: JsonObject,
    assertSessionKeys: (values: unknown, field: string) => void,
  ): boolean {
    if (INTERACTIVE_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
      return true;
    }
    if (method !== "controlUi.sessionPullRequests.subscribe") {
      if (
        method === "sessions.messages.subscribe" &&
        params.includeApprovals !== undefined &&
        params.includeApprovals !== true
      ) {
        return this.fail("invalid-params", "includeApprovals must be true when provided");
      }
      return false;
    }
    if (!Array.isArray(params.sessionKeys)) {
      return this.fail("invalid-params", "sessionKeys must be an array");
    }
    assertSessionKeys(params.sessionKeys, "sessionKeys");
    assertSessionKeys(params.refreshSessionKeys, "refreshSessionKeys");
    return true;
  }

  async requestSpecial(options: {
    agentId: string;
    method: string;
    params: JsonObject;
    context?: BrowserGatewayRequestContext;
    cronContext: BrowserCronContext;
    auditDenied: (reason: BrowserGatewayProxyErrorCode) => Promise<void>;
  }): Promise<SpecialRequestResult> {
    try {
      const cronResult = await requestSpecialCronResult(
        options.cronContext,
        options.method,
        options.params,
      );
      if (cronResult.handled) {
        return cronResult;
      }
      return await this.requestInteractive(options);
    } catch (error) {
      if (error instanceof BrowserGatewayProxyError) {
        await options.auditDenied(error.code);
      }
      throw error;
    }
  }

  filterEvent(options: {
    agentId: string;
    event: BrowserGatewayEvent;
    context?: BrowserGatewayRequestContext;
    taskEventBelongsToAccess: (payload: unknown) => boolean;
    eventPayloadBelongsToAccess: (payload: unknown) => boolean;
  }): BrowserGatewayEvent | null {
    return projectBrowserGatewayEvent({
      event: options.event,
      agentId: options.agentId,
      connectionId: options.context?.connectionId,
      interactiveAccess: this.access(options.agentId),
      interactiveOwnership: this.interactiveOwnership,
      pullRequestSubscriptions: this.pullRequestSubscriptions,
      sessionKeyBelongsToAgent: (sessionKey) =>
        this.resolveAgentIdFromSessionKey(sessionKey) === options.agentId,
      taskEventBelongsToAccess: options.taskEventBelongsToAccess,
      eventPayloadBelongsToAccess: options.eventPayloadBelongsToAccess,
    });
  }

  projectApprovalReplay(agentId: string, replay: unknown): unknown {
    return this.interactiveOwnership.projectApprovalReplay(this.access(agentId), replay);
  }

  projectResult(agentId: string, method: string, result: unknown): SpecialRequestResult {
    if (method !== "sessions.messages.subscribe") {
      return { handled: false };
    }
    if (result !== undefined && (!result || typeof result !== "object" || Array.isArray(result))) {
      return this.fail("invalid-params", `${method} result must be an object`);
    }
    const payload = { ...(result as JsonObject | undefined) };
    return {
      handled: true,
      result:
        payload.approvalReplay === undefined
          ? payload
          : {
              ...payload,
              approvalReplay: this.projectApprovalReplay(agentId, payload.approvalReplay),
            },
    };
  }

  registerConnection(connectionId: string): void {
    this.messageSubscriptions.registerConnection(connectionId);
    this.pullRequestSubscriptions.registerConnection(connectionId);
  }

  handleGatewayDisconnect(): void {
    this.pullRequestSubscriptions.handleGatewayDisconnect();
  }

  async releaseConnection(connectionId: string): Promise<void> {
    await Promise.allSettled([
      this.messageSubscriptions.releaseConnection(connectionId),
      this.pullRequestSubscriptions.releaseConnection(connectionId),
    ]);
  }

  private access(agentId: string) {
    return {
      agentId,
      resolveAgentIdFromSessionKey: this.resolveAgentIdFromSessionKey,
    };
  }

  private async requestInteractive(options: {
    agentId: string;
    method: string;
    params: JsonObject;
    context?: BrowserGatewayRequestContext;
  }): Promise<SpecialRequestResult> {
    if (
      options.method === "sessions.messages.subscribe" ||
      options.method === "sessions.messages.unsubscribe"
    ) {
      if (!options.context?.connectionId) {
        return this.fail(
          "invalid-params",
          "session message subscription requires a browser connection",
        );
      }
      const result =
        options.method === "sessions.messages.subscribe"
          ? await this.messageSubscriptions.subscribe(options.context.connectionId, {
              key: options.params.key as string,
              agentId: options.params.agentId as string | undefined,
              ...(options.params.includeApprovals === true ? { includeApprovals: true } : {}),
            })
          : await this.messageSubscriptions.unsubscribe(options.context.connectionId, {
              key: options.params.key as string,
              agentId: options.params.agentId as string | undefined,
            });
      if (options.method === "sessions.messages.subscribe") {
        return this.projectResult(options.agentId, options.method, result);
      }
      return { handled: true, result };
    }
    if (options.method === "controlUi.sessionPullRequests.subscribe") {
      if (!options.context?.connectionId) {
        return this.fail(
          "invalid-params",
          "session pull request subscription requires a browser connection",
        );
      }
      return {
        handled: true,
        result: await this.pullRequestSubscriptions.replace(
          options.context.connectionId,
          options.params.sessionKeys as string[],
          options.params.refreshSessionKeys as string[] | undefined,
        ),
      };
    }
    return await this.interactiveOwnership.request(
      this.access(options.agentId),
      options.method,
      options.params,
    );
  }
}
