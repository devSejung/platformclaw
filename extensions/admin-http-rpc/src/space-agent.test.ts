import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { ensureSpaceAgent } from "./space-agent.js";
describe("Space agent provisioning", () => {
  it("creates a credential-free restricted entry without copying personal defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-agent-"));
    try {
      const draft = {
        agents: {
          defaults: { workspace: join(root, "main"), skills: ["private-skill"] },
          list: [{ id: "employee", workspace: join(root, "employee"), tools: { allow: ["exec"] } }],
        },
      };
      const mutateConfigFile = vi.fn(async ({ mutate }: { mutate: (draft: unknown) => void }) =>
        mutate(draft),
      );
      const respond = vi.fn();
      await ensureSpaceAgent(
        {
          params: { agentId: "space-12345678-1234-1234-1234-123456789abc" },
          respond,
          context: { getRuntimeConfig: () => draft },
        } as unknown as GatewayRequestHandlerOptions,
        { runtime: { config: { mutateConfigFile } } } as unknown as OpenClawPluginApi,
      );
      expect(draft.agents.list[0]).toMatchObject({ id: "employee", tools: { allow: ["exec"] } });
      expect(draft.agents.list[1]).toMatchObject({
        contextInjection: "never",
        skills: [],
        memory: { search: { enabled: false } },
        tools: {
          allow: ["space_search", "space_get"],
          codeMode: false,
          elevated: { enabled: false },
        },
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        { agentId: "space-12345678-1234-1234-1234-123456789abc", ready: true },
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses to relabel a personal agent as a Space agent", async () => {
    const mutateConfigFile = vi.fn();
    const respond = vi.fn();
    await ensureSpaceAgent(
      { params: { agentId: "person-alice" }, respond } as unknown as GatewayRequestHandlerOptions,
      { runtime: { config: { mutateConfigFile } } } as unknown as OpenClawPluginApi,
    );
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  });
});
