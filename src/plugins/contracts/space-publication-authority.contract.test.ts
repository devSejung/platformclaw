import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneAuthorizationError } from "../../../packages/platformclaw-control-plane/src/contracts.js";
import { PlatformClawExecutionHandoffServer } from "../../../packages/platformclaw-control-plane/src/execution-handoff-http.js";
import { createSpaceTestFixture } from "../../../packages/platformclaw-control-plane/src/spaces.test-fixtures.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { prepareOwnedPluginLoadContext } from "../../agents/prepared-model-runtime.plugin-context.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import type {
  GatewayRequestContext,
  GatewayRequestOptions,
} from "../../gateway/server-methods/types.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { findBundledPluginMetadataById } from "../bundled-plugin-metadata.js";
import type { OpenClawPluginDefinition } from "../plugin-definition.types.js";
import * as metadataSource from "../plugin-metadata-snapshot.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../public-surface-loader.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";

function loadSpacePluginContract() {
  const metadata = findBundledPluginMetadataById("platformclaw-org-memory", {
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  });
  if (!metadata) {
    throw new Error("Missing bundled Space plugin metadata");
  }
  const loaded = loadBundledPluginPublicArtifactModuleSync<{ default: OpenClawPluginDefinition }>({
    dirName: metadata.dirName,
    artifactBasename: metadata.source.built,
  });
  const register = loaded.default.register;
  if (!register) {
    throw new Error("Bundled Space plugin has no registration entry");
  }
  return { spaceManifest: metadata.manifest, register };
}

const servers: PlatformClawExecutionHandoffServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  setActivePluginRegistry(createEmptyPluginRegistry());
  resetAgentEventsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function assembledFixture(
  options: { started?: boolean; scopes?: string[]; cancelAtVerifier?: boolean } = {},
) {
  const { spaceManifest, register } = loadSpacePluginContract();
  const f = await createSpaceTestFixture();
  const workspaceDir = dirname(f.databasePath);
  f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", f.space.revision);
  const conversation = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
    pageId: f.page.id,
    title: "Synthetic assembled publication",
    requestId: "assembled-conversation",
  });
  const controller = new AbortController();
  const runId = `synthetic-runtime-${randomUUID()}`;
  const admissionRunId = `synthetic-ingress-${randomUUID()}`;
  registerAgentRunContext(runId, {
    agentId: f.alice.binding.agentId,
    sessionKey: conversation.sessionKey,
    admissionRunId,
  });
  if (options.started !== false) {
    emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt: Date.now() } });
  }

  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir }, list: [{ id: f.alice.binding.agentId }] },
    plugins: {
      enabled: true,
      // Preserve the prepared config identity when Vitest disables unrelated memory owners.
      slots: { memory: "none" },
      allow: ["platformclaw-org-memory"],
      entries: { "platformclaw-org-memory": { enabled: true } },
    },
  };
  const registry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
  });
  const record = createPluginRecord({
    id: spaceManifest.id,
    origin: "bundled",
    contracts: spaceManifest.contracts,
  });
  registry.registry.plugins.push(record);
  const api = registry.createApi(record, { config });
  const broker =
    process.platform === "win32"
      ? String.raw`\\.\pipe\space-assembled-${randomUUID()}`
      : join(workspaceDir, "broker.sock");
  const socketPath =
    process.platform === "win32" ? `${broker}-execution` : join(workspaceDir, "execution.sock");
  const token = "review-synthetic-credential-2";
  const tokenFile = join(workspaceDir, "service-token");
  writeFileSync(tokenFile, token);
  vi.stubEnv("PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS", broker);
  vi.stubEnv("PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_FILE", tokenFile);
  register(api);
  expect(
    registry.registry.diagnostics.filter((diagnostic) => diagnostic.level === "error"),
  ).toEqual([]);
  setActivePluginRegistry(registry.registry);

  // Registry/catalog and authenticated service connection are synthetic fixtures.
  // Tool assembly, SDK sealing, RPC scope checks/proof verification, HTTP and DB are real owners.
  const metadata = createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: makeRegistry([
      {
        id: record.id,
        origin: "bundled",
        channels: [],
        contracts: spaceManifest.contracts,
      },
    ]),
  });
  vi.spyOn(metadataSource, "resolvePluginMetadataSnapshot").mockReturnValue(metadata);
  prepareOwnedPluginLoadContext(
    { config, workspaceDir, agentDir: workspaceDir },
    process.env,
    registry.registry,
  );
  const prepared = {
    config,
    workspaceDir,
    agentDir: workspaceDir,
    activeProjectKeys: [],
    metadataSnapshot: metadata,
    pluginRegistry: registry.registry,
    allowGatewaySubagentBinding: false,
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      throw new Error("Publishing must not create model stores");
    },
  } as unknown as PreparedModelRuntimeSnapshot;
  const toolset = createOpenClawCodingTools({
    config,
    workspaceDir,
    agentDir: workspaceDir,
    agentId: f.alice.binding.agentId,
    sessionKey: conversation.sessionKey,
    runId,
    abortSignal: controller.signal,
    includeCoreTools: false,
    preparedModelRuntime: prepared,
    runtimeToolAllowlist: ["space_qa_append", "space_note_update"],
  });
  const qa = toolset.find((tool) => tool.name === "space_qa_append")!;
  const notes = toolset.find((tool) => tool.name === "space_note_update")!;
  expect(
    qa,
    JSON.stringify({
      tools: toolset.map((tool) => tool.name),
      diagnostics: registry.registry.diagnostics,
    }),
  ).toBeDefined();
  expect(notes).toBeDefined();
  const scopes = options.scopes ?? ["operator.admin"];
  f.request.mockImplementation(async (method, params) => {
    if (method !== "platformclaw.spaces.run.authorize") {
      throw new Error(`Unexpected execution/model/session request: ${method}`);
    }
    if (options.cancelAtVerifier) {
      controller.abort();
    }
    let responded = false;
    let payload: unknown;
    let failure: string | undefined;
    await handleGatewayRequest({
      req: { type: "req", id: randomUUID(), method, params },
      client: {
        connId: `synthetic-service-${runId}`,
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "cli", version: "synthetic", platform: "synthetic", mode: "backend" },
          role: "operator",
          scopes,
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
      context: { logGateway: { warn: vi.fn() } } as unknown as GatewayRequestContext,
      respond(ok, value, error) {
        responded = true;
        payload = value;
        if (!ok) {
          failure = error?.message ?? "Proof rejected";
        }
      },
    });
    if (!responded || failure) {
      throw new Error(failure ?? "Proof response unavailable");
    }
    return payload;
  });
  const mutation = vi.spyOn(f.service, "agentMutation");
  const server = new PlatformClawExecutionHandoffServer(
    token,
    {
      spaceService: f.service,
      resolveTarget: vi.fn(),
      resolveConnectionTarget: vi.fn(),
      changeTarget: vi.fn(),
      issueCredentialGrant: vi.fn(),
    },
    socketPath,
  );
  servers.push(server);
  await server.listen();
  return { ...f, qa, notes, mutation, conversation, runId, admissionRunId };
}

const request = {
  expectedRevision: 1,
  requestId: "assembled-post",
  body: "Synthetic cross-boundary Q&A",
};
describe("assembled shared Space publication authority", () => {
  it("loads the declared bundled entry and manifest through the public plugin boundary", () => {
    const { spaceManifest, register } = loadSpacePluginContract();
    expect(spaceManifest.id).toBe("platformclaw-org-memory");
    expect(spaceManifest.contracts).toMatchObject({
      tools: expect.arrayContaining(["space_qa_append", "space_note_update"]),
    });
    expect(register).toBeTypeOf("function");
  });

  it("derives the host actor through proof verification, real HTTP and SQLite, then replays and reads as another member", async () => {
    const f = await assembledFixture();
    const saved = await f.qa.execute("call-one", request);
    const receipt = saved.details as {
      postId: string;
      revision: number;
      receiptId: string;
      link: string;
    };
    expect(saved).not.toHaveProperty("isError", true);
    expect(receipt).toMatchObject({
      revision: 2,
      receiptId: expect.any(String),
      link: expect.stringContaining("tab=qa&post="),
    });
    expect((await f.qa.execute("call-retry", request)).details).toEqual(receipt);
    expect(f.mutation.mock.calls[0]![0]).toMatchObject({
      proofId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      payload: { operation: "qa.append", ...request },
    });
    expect(f.mutation.mock.calls[0]![0]).not.toHaveProperty("agentId");
    expect(
      f.store.spaces.content.getQa(f.bob.user.id, f.space.id, f.page.id, receipt.postId),
    ).toMatchObject({
      authorId: f.alice.user.id,
      agentId: f.alice.binding.agentId,
      body: request.body,
    });
    expect(
      await f.proxy.request(f.bob.token, "platformclaw.spaces.qa.list", {
        spaceId: f.space.id,
        pageId: f.page.id,
      }),
    ).toMatchObject({ posts: [{ id: receipt.postId, authorId: f.alice.user.id }] });
    const note = await f.notes.execute("call-note", {
      operation: "append",
      text: "\nSynthetic shared note",
      requestId: "assembled-note",
      expectedRevision: f.page.revision,
    });
    expect(note.details).toMatchObject({
      operation: "note.append",
      revision: 2,
      link: expect.stringContaining("tab=notes"),
    });
    expect(f.store.spaces.page(f.bob.user.id, f.space.id, f.page.id).body).toBe(
      f.page.body + "\nSynthetic shared note",
    );
    const audits = (await f.store.listAuditEvents(500)).filter(
      (event) => event.eventType === "space.content.mutated",
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorUserId: f.alice.user.id,
      details: {
        agentId: f.alice.binding.agentId,
        sessionKey: f.conversation.sessionKey,
        runtimeRunId: f.runId,
        admissionRunId: f.admissionRunId,
      },
    });
    expect(
      f.request.mock.calls.every(([method]) => method === "platformclaw.spaces.run.authorize"),
    ).toBe(true);
  });

  it("rejects an assembled tool before runtime start without reaching HTTP", async () => {
    const f = await assembledFixture({ started: false });
    expect(await f.qa.execute("not-started", request)).toMatchObject({
      isError: true,
      details: { code: "space-forbidden" },
    });
    expect(f.mutation).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.store.spaces.content.qaRevision(f.alice.user.id, f.space.id, f.page.id)).toBe(1);
  });

  it("enforces the privileged verifier RPC scope on the real dispatch path", async () => {
    const f = await assembledFixture({ scopes: ["operator.read"] });
    expect(await f.qa.execute("wrong-scope", request)).toMatchObject({
      isError: true,
      details: { code: "space-forbidden" },
    });
    expect(f.mutation).toHaveBeenCalledTimes(1);
    expect(f.store.spaces.content.listQa(f.alice.user.id, f.space.id, f.page.id).posts).toEqual([]);
  });

  it("rejects cancellation between HTTP arrival and actual proof verification", async () => {
    const f = await assembledFixture({ cancelAtVerifier: true });
    await expect(f.qa.execute("canceled", request)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.mutation).toHaveBeenCalledTimes(1);
    // The host settles cancellation immediately; await the real server decision
    // too so a detached request cannot mutate after the caller has aborted.
    await expect(f.mutation.mock.results[0]!.value).rejects.toBeInstanceOf(
      ControlPlaneAuthorizationError,
    );
    expect(f.store.spaces.content.qaRevision(f.alice.user.id, f.space.id, f.page.id)).toBe(1);
    expect(f.store.spaces.content.listQa(f.alice.user.id, f.space.id, f.page.id).posts).toEqual([]);
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id).body).toBe(f.page.body);
    const receiptReadback = new DatabaseSync(f.databasePath, { readOnly: true });
    try {
      expect(
        receiptReadback
          .prepare("SELECT count(*) AS count FROM collaboration_space_mutation_receipts")
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      receiptReadback.close();
    }
    expect(
      (await f.store.listAuditEvents(500)).filter(
        (event) => event.eventType === "space.content.mutated",
      ),
    ).toEqual([]);
  });
});
