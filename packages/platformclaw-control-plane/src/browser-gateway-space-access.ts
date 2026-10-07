import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  asBrowserGatewayObject as asObject,
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
  type BrowserGatewayEvent,
  type BrowserGatewayProxyOptions,
  type BrowserGatewayRequestContext,
} from "./browser-gateway-contracts.js";
import type { BrowserGatewayLiveCapabilities } from "./browser-gateway-live-capabilities.js";
import {
  browserEventPayloadBelongsToAccess,
  browserPayloadBelongsToAccess,
  projectBrowserSessionPayloadForAccess,
} from "./browser-gateway-ownership.js";
import { browserTaskEventBelongsToAccess } from "./browser-gateway-task-policy.js";
import { isSpaceConversationSession } from "./space-contracts.js";

type JsonObject = Record<string, unknown>;

/** Applies Space registry authority to the browser's otherwise personal Gateway access. */
export class BrowserGatewaySpaceAccess {
  constructor(
    private readonly options: Pick<
      BrowserGatewayProxyOptions,
      "spaceService" | "resolveAgentIdFromSessionKey"
    >,
    private readonly resolveAccess: (token: string) => Promise<BrowserGatewayAccess>,
  ) {}

  allowsAgentSession(agentId: string, sessionKey: string, write: boolean): boolean {
    const service = this.options.spaceService;
    if (!service) {
      return true;
    }
    try {
      return service.conversations.canAccessNative(
        service.spaces.userForAgent(agentId),
        sessionKey,
        write,
      );
    } catch {
      return false;
    }
  }

  async guardRequest<T>(
    token: string,
    access: BrowserGatewayAccess,
    method: string,
    params: unknown,
    context: BrowserGatewayRequestContext | undefined,
    run: (validateAdmission?: () => void) => Promise<T>,
  ): Promise<T> {
    const service = this.options.spaceService;
    if (!service) {
      return await run();
    }
    const result = await service.conversations.guardNativeRequest(
      access.user.id,
      method,
      params,
      async () => {
        const current = await this.resolveAccess(token);
        if (current.user.id !== access.user.id || context?.isConnected?.() === false) {
          throw new BrowserGatewayProxyError("unauthenticated", "Browser session changed");
        }
      },
      run,
    );
    // The outer authentication await can outlive the local Space handler's ACL check.
    // Recheck at this final boundary before returning any Space content to a stale tab.
    if (method === "platformclaw.spaces.conversation.resolve" && isRecord(params)) {
      return service.conversations.resolveRoute(
        access.user.id,
        access.binding.agentId,
        params,
      ) as T;
    }
    if (method === "platformclaw.spaces.list") {
      return service.spaces.list(access.user.id, true) as T;
    }
    if (
      method.startsWith("platformclaw.spaces.") &&
      isRecord(params) &&
      typeof params.spaceId === "string" &&
      ![
        "platformclaw.spaces.member.remove",
        "platformclaw.spaces.leave",
        "platformclaw.spaces.delete",
      ].includes(method)
    ) {
      service.spaces.access(
        access.user.id,
        params.spaceId,
        method.endsWith(".people") ? "owner" : "viewer",
      );
    }
    return result;
  }

  suppressCommandInterpretation(sessionKey: unknown, initialSuppressed: boolean): boolean {
    return typeof sessionKey === "string" &&
      this.options.spaceService?.spaces.registeredConversation(sessionKey)
      ? true
      : initialSuppressed;
  }

  assertTaskResult(access: BrowserGatewayAccess, method: string, result: unknown): void {
    const task = asObject(asObject(result, "task result").task, "task");
    this.assertRequest(access, method, {
      sessionKeys: [task.sessionKey, task.childSessionKey, task.ownerKey],
    });
  }

  assertRequest(access: BrowserGatewayAccess, method: string, params: unknown): void {
    this.options.spaceService?.conversations.assertNativeRequest(access.user.id, method, params);
  }

  private isPersonalSession(sessionKey: string): boolean {
    return (
      !isSpaceConversationSession(sessionKey) &&
      !this.options.spaceService?.spaces.registeredConversation(sessionKey)
    );
  }

  prepareSessionSearch(access: BrowserGatewayAccess, params: JsonObject): JsonObject {
    return {
      ...params,
      agentId: access.binding.agentId,
      sessionKeys: (params.sessionKeys as string[])
        .map((key) => key.trim())
        .filter((key) => this.isPersonalSession(key)),
    };
  }

  projectSessionSearch(
    access: BrowserGatewayAccess,
    prepared: JsonObject,
    result: unknown,
  ): JsonObject {
    const payload = asObject(result, "sessions.search result");
    const results = Array.isArray(payload.results) ? payload.results : [];
    const requestedKeys = new Set(prepared.sessionKeys as string[]);
    if (
      results.some(
        (entry) =>
          !this.payloadBelongsToAccess(access, entry) ||
          !requestedKeys.has((entry as JsonObject).sessionKey as string),
      )
    ) {
      throw new BrowserGatewayProxyError(
        "upstream-result-denied",
        "Gateway returned a search result outside the browser binding",
      );
    }
    return payload;
  }

  async filterEvent(
    token: string,
    event: BrowserGatewayEvent,
    context: BrowserGatewayRequestContext | undefined,
    authorizedAccess: BrowserGatewayAccess | undefined,
    liveCapabilities: BrowserGatewayLiveCapabilities,
  ): Promise<BrowserGatewayEvent | null> {
    let access = authorizedAccess;
    if (!access) {
      try {
        // Server-pushed traffic must not keep an unattended browser session alive.
        access = await this.resolveAccess(token);
      } catch {
        return null;
      }
    }
    const spaceEvent = this.options.spaceService?.event(access.user.id, event);
    if (spaceEvent !== undefined) {
      return spaceEvent;
    }
    const eventKey = isRecord(event.payload)
      ? (event.payload.sessionKey ?? event.payload.key)
      : undefined;
    // Space panes need native lifecycle and cursorless transcript invalidations.
    // Only ordinary-root catalog updates should hide Space lineage metadata.
    const personalCatalog =
      event.event === "sessions.changed" &&
      (typeof eventKey !== "string" || this.isPersonalSession(eventKey.trim()));
    return liveCapabilities.filterEvent({
      agentId: access.binding.agentId,
      event,
      context,
      taskEventBelongsToAccess: (payload) =>
        browserTaskEventBelongsToAccess(this.taskAccess(access), payload),
      eventPayloadBelongsToAccess: (payload) =>
        browserEventPayloadBelongsToAccess(this.taskAccess(access), payload),
      projectSessionPayloadForAccess: (payload) =>
        this.projectSessionPayload(access, payload, personalCatalog),
    });
  }

  taskAccess(access: BrowserGatewayAccess) {
    return {
      agentId: access.binding.agentId,
      resolveAgentIdFromSessionKey: (sessionKey: string) =>
        this.options.spaceService?.conversations.canAccessNative(access.user.id, sessionKey) ===
        false
          ? null
          : this.options.resolveAgentIdFromSessionKey(sessionKey),
    };
  }

  payloadBelongsToAccess(access: BrowserGatewayAccess, payload: unknown): boolean {
    return browserPayloadBelongsToAccess(this.taskAccess(access), payload);
  }

  projectSessionPayload(
    access: BrowserGatewayAccess,
    payload: unknown,
    personalCatalog = false,
  ): JsonObject | null {
    const ownership = this.taskAccess(access);
    return projectBrowserSessionPayloadForAccess(
      personalCatalog
        ? {
            ...ownership,
            resolveAgentIdFromSessionKey: (key) =>
              this.isPersonalSession(key) ? ownership.resolveAgentIdFromSessionKey(key) : null,
          }
        : ownership,
      payload,
    );
  }
}
