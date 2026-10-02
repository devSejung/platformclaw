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
    return this.options.spaceService
      ? await this.options.spaceService.conversations.guardNativeRequest(
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
        )
      : await run();
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

  filterResult(access: BrowserGatewayAccess, method: string, result: unknown): unknown {
    if (method !== "sessions.list" || !isRecord(result) || !Array.isArray(result.sessions)) {
      return result;
    }
    return {
      ...result,
      sessions: result.sessions.filter((session) => {
        const key =
          session && typeof session === "object" ? (session as JsonObject).key : undefined;
        return (
          typeof key !== "string" ||
          this.options.spaceService?.conversations.canAccessNative(access.user.id, key) !== false
        );
      }),
    };
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
    return liveCapabilities.filterEvent({
      agentId: access.binding.agentId,
      event,
      context,
      taskEventBelongsToAccess: (payload) =>
        browserTaskEventBelongsToAccess(this.taskAccess(access), payload),
      eventPayloadBelongsToAccess: (payload) =>
        browserEventPayloadBelongsToAccess(this.taskAccess(access), payload),
      projectSessionPayloadForAccess: (payload) => this.projectSessionPayload(access, payload),
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

  projectSessionPayload(access: BrowserGatewayAccess, payload: unknown): JsonObject | null {
    return projectBrowserSessionPayloadForAccess(this.taskAccess(access), payload);
  }
}
