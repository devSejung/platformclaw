import { resolveGlobalSingleton } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveQmdManagerRuntimeConfig, type QmdManagerCreateParams } from "./qmd-manager-base.js";
import { QmdManagerIo } from "./qmd-manager-io.js";

export { resolveQmdMcporterSearchProcessTimeoutMs } from "./qmd-command-client.js";

const LIVE_QMD_MANAGERS = resolveGlobalSingleton<Map<QmdMemoryManager, string>>(
  Symbol.for("openclaw.liveQmdManagers"),
  () => new Map(),
);

export async function closeQmdMemoryManagersForAgent(agentId: string): Promise<void> {
  for (const [manager, ownerAgentId] of LIVE_QMD_MANAGERS) {
    if (ownerAgentId === agentId) {
      await manager.close();
    }
  }
}

export class QmdMemoryManager extends QmdManagerIo implements MemorySearchManager {
  override async close(): Promise<void> {
    await super.close();
    LIVE_QMD_MANAGERS.delete(this);
  }

  static async create(params: QmdManagerCreateParams): Promise<QmdMemoryManager | null> {
    const resolved = params.resolved.qmd;
    if (!resolved) {
      return null;
    }
    const runtimeConfig =
      params.runtimeConfig ?? resolveQmdManagerRuntimeConfig(params.cfg, params.agentId);
    const manager = new QmdMemoryManager({
      agentId: params.agentId,
      resolved,
      runtimeConfig,
      withLease: params.withLease,
    });
    LIVE_QMD_MANAGERS.set(manager, params.agentId);
    try {
      await manager.initialize(params.mode ?? "full");
    } catch (error) {
      await manager.close();
      throw error;
    }
    return manager;
  }
}
