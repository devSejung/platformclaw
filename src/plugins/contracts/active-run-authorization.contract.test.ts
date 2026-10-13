import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { wrapToolWithGatewayCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { markPluginRegistryRetired } from "../registry-lifecycle.js";
import { createPluginRegistry } from "../registry.js";
import { setActivePluginRegistry } from "../runtime.js";
import { withPluginRuntimeRegistryScope } from "../runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../runtime/types.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

const context = {
  runId: "run",
  agentId: "personal-alice",
  sessionKey: "agent:personal-alice:space-session:issue",
};

function fixture(discovery = false) {
  const registry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: !discovery,
  });
  const record = createPluginRecord({
    id: "active-authorization-fixture",
    name: "Authorization fixture",
  });
  registry.registry.plugins.push(record);
  const api = registry.createApi(record, { config: {} });
  registerAgentRunContext(context.runId, { ...context, admissionRunId: "ingress" });
  emitAgentEvent({
    runId: context.runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt: 1 },
  });
  return { registry, api, record };
}

async function duringTool(run: () => void) {
  const tool: AnyAgentTool = {
    name: "authorization-probe",
    label: "Authorization probe",
    description: "Host seam contract",
    parameters: Type.Object({}),
    async execute() {
      run();
      return { content: [], details: {} };
    },
  };
  await wrapToolWithGatewayCallerIdentity(tool, {
    ...context,
    abortSignal: new AbortController().signal,
  }).execute!("call", {});
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  resetAgentEventsForTest();
});

describe("plugin active-run authorization facade", () => {
  it("requires an actual tool, preserves the admission reader and retires sealed authority", async () => {
    const { registry, api } = fixture();
    setActivePluginRegistry(registry.registry);
    expect(api.runContext.resolveActiveAuthorization(context)).toBeUndefined();
    expect(api.runContext.resolveAdmissionId({ runId: "unregistered" })).toBe("unregistered");
    let sealed: ReturnType<OpenClawPluginApi["runContext"]["resolveActiveAuthorization"]>;
    await duringTool(() => {
      sealed = api.runContext.resolveActiveAuthorization(context);
      expect(sealed?.admissionRunId).toBe("ingress");
      expect(sealed?.isActive()).toBe(true);
      setActivePluginRegistry(createEmptyPluginRegistry());
      expect(sealed?.isActive()).toBe(false);
      expect(api.runContext.resolveActiveAuthorization(context)).toBeUndefined();
    });
    expect(sealed?.isActive()).toBe(false);
  });

  it("permits only the loaded discovery registry's invocation and verifies outside its async scope", async () => {
    const { registry, api, record } = fixture(true);
    let sealed: ReturnType<OpenClawPluginApi["runContext"]["resolveActiveAuthorization"]>;
    await duringTool(() => {
      expect(api.runContext.resolveActiveAuthorization(context)).toBeUndefined();
      withPluginRuntimeRegistryScope(registry.registry, () => {
        sealed = api.runContext.resolveActiveAuthorization(context);
      });
      expect(sealed?.isActive()).toBe(true);
      record.enabled = false;
      expect(sealed?.isActive()).toBe(false);
    });
    expect(sealed?.isActive()).toBe(false);
  });

  it.each(["disabled", "removed", "rollback", "retired"] as const)(
    "rejects a %s discovery API and its previously sealed owner",
    async (reason) => {
      const { registry, api, record } = fixture(true);
      await duringTool(() => {
        const authorize = () =>
          withPluginRuntimeRegistryScope(registry.registry, () =>
            api.runContext.resolveActiveAuthorization(context),
          );
        const sealed = authorize()!;
        expect(sealed.isActive()).toBe(true);
        if (reason === "disabled") {
          record.enabled = false;
        } else if (reason === "removed") {
          registry.registry.plugins.splice(registry.registry.plugins.indexOf(record), 1);
        } else if (reason === "rollback") {
          registry.rollbackPluginGlobalSideEffects(record.id, record);
        } else {
          markPluginRegistryRetired(registry.registry);
        }
        expect(sealed.isActive()).toBe(false);
        expect(authorize()).toBeUndefined();
      });
    },
  );
});
