type JsonObject = Record<string, unknown>;

type BrowserGatewayAssertionErrorCode =
  | "method-not-allowed"
  | "invalid-params"
  | "cross-agent-denied"
  | "upstream-result-denied";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class BrowserGatewayAssertions {
  constructor(
    private readonly resolveAgentIdFromSessionKey: (sessionKey: string) => string | null,
    private readonly allowedParams: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly fail: (code: BrowserGatewayAssertionErrorCode, message: string) => never,
  ) {}

  optionalAgentId(agentId: string, rawAgentId: unknown, label: string): void {
    const requestedAgentId = optionalString(rawAgentId);
    if (requestedAgentId && requestedAgentId !== agentId) {
      this.fail("cross-agent-denied", `browser access denied for ${label}`);
    }
  }

  ownedSessionKey(agentId: string, rawSessionKey: unknown, label: string): void {
    const sessionKey = optionalString(rawSessionKey);
    if (!sessionKey) {
      this.fail("invalid-params", `${label} is required`);
    }
    if (this.resolveAgentIdFromSessionKey(sessionKey) !== agentId) {
      this.fail("cross-agent-denied", `browser access denied for ${label}`);
    }
  }

  sessionKeyArray(agentId: string, value: unknown, label: string, required: boolean): void {
    if (value === undefined && !required) {
      return;
    }
    if (!Array.isArray(value) || (required && value.length === 0)) {
      this.fail("invalid-params", `${label} must be a non-empty array`);
    }
    for (const sessionKey of value) {
      this.ownedSessionKey(agentId, sessionKey, label);
    }
  }

  ownedResultSessionKey(agentId: string, rawSessionKey: unknown): void {
    const sessionKey = optionalString(rawSessionKey);
    if (!sessionKey || this.resolveAgentIdFromSessionKey(sessionKey) !== agentId) {
      this.fail("upstream-result-denied", "Gateway returned a session outside the browser binding");
    }
  }

  methodParams(method: string, params: JsonObject): void {
    const allowed = this.allowedParams.get(method);
    if (!allowed) {
      this.fail("method-not-allowed", `Gateway method has no browser parameter policy: ${method}`);
    }
    const disallowed = Object.keys(params).find((key) => !allowed.has(key));
    if (disallowed) {
      this.fail(
        "method-not-allowed",
        `Gateway parameter is not available to browser users: ${method}.${disallowed}`,
      );
    }
  }
}
