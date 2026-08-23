import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleAgentConfigStatus, handleAgentRuntimeStatus } from "./agent-runtime-status.js";

describe("PlatformClaw agent runtime status", () => {
  const agentId = "account_name";
  const workspace = path.resolve("agent-workspaces/account_name");

  it("reports configured ownership without loading model-provider metadata", () => {
    const respond = vi.fn();
    const loadGatewayModelCatalogSnapshot = vi.fn();

    handleAgentConfigStatus({
      params: { agentId, workspace },
      respond,
      context: {
        getRuntimeConfig: () => ({ agents: { list: [{ id: agentId, workspace }] } }),
        loadGatewayModelCatalogSnapshot,
      } as never,
    } as never);

    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, configured: true, agentId, workspace, matches: true },
      undefined,
    );
  });

  it("distinguishes a missing agent from a workspace mismatch", () => {
    const missingRespond = vi.fn();
    handleAgentConfigStatus({
      params: { agentId, workspace },
      respond: missingRespond,
      context: { getRuntimeConfig: () => ({ agents: { list: [] } }) } as never,
    } as never);
    expect(missingRespond).toHaveBeenCalledWith(
      true,
      { ok: true, configured: false, agentId },
      undefined,
    );

    const actualWorkspace = path.resolve("agent-workspaces/other");
    const mismatchRespond = vi.fn();
    handleAgentConfigStatus({
      params: { agentId, workspace },
      respond: mismatchRespond,
      context: {
        getRuntimeConfig: () => ({
          agents: { list: [{ id: agentId, workspace: actualWorkspace }] },
        }),
      } as never,
    } as never);
    expect(mismatchRespond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        configured: true,
        agentId,
        workspace: actualWorkspace,
        matches: false,
      },
      undefined,
    );
  });

  function callStatus(
    options: {
      workspace?: string;
      loadError?: Error;
      snapshot?: { agentId: string; workspaceDir: string };
    } = {},
  ) {
    const configuredWorkspace = options.workspace ?? workspace;
    const respond = vi.fn();
    const loadError = options.loadError;
    const loadGatewayModelCatalogSnapshot = loadError
      ? vi.fn(async () => {
          throw loadError;
        })
      : vi.fn(async () => options.snapshot ?? { agentId, workspaceDir: configuredWorkspace });
    return {
      respond,
      loadGatewayModelCatalogSnapshot,
      promise: handleAgentRuntimeStatus({
        params: { agentId, workspace },
        respond,
        context: {
          getRuntimeConfig: () => ({
            agents: { list: [{ id: agentId, workspace: configuredWorkspace }] },
          }),
          loadGatewayModelCatalogSnapshot,
        } as never,
      } as never),
    };
  }

  it("reports ready only after the exact prepared runtime owner is published", async () => {
    const result = callStatus();
    await result.promise;

    expect(result.loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId,
      workspaceDir: workspace,
      readOnly: false,
    });
    expect(result.respond).toHaveBeenCalledWith(
      true,
      { ok: true, ready: true, agentId, workspace },
      undefined,
    );
  });

  it("reports unavailable while the prepared runtime owner is still replacing", async () => {
    const result = callStatus({ loadError: new Error("owner replacement pending") });
    await result.promise;

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: `agent runtime is not ready: ${agentId}`,
      }),
    );
  });

  it("reports unavailable when the loaded snapshot still belongs to the previous owner", async () => {
    const result = callStatus({
      snapshot: { agentId: "previous_owner", workspaceDir: workspace },
    });
    await result.promise;

    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: `agent runtime is not ready: ${agentId}`,
      }),
    );
  });

  it("rejects a workspace that is not assigned to the agent", async () => {
    const result = callStatus({ workspace: path.resolve("agent-workspaces/other") });
    await result.promise;

    expect(result.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(result.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
