import type { AgentBinding, PlatformUser } from "./contracts.js";
import type { VmAdministrationAgent } from "./execution-contracts.js";

export function listActivePersonalAgents(
  bindings: Iterable<AgentBinding>,
  users: ReadonlyMap<string, PlatformUser>,
): VmAdministrationAgent[] {
  return [...bindings].flatMap((binding) => {
    if (binding.kind !== "personal" || binding.state !== "active") {
      return [];
    }
    const user = users.get(binding.userId);
    if (!user || user.status !== "active") {
      return [];
    }
    return [
      {
        userId: user.id,
        accountId: user.accountId,
        agentId: binding.agentId,
        ...(user.displayName ? { displayName: user.displayName } : {}),
        ...(user.department ? { department: user.department } : {}),
      },
    ];
  });
}
