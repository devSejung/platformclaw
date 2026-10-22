import { randomUUID } from "node:crypto";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { textResult } from "openclaw/plugin-sdk/tool-results";

const PLATFORMCLAW_CREDENTIAL_TOOL_NAME = "platformclaw_credentials";

type CredentialDefinition = { envName: string; configured: boolean };
type PlatformClawCredentialMetadata =
  | { definitions: CredentialDefinition[] }
  | { status: "unsupported"; code: "scope" };
export type PlatformClawCredentialRuntime = {
  credentialMetadata(params: {
    agentId: string;
    sessionKey: string;
  }): Promise<PlatformClawCredentialMetadata>;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const EXCLUDED_SESSION =
  /^(?:subagent|acp|cron|hook|node|space|space-session)(?::|$)|:(?:group|channel|dm):/iu;

export function parseCredentialMetadata(value: unknown): PlatformClawCredentialMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.status === "unsupported" && record.code === "scope") {
    return { status: "unsupported", code: "scope" };
  }
  if (!Array.isArray(record.definitions) || record.definitions.length > 32) {
    throw new Error("credential metadata is invalid");
  }
  const definitions = record.definitions.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("credential metadata is invalid");
    }
    const definition = entry as Record<string, unknown>;
    if (
      typeof definition.envName !== "string" ||
      !ENV_NAME.test(definition.envName) ||
      typeof definition.configured !== "boolean"
    ) {
      throw new Error("credential metadata is invalid");
    }
    return { envName: definition.envName, configured: definition.configured };
  });
  return { definitions };
}

function unavailableResult() {
  return textResult(
    "Credential status is unavailable. Do not assume a key is missing; try again later.",
    {
      status: "unavailable",
      code: "metadata-unavailable",
    },
  );
}

function unsupportedResult(code: "scope" | "not-allowed") {
  return textResult(
    code === "scope"
      ? "Credential registration is available only in your ordinary personal conversation."
      : "This exact key name is not available for registration. Check the integration instructions and allowed names; do not guess or ask for a secret in chat.",
    { status: "unsupported", code },
  );
}

function listResult(definitions: CredentialDefinition[]) {
  const selected: CredentialDefinition[] = [];
  const message =
    definitions.length === 0
      ? "No personal execution keys are allowed by the administrator. Registration cannot start until an administrator allows the intended key. Do not invent key names, navigation paths, or OAuth connections. Never ask for secret values in chat."
      : "Offer these allowed names and ask which key to add or replace. Registration itself is enough; do not require another task or service. Use status to check a selected name, or request to open its secure add/replacement form even if saved. Stored does not mean authenticated.";
  const build = (truncated: boolean) => {
    const outcome = { status: "available", definitions: selected, truncated };
    return textResult(JSON.stringify({ ...outcome, message }), outcome);
  };
  for (const definition of definitions.toSorted((a, b) =>
    a.envName < b.envName ? -1 : a.envName > b.envName ? 1 : 0,
  )) {
    selected.push(definition);
    if (Buffer.byteLength(JSON.stringify(build(true)), "utf8") > 1024) {
      selected.pop();
      break;
    }
  }
  return build(selected.length < definitions.length);
}

function createPlatformClawCredentialTool(
  context: OpenClawPluginToolContext,
  runtime: () => Promise<PlatformClawCredentialRuntime>,
) {
  const { agentId, sessionKey, sessionId, runId } = context;
  const parsed = sessionKey ? parseAgentSessionKey(sessionKey) : null;
  if (
    !agentId ||
    !sessionKey ||
    !sessionId ||
    !runId ||
    !parsed ||
    parsed.agentId !== agentId ||
    EXCLUDED_SESSION.test(parsed.rest)
  ) {
    return null;
  }
  // A duplicate delivery of one tool call must keep the same registration request id.
  const requestIds = new Map<string, string>();
  return {
    name: PLATFORMCLAW_CREDENTIAL_TOOL_NAME,
    label: "Personal credentials",
    description:
      "Use first for any PlatformClaw credential registration, replacement, or saved-state question. Supports administrator-allowed personal execution environment keys, not model-provider, MCP, or OAuth credentials. Registration is itself a complete task; never require another service, task, or destination first. Without an exact name, list allowed names and ask which key to add or replace. Use status to check an exact key without opening a form. Use request to open secure registration or replacement for a selected key, even if already saved. For a task requiring a key, check status and request it if missing. Never invent names, navigation paths, OAuth flows, or connection support. Never inspect shell/environment, memory, or session history to manage or check these keys. Never read, accept, or print secret values. After request, relay the returned instructions and end this turn. Saving completes registration; no further confirmation message is needed. Saving never sends a message or automatically resumes a task. Request one key at a time. Saved does not mean authenticated.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "status", "request"] },
        envName: {
          type: "string",
          maxLength: 128,
          description:
            "Exact allowed environment variable name; required for status or request, omitted for list. Never a secret value.",
        },
      },
      required: ["action"],
      additionalProperties: false,
    } as never,
    async execute(toolCallId: string, input: unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return unsupportedResult("not-allowed");
      }
      const args = input as Record<string, unknown>;
      if (
        Object.keys(args).some((key) => key !== "action" && key !== "envName") ||
        (args.action !== "list" && args.action !== "status" && args.action !== "request") ||
        (args.action === "list" && args.envName !== undefined) ||
        (args.action !== "list" &&
          (typeof args.envName !== "string" || !ENV_NAME.test(args.envName)))
      ) {
        return unsupportedResult("not-allowed");
      }
      let metadata: PlatformClawCredentialMetadata;
      try {
        metadata = parseCredentialMetadata(
          await (await runtime()).credentialMetadata({ agentId, sessionKey }),
        );
      } catch {
        return unavailableResult();
      }
      if ("status" in metadata) {
        return unsupportedResult("scope");
      }
      if (args.action === "list") {
        return listResult(metadata.definitions);
      }
      const definition = metadata.definitions.find((entry) => entry.envName === args.envName);
      if (!definition) {
        return unsupportedResult("not-allowed");
      }
      if (args.action === "status") {
        return textResult(
          definition.configured
            ? `${definition.envName} is saved. This does not verify service access or permissions. Use request if the user wants to replace it.`
            : `${definition.envName} is not saved. Use request to open secure registration when the user wants to add it or the current task needs it. Never paste a key in chat.`,
          {
            status: definition.configured ? "configured" : "missing",
            envName: definition.envName,
          },
        );
      }
      if (!toolCallId || (!requestIds.has(toolCallId) && requestIds.size >= 32)) {
        return unavailableResult();
      }
      const requestId = requestIds.get(toolCallId) ?? randomUUID();
      requestIds.set(toolCallId, requestId);
      return textResult(
        `${definition.envName} ${definition.configured ? "is already saved; the secure form replaces its value" : "is not saved; the secure form adds its value"}. Use the secure registration button to save ${definition.envName}. If no button appears, sign in to PlatformClaw on a PC, open Settings > Credentials, and save ${definition.envName}. Saving completes registration or replacement; no further confirmation message is needed. Saving never sends a chat message or automatically restarts a task. To continue another task, return to the conversation and send an ordinary message when ready. Never paste a key in chat. Relay these steps to the user, then end this turn.`,
        {
          status: "required",
          envName: definition.envName,
          configured: definition.configured,
          uiAction: {
            version: 1,
            kind: "settings",
            feature: "platformclaw.exec-credentials",
            requestId,
            targetKey: definition.envName,
          },
        },
      );
    },
  };
}

export function registerPlatformClawCredentialTool(
  api: Pick<OpenClawPluginApi, "registrationMode" | "registerTool">,
  runtime?: () => Promise<PlatformClawCredentialRuntime>,
): void {
  if (
    api.registrationMode === "full" ||
    api.registrationMode === "discovery" ||
    api.registrationMode === "tool-discovery"
  ) {
    // Prepared agent registries execute discovery factories too. Resolve the
    // credential client only on a call so discovery stays free of runtime I/O.
    api.registerTool(
      (context) => (runtime ? createPlatformClawCredentialTool(context, runtime) : null),
      { name: PLATFORMCLAW_CREDENTIAL_TOOL_NAME },
    );
  }
}
