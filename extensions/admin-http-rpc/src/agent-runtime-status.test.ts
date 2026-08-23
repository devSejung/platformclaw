import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleAgentConfigStatus } from "./agent-runtime-status.js";

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
});
