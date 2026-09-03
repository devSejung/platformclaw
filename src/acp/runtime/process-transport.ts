/** Process-wide ACP stdio transport registry contributed by execution plugins. */
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

export const ACP_EXECUTION_OWNER_ENV = "OPENCLAW_ACP_EXECUTION_OWNER_AGENT_ID";
export const ACP_AGENT_ENV = "OPENCLAW_ACP_AGENT_ID";
export const ACP_SESSION_KEY_ENV = "OPENCLAW_ACP_SESSION_KEY";

export type AcpProcessTransportLaunch = {
  executionOwnerAgentId: string;
  agent: string;
  sessionKey: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type AcpProcessTransportProvider = {
  id: string;
  isolatesSandboxedRequesters: boolean;
  supports(input: Pick<AcpProcessTransportLaunch, "executionOwnerAgentId" | "agent">): boolean;
  prepare(
    input: Pick<AcpProcessTransportLaunch, "executionOwnerAgentId" | "agent" | "sessionKey">,
  ): Promise<{ cwd: string }>;
  launch(
    input: AcpProcessTransportLaunch,
  ): Promise<ChildProcessByStdio<Writable, Readable, Readable>>;
  release?(input: { executionOwnerAgentId: string; sessionKey: string }): Promise<void> | void;
};

type RegistryState = {
  providers: Map<string, AcpProcessTransportProvider>;
  preparedProviders: Map<string, AcpProcessTransportProvider>;
};
const STATE_KEY = Symbol.for("openclaw.acpProcessTransportRegistryState");
function resolveRegistryState(): RegistryState {
  const processStore = process as NodeJS.Process & Record<PropertyKey, unknown>;
  const existing = processStore[STATE_KEY];
  if (existing) {
    (globalThis as Record<PropertyKey, unknown>)[STATE_KEY] = existing;
  }
  const state = resolveGlobalSingleton<RegistryState>(
    STATE_KEY,
    () => ({ providers: new Map(), preparedProviders: new Map() }),
    (value) => {
      value.providers.clear();
      value.preparedProviders.clear();
    },
    "plugin-registry",
  );
  processStore[STATE_KEY] = state;
  return state;
}

const STATE = resolveRegistryState();

export function registerAcpProcessTransport(provider: AcpProcessTransportProvider): () => void {
  const id = provider.id.trim().toLowerCase();
  if (!id) {
    throw new Error("ACP process transport id is required");
  }
  const registered = { ...provider, id };
  STATE.providers.set(id, registered);
  return () => {
    if (STATE.providers.get(id) === registered) {
      STATE.providers.delete(id);
      for (const [key, prepared] of STATE.preparedProviders) {
        if (prepared === registered) {
          STATE.preparedProviders.delete(key);
        }
      }
    }
  };
}

export function hasIsolatedAcpProcessTransport(): boolean {
  return [...STATE.providers.values()].some((provider) => provider.isolatesSandboxedRequesters);
}

function findProvider(input: {
  executionOwnerAgentId: string;
  agent: string;
}): AcpProcessTransportProvider | undefined {
  return [...STATE.providers.values()].find((candidate) => candidate.supports(input));
}

export function canUseAcpProcessTransport(input: {
  executionOwnerAgentId: string;
  agent: string;
}): boolean {
  return findProvider(input) !== undefined;
}

function preparedKey(executionOwnerAgentId: string, sessionKey: string): string {
  return `${executionOwnerAgentId.trim().toLowerCase()}\0${sessionKey.trim()}`;
}

export async function prepareAcpProcessTransport(input: {
  executionOwnerAgentId: string;
  agent: string;
  sessionKey: string;
}): Promise<{ cwd: string }> {
  const provider = findProvider(input);
  if (!provider) {
    throw new Error(
      `No isolated ACP process transport is available for execution owner ${input.executionOwnerAgentId}.`,
    );
  }
  const prepared = await provider.prepare(input);
  STATE.preparedProviders.set(preparedKey(input.executionOwnerAgentId, input.sessionKey), provider);
  return prepared;
}

export async function releaseAcpProcessTransport(input: {
  executionOwnerAgentId: string;
  sessionKey: string;
}): Promise<void> {
  const key = preparedKey(input.executionOwnerAgentId, input.sessionKey);
  const provider = STATE.preparedProviders.get(key);
  STATE.preparedProviders.delete(key);
  await provider?.release?.(input);
}

export async function launchWithAcpProcessTransport(input: {
  agentCommand: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ChildProcessByStdio<Writable, Readable, Readable> | undefined> {
  const executionOwnerAgentId = input.env[ACP_EXECUTION_OWNER_ENV]?.trim();
  if (!executionOwnerAgentId) {
    return undefined;
  }
  const agent = input.env[ACP_AGENT_ENV]?.trim() || input.agentCommand.trim();
  const sessionKey = input.env[ACP_SESSION_KEY_ENV]?.trim();
  if (!sessionKey) {
    throw new Error("Isolated ACP process transport is missing its session key.");
  }
  const provider = STATE.preparedProviders.get(preparedKey(executionOwnerAgentId, sessionKey));
  if (!provider) {
    throw new Error(
      `No isolated ACP process transport is available for execution owner ${executionOwnerAgentId}.`,
    );
  }
  if (
    STATE.providers.get(provider.id) !== provider ||
    !provider.supports({ executionOwnerAgentId, agent })
  ) {
    STATE.preparedProviders.delete(preparedKey(executionOwnerAgentId, sessionKey));
    throw new Error("The prepared isolated ACP process transport changed; close and retry.");
  }
  const env = { ...input.env };
  delete env[ACP_EXECUTION_OWNER_ENV];
  delete env[ACP_AGENT_ENV];
  delete env[ACP_SESSION_KEY_ENV];
  return await provider.launch({
    executionOwnerAgentId,
    agent,
    sessionKey,
    command: input.command,
    args: [...input.args],
    cwd: input.cwd,
    env,
  });
}

export const testing = {
  resetAcpProcessTransportsForTests() {
    STATE.providers.clear();
    STATE.preparedProviders.clear();
  },
};
