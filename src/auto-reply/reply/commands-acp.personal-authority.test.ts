import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../acp/control-plane/manager.js";
import { registerAcpProcessTransport } from "../../acp/runtime/process-transport.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  testing as backendTesting,
} from "../../acp/runtime/registry.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  callInProcessGatewayTool,
  hasInProcessGatewayToolContext,
} from "../../agents/tools/in-process-gateway.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../../gateway/local-request-context.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import type { MsgContext } from "../templating.js";
import { handleAcpCommand } from "./commands-acp.js";
import { handleConfigCommand } from "./commands-config.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const gatewayCall = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: (request: unknown) => gatewayCall(request),
}));

let root: string;
let cfg: OpenClawConfig;
let configPath: string;
let unregisterTransport: () => void;
const owner = "person_one";
const parentKey = `agent:${owner}:main`;
const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(async (input) => ({
  sessionKey: input.sessionKey,
  backend: "personal-test",
  runtimeSessionName: input.sessionKey,
  agentSessionId: `native:${input.sessionKey}`,
}));
const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
  yield { type: "text_delta", text: "OWNED_ACP_RESULT" };
  yield { type: "done", stopReason: "end_turn" };
});
const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {});
const close = vi.fn<AcpRuntime["close"]>(async () => {});
const getStatus = vi.fn<NonNullable<AcpRuntime["getStatus"]>>(async () => ({ summary: "ready" }));
const setMode = vi.fn<NonNullable<AcpRuntime["setMode"]>>(async () => {});
const setConfigOption = vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>(async () => {});
const hostDoctor = vi.fn<NonNullable<AcpRuntime["doctor"]>>(async () => ({
  ok: true,
  message: "host probe",
}));
const diagnose = vi.fn(async (_input: { executionOwnerAgentId: string; agent: string }) => ({
  ok: true,
  stage: "ready" as const,
  code: "ready",
  message: "Assigned prerequisites are ready.",
}));
const runtime: AcpRuntime = {
  ensureSession,
  runTurn,
  cancel,
  close,
  getStatus,
  setMode,
  setConfigOption,
  getCapabilities: async () => ({
    controls: ["session/status", "session/set_mode", "session/set_config_option"],
    configOptionKeys: ["model", "approval_policy", "timeout"],
  }),
  doctor: hostDoctor,
};

function registerBackend(isolated = true) {
  registerAcpRuntimeBackend({
    id: "personal-test",
    runtime,
    isolatesSandboxedRequesters: () => isolated,
  });
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acp-personal-authority-")));
  configPath = path.join(root, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  cfg = {
    commands: { text: true, config: true, ownerAllowFrom: ["first.user"] },
    acp: {
      enabled: true,
      backend: "personal-test",
      defaultAgent: "codex",
      allowedAgents: ["codex"],
      dispatch: { enabled: true },
    },
    agents: {
      entries: {
        [owner]: { default: true, workspace: path.join(root, "workspace") },
        codex: { workspace: path.join(root, "codex") },
      },
    },
    session: { store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json") },
    plugins: { enabled: false },
  };
  await fs.mkdir(path.join(root, "workspace"));
  await fs.mkdir(path.join(root, "codex"));
  await fs.writeFile(configPath, JSON.stringify(cfg));
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  managerTesting.resetAcpSessionManagerForTests();
  backendTesting.resetAcpRuntimeBackendsForTests();
  resetTaskRegistryForTests({ persist: false });
  vi.clearAllMocks();
  registerBackend();
  unregisterTransport = registerAcpProcessTransport({
    id: "personal-test",
    isolatesSandboxedRequesters: true,
    supports: (input) => input.executionOwnerAgentId === owner && input.agent === "codex",
    prepare: async () => ({ cwd: path.join(root, "workspace") }),
    diagnose,
    launch: async () => {
      throw new Error("external test backend must not launch a process");
    },
  });
  await replaceSessionEntry(
    {
      agentId: owner,
      sessionKey: parentKey,
      storePath: resolveStorePath(cfg.session?.store, { agentId: owner }),
    },
    { sessionId: "personal-parent", updatedAt: Date.now() },
  );
  gatewayCall.mockImplementation(
    async (request: { method: string; params?: Record<string, unknown> }) => {
      if (!hasInProcessGatewayToolContext()) {
        throw new Error("test requires its task-owned in-process Gateway scope");
      }
      return await callInProcessGatewayTool(request.method, request.params ?? {});
    },
  );
});

afterEach(async () => {
  unregisterTransport();
  managerTesting.resetAcpSessionManagerForTests();
  backendTesting.resetAcpRuntimeBackendsForTests();
  resetTaskRegistryForTests({ persist: false });
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function commandParams(text: string, overrides: Partial<MsgContext> = {}) {
  const params = buildCommandTestParams(
    text,
    cfg,
    {
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      OriginatingTo: "webchat:personal",
      AgentId: owner,
      SenderId: "first.user",
      SenderIsOwner: false,
      SenderAgentId: owner,
      GatewayClientScopes: [],
      GatewayClientCaps: [],
      ...overrides,
    },
    { workspaceDir: path.join(root, "workspace") },
  );
  params.agentId = owner;
  params.sessionKey = parentKey;
  params.storePath = resolveStorePath(cfg.session?.store, { agentId: owner });
  return params;
}

async function command(text: string, overrides: Partial<MsgContext> = {}) {
  const params = commandParams(text, overrides);
  const result = await withLocalGatewayRequestScope(
    { deps: createDefaultDeps(), getRuntimeConfig: () => cfg },
    async () => await handleAcpCommand(params, true),
  );
  return { params, result };
}

async function spawn() {
  const { params, result } = await command("/acp spawn codex");
  expect(params.command).toMatchObject({ isAuthorizedSender: true, senderIsOwner: false });
  expect(params.ctx.GatewayClientScopes).toEqual([]);
  const key = result?.reply?.text?.match(/Spawned ACP session (agent:[^ ]+)/)?.[1];
  if (!key) {
    throw new Error(`expected owned ACP spawn: ${result?.reply?.text ?? "missing result"}`);
  }
  expect(readAcpSessionMeta({ cfg, sessionKey: key })).toMatchObject({
    executionOwnerAgentId: owner,
    agent: "codex",
  });
  return key;
}

async function seedSession(key: string, executionOwnerAgentId?: string) {
  await getAcpSessionManager().initializeSession({
    cfg,
    sessionKey: key,
    agent: "codex",
    executionOwnerAgentId,
    mode: "persistent",
  });
  if (!executionOwnerAgentId) {
    await updateSessionEntry(
      { sessionKey: key, storePath: resolveStorePath(cfg.session?.store, { agentId: "codex" }) },
      () => ({ spawnedBy: parentKey, parentSessionKey: parentKey }),
    );
  }
}

describe("personal ACP command authority at the actual handler", () => {
  it("spawns and controls its isolated runtime with no global owner or admin authority", async () => {
    const key = await spawn();
    expect(ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({ executionOwnerAgentId: owner, agent: "codex" }),
    );
    expect((await command(`/acp status ${key}`)).result?.reply?.text).toContain("ACP status:");
    expect(
      (await command(`/acp steer --session ${key} inspect the task`)).result?.reply?.text,
    ).toContain("OWNED_ACP_RESULT");
    expect((await command(`/acp cancel ${key}`)).result?.reply?.text).toContain("Cancel requested");
    expect(getStatus).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ sessionKey: key }) }),
    );
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: expect.objectContaining({ sessionKey: key }),
        text: "inspect the task",
      }),
    );
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ sessionKey: key }) }),
    );
    expect((await command(`/acp close ${key}`)).result?.reply?.text).toContain(
      "Closed ACP session",
    );
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ handle: expect.objectContaining({ sessionKey: key }) }),
    );
    expect(readAcpSessionMeta({ cfg, sessionKey: key })).toBeUndefined();
  });

  it.each([
    "set-mode plan",
    "set model test-model",
    "cwd /workspace/project",
    "permissions ask",
    "timeout 60",
    "model test-model",
    "reset-options",
  ])("keeps %s within the owned runtime session", async (action) => {
    const key = await spawn();
    const { params, result } = await command(`/acp ${action} ${key}`);
    expect(result?.reply?.text).toMatch(/Updated ACP|Reset ACP/);
    expect(params.command.senderIsOwner).toBe(false);
    expect(readAcpSessionMeta({ cfg, sessionKey: key })?.executionOwnerAgentId).toBe(owner);
    for (const [input] of [...setMode.mock.calls, ...setConfigOption.mock.calls]) {
      expect(input.handle.sessionKey).toBe(key);
    }
  });

  it.each(["status", "cancel", "close", "set-mode plan", "permissions ask", "model test-model"])(
    "denies %s for foreign and lineage-only host sessions",
    async (action) => {
      for (const [suffix, executionOwnerAgentId] of [
        ["foreign", "other_person"],
        ["legacy-host", undefined],
      ] as const) {
        const key = `agent:codex:acp:${suffix}`;
        await seedSession(key, executionOwnerAgentId);
        vi.clearAllMocks();
        const { result } = await command(`/acp ${action} ${key}`);
        expect(result?.reply?.text).toContain("Unable to resolve session target");
        expect(getStatus).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(setMode).not.toHaveBeenCalled();
        expect(setConfigOption).not.toHaveBeenCalled();
      }
    },
  );

  it("lists only explicit personal execution owners", async () => {
    const ownKey = await spawn();
    await seedSession("agent:codex:acp:foreign", "other_person");
    await seedSession("agent:codex:acp:legacy-host");
    const { result } = await command("/acp sessions");
    expect(result?.reply?.text).toContain(ownKey);
    expect(result?.reply?.text).not.toContain("agent:codex:acp:foreign");
    expect(result?.reply?.text).not.toContain("agent:codex:acp:legacy-host");
  });

  it.each(["--bind here", "--thread here", "--thread auto"])(
    "rejects channel binding %s before initializing the runtime",
    async (flags) => {
      const { result } = await command(`/acp spawn codex ${flags}`);
      expect(result?.reply?.text).toContain("cannot change channel bindings");
      expect(ensureSession).not.toHaveBeenCalled();
    },
  );

  it("defaults a personal spawn to unbound even with inherited external channel routing", async () => {
    const { result } = await command("/acp spawn codex", {
      OriginatingChannel: "discord",
      OriginatingTo: "channel:inherited",
    });
    expect(result?.reply?.text).toContain("Spawned ACP session");
    expect(result?.reply?.text).toContain("Session is unbound");
  });

  it.each(["missing-transport", "host-backend"])(
    "never falls back to Gateway-host execution for %s",
    async (reason) => {
      if (reason === "missing-transport") {
        unregisterTransport();
      } else {
        registerBackend(false);
      }
      const { result } = await command("/acp spawn codex");
      expect(result?.reply?.text).toContain("require an available isolated execution target");
      expect(ensureSession).not.toHaveBeenCalled();
    },
  );

  it("retains owned close metadata retirement when its backend is unavailable", async () => {
    const key = await spawn();
    managerTesting.resetAcpSessionManagerForTests();
    unregisterAcpRuntimeBackend("personal-test");
    const { result } = await command(`/acp close ${key}`);
    expect(result?.reply?.text).toContain("Closed ACP session");
    expect(readAcpSessionMeta({ cfg, sessionKey: key })).toBeUndefined();
  });

  it("runs only the assigned-target doctor and keeps installation as public hints", async () => {
    const { result } = await command("/acp doctor codex");
    expect(result?.reply?.text).toContain("transportStage: ready");
    expect(result?.reply?.text).not.toContain("activeRuntimeSessions");
    expect(result?.reply?.text).not.toContain("activeTurns");
    expect(diagnose).toHaveBeenCalledExactlyOnceWith({
      executionOwnerAgentId: owner,
      agent: "codex",
    });
    expect(hostDoctor).not.toHaveBeenCalled();
    const original = await fs.readFile(configPath, "utf8");
    expect((await command("/acp install")).result?.reply?.text).toContain("ACP install:");
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(ensureSession).not.toHaveBeenCalled();
  });

  it("returns a scoped limitation instead of running a host doctor", async () => {
    registerBackend(false);
    expect((await command("/acp doctor codex")).result?.reply?.text).toContain(
      "isolated execution target",
    );
    expect(hostDoctor).not.toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it("requires admin at the actual host doctor effect while preserving a Gateway owner's path", async () => {
    registerBackend(false);
    const legacy = {
      SenderAgentId: undefined,
      SenderIsOwner: undefined,
      GatewayClientScopes: ["operator.write"],
    };
    expect((await command("/acp doctor", legacy)).result?.reply?.text).toContain("operator.admin");
    expect(hostDoctor).not.toHaveBeenCalled();
    expect(
      (await command("/acp doctor", { ...legacy, GatewayClientScopes: ["operator.admin"] })).result
        ?.reply?.text,
    ).toContain("runtimeDoctor: ok");
    expect(hostDoctor).toHaveBeenCalledOnce();
  });

  it.each([{ SenderAgentId: "other_person" }, { SenderAgentId: undefined }])(
    "does not turn invalid personal authority into a global diagnostic",
    async (overrides) => {
      await command("/acp doctor codex", overrides);
      expect(hostDoctor).not.toHaveBeenCalled();
      expect(diagnose).not.toHaveBeenCalled();
    },
  );

  it("does not grant Gateway config mutation through ordinary personal command authorization", async () => {
    const original = await fs.readFile(configPath, "utf8");
    const params = commandParams('/config set messages.ackReaction "changed"');
    expect(params.command).toMatchObject({ isAuthorizedSender: true, senderIsOwner: false });
    const result = await handleConfigCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    expect(
      loadSessionEntry({ agentId: owner, sessionKey: parentKey, storePath: params.storePath })
        ?.sessionId,
    ).toBe("personal-parent");
  });
});
