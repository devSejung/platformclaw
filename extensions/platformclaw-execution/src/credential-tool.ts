import { randomUUID } from "node:crypto";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { textResult } from "openclaw/plugin-sdk/tool-results";

export const PLATFORMCLAW_CREDENTIAL_TOOL_NAME = "platformclaw_credentials";

type CredentialDefinition = { envName: string; configured: boolean };
export type PlatformClawCredentialMetadata =
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
    "Use an exact known name, or view Credentials for the full list. Stored does not mean authenticated.";
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

export function createPlatformClawCredentialTool(
  context: OpenClawPluginToolContext,
  runtime: Promise<PlatformClawCredentialRuntime>,
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
  // A duplicate delivery of one tool call must keep the same continuation id.
  const requestIds = new Map<string, string>();
  return {
    name: PLATFORMCLAW_CREDENTIAL_TOOL_NAME,
    label: "Personal credentials",
    description:
      "List allowed personal execution key names or check an exact key required by the current task and request the secure registration UI. Never read, accept, or print secret values. Determine the exact name from the task or integration instructions; ask if ambiguous. When required, explain the service and task, tell the user to use the registration button, end this turn, and wait for explicit Continue. Request one key at a time. Saved keys are not proof of service authentication.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "request"] },
        envName: {
          type: "string",
          maxLength: 128,
          description:
            "Exact allowed environment variable name; required for request, omitted for list. Never a secret value.",
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
        (args.action !== "list" && args.action !== "request") ||
        (args.action === "list" && args.envName !== undefined) ||
        (args.action === "request" &&
          (typeof args.envName !== "string" || !ENV_NAME.test(args.envName)))
      ) {
        return unsupportedResult("not-allowed");
      }
      let metadata: PlatformClawCredentialMetadata;
      try {
        metadata = parseCredentialMetadata(
          await (await runtime).credentialMetadata({ agentId, sessionKey }),
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
      if (definition.configured) {
        return textResult(
          `${definition.envName} is saved. This does not verify service access or permissions.`,
          {
            status: "configured",
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
        `${definition.envName} is not saved. Explain why the task needs it, ask the user to use the secure registration button (never paste a key in chat), then end this turn. Wait for the user's explicit Continue; no tool has been suspended or resumed.`,
        {
          status: "required",
          envName: definition.envName,
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
  runtime?: Promise<PlatformClawCredentialRuntime>,
): void {
  if (api.registrationMode === "tool-discovery") {
    api.registerTool(() => null, { name: PLATFORMCLAW_CREDENTIAL_TOOL_NAME });
  } else if (api.registrationMode === "full") {
    api.registerTool(
      (context) => (runtime ? createPlatformClawCredentialTool(context, runtime) : null),
      { name: PLATFORMCLAW_CREDENTIAL_TOOL_NAME },
    );
  }
}
